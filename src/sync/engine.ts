import { utf8, strict_text } from "../bytes.js";
import { SyncError } from "../errors.js";
import { RemoteError, type FetchedNote, type RemoteNote, type VaultClient } from "./api.js";
import {
  delete_local,
  read_if,
  rename_local,
  scan_folder,
  write_atomic_file,
  type Skipped,
  type Storage,
} from "./files.js";
import { ignore_fingerprint, is_ignored, parse_ignore, type IgnoreOptions } from "./ignore.js";
import { merge_text } from "./merge.js";
import { check_path, conflict_path, path_key } from "./paths.js";
import {
  counted_deletes,
  mass_delete_blocked,
  plan_sync,
  type Action,
  type LocalRef,
  type RemoteEntry,
} from "./plan.js";
import {
  empty_state,
  parse_state,
  type BaseEntry,
  type DeviceSettings,
  type StateStore,
  type SyncState,
} from "./state.js";

export const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const QUIET_MS = 2_000;

export interface SyncOptions {
  storage: Storage;
  root: string;
  api: VaultClient;
  state: StateStore;
  device: string;
  dry_run?: boolean;
  allow_deletes?: boolean;
  settings?: Partial<DeviceSettings>;
  quiet_ms?: number;
  max_cycles?: number;
  now?: () => Date;
  on_event?: (event: SyncEvent) => void;
}

export type SyncEvent =
  | { kind: "pulled" | "pushed" | "merged" | "deleted_local" | "deleted_remote" | "restored"; path: string }
  | { kind: "moved"; from: string; to: string }
  | { kind: "conflict"; path: string; copy: string }
  | { kind: "skipped"; path: string; reason: string }
  | { kind: "notice"; message: string };

export interface SyncReport {
  vault_id: string;
  dry_run: boolean;
  full: boolean;
  cycles: number;
  pulled: string[];
  pushed: string[];
  merged: string[];
  conflicts: { path: string; copy: string }[];
  moved: { from: string; to: string }[];
  deleted_local: string[];
  deleted_remote: string[];
  skipped: Skipped[];
  notices: string[];
  waiting: string[];
  blocked: { code: string; message: string } | null;
  planned: Action[];
}

class GroupFailed extends Error {
  constructor(readonly retry: boolean) {
    super("group failed");
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decode(content: Uint8Array): string | null {
  return strict_text(content);
}

function is_stop(error: unknown): boolean {
  return error instanceof RemoteError && (error.status === 401 || error.status === 403);
}

function is_storage_block(error: unknown): boolean {
  return (
    error instanceof RemoteError &&
    (error.status === 402 || (error.status === 413 && error.code !== "file_too_large"))
  );
}

export function group_of(action: Action): string {
  switch (action.kind) {
    case "delete_local":
    case "forget":
      return `key:${action.key}`;
    case "rename_local":
      return `local:${path_key(action.from)}`;
    case "move_remote":
    case "pull":
    case "delete_remote":
      return `note:${action.note_id}`;
    case "push":
      return action.note_id === null ? `local:${path_key(action.local.disk)}` : `note:${action.note_id}`;
    case "merge":
      return `note:${action.base.note_id}`;
    case "keep_both":
    case "adopt":
      return `note:${action.remote.note_id}`;
  }
}

function linked_groups(actions: Action[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (group: string): string => {
    let current = group;
    while (parent.has(current) && parent.get(current) !== current) current = parent.get(current)!;
    return current;
  };
  const join_groups = (left: string, right: string) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(b, a);
    if (!parent.has(a)) parent.set(a, a);
  };
  const key_owner = new Map<string, string>();
  for (const action of actions) {
    const group = group_of(action);
    if (!parent.has(group)) parent.set(group, group);
    const keys: string[] = [];
    if (action.kind === "rename_local") keys.push(path_key(action.from), path_key(action.to));
    if (action.kind === "forget" || action.kind === "delete_local") keys.push(action.key);
    if (action.kind === "push" || action.kind === "merge") keys.push(path_key(action.local.disk), path_key(action.local.path));
    if (action.kind === "pull") keys.push(path_key(action.path));
    if (action.kind === "keep_both") keys.push(path_key(action.remote.path), path_key(action.copy_path));
    if (action.kind === "adopt") keys.push(path_key(action.remote.path));
    if (action.kind === "move_remote") keys.push(path_key(action.from), path_key(action.to));
    for (const key of keys) {
      const owner = key_owner.get(key);
      if (owner === undefined) key_owner.set(key, group);
      else join_groups(owner, group);
    }
  }
  const resolved = new Map<string, string>();
  for (const group of parent.keys()) resolved.set(group, find(group));
  return resolved;
}

async function load_ignore(
  storage: Storage,
  settings: DeviceSettings,
): Promise<{ options: IgnoreOptions; fingerprint: string }> {
  const bytes = await storage.read(".nemuignore").catch(() => null);
  const source = bytes === null ? "" : (strict_text(bytes) ?? "");
  const options = {
    obsidian: settings.obsidian,
    obsidian_plugins: settings.obsidian_plugins,
    rules: parse_ignore(source),
  };
  return { options, fingerprint: ignore_fingerprint(options, source) };
}

interface RemoteView {
  entries: Map<string, RemoteEntry>;
  revision: number;
  full: boolean;
}

function entry_of(note: RemoteNote): RemoteEntry {
  return { path: note.path.normalize("NFC"), note_id: note.id, version: note.version, hash: note.hash };
}

async function full_view(api: VaultClient): Promise<RemoteView> {
  const listing = await api.notes();
  const entries = new Map<string, RemoteEntry>();
  for (const note of listing.notes) {
    if (note.deleted) continue;
    entries.set(path_key(note.path), entry_of(note));
  }
  return { entries, revision: listing.revision, full: true };
}

async function remote_view(api: VaultClient, state: SyncState): Promise<RemoteView> {
  if (state.cursor === null || state.full_next) return full_view(api);
  const changed: RemoteNote[] = [];
  let since = state.cursor;
  try {
    for (let page = 0; page < 10_000; page += 1) {
      const result = await api.changes(since);
      changed.push(...result.notes);
      since = result.revision;
      if (!result.has_more) break;
    }
  } catch (error) {
    if (error instanceof RemoteError && error.status === 410) return full_view(api);
    throw error;
  }
  const entries = new Map<string, RemoteEntry>();
  const key_of_id = new Map<string, string>();
  for (const base of Object.values(state.files)) {
    const key = path_key(base.path);
    entries.set(key, { path: base.path, note_id: base.note_id, version: base.version, hash: base.hash });
    key_of_id.set(base.note_id, key);
  }
  changed.sort((left, right) => left.revision - right.revision);
  for (const note of changed) {
    const previous = key_of_id.get(note.id);
    if (previous !== undefined && entries.get(previous)?.note_id === note.id) {
      entries.delete(previous);
      key_of_id.delete(note.id);
    }
    if (note.deleted) continue;
    const key = path_key(note.path);
    const displaced = entries.get(key);
    if (displaced !== undefined) key_of_id.delete(displaced.note_id);
    entries.set(key, entry_of(note));
    key_of_id.set(note.id, key);
  }
  return { entries, revision: since, full: false };
}

export function new_report(vault_id: string, dry_run: boolean): SyncReport {
  return {
    vault_id,
    dry_run,
    full: false,
    cycles: 0,
    pulled: [],
    pushed: [],
    merged: [],
    conflicts: [],
    moved: [],
    deleted_local: [],
    deleted_remote: [],
    skipped: [],
    notices: [],
    waiting: [],
    blocked: null,
    planned: [],
  };
}

export async function run_sync(options: SyncOptions): Promise<SyncReport> {
  return sync_locked(options);
}

async function sync_locked(options: SyncOptions): Promise<SyncReport> {
  const hasher = (content: Uint8Array) => options.api.hash(content);
  const dry_run = options.dry_run === true;
  const report = new_report(options.api.vault_id, dry_run);
  const emit = (event: SyncEvent) => options.on_event?.(event);
  const quiet_ms = options.quiet_ms ?? QUIET_MS;
  const now = options.now ?? (() => new Date());

  const stored = parse_state(await options.state.read());
  const state: SyncState =
    stored !== null && stored.vault_id === options.api.vault_id
      ? stored
      : empty_state(options.api.vault_id, options.root, options.settings);
  state.root = options.root;
  if (options.settings?.conflicts !== undefined) state.settings.conflicts = options.settings.conflicts;
  if (options.settings?.obsidian !== undefined) state.settings.obsidian = options.settings.obsidian;
  if (options.settings?.obsidian_plugins !== undefined) {
    state.settings.obsidian_plugins = options.settings.obsidian_plugins;
  }

  const ignore = await load_ignore(options.storage, state.settings);
  if (ignore.fingerprint !== state.ignore_fingerprint) state.full_next = true;
  state.ignore_fingerprint = ignore.fingerprint;

  const save = async () => {
    if (!dry_run) await options.state.write(state);
  };

  let info;
  try {
    info = await options.api.info();
  } catch (error) {
    if (is_stop(error)) throw stopped(error);
    throw error;
  }
  if (info.limits !== undefined) state.limits = info.limits;
  const max_file_bytes = state.limits?.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES;

  const max_cycles = options.max_cycles ?? 4;
  for (let cycle = 1; cycle <= max_cycles; cycle += 1) {
    report.cycles = cycle;
    let view: RemoteView;
    try {
      view = await remote_view(options.api, state);
    } catch (error) {
      if (is_stop(error)) throw stopped(error);
      throw error;
    }
    report.full = report.full || view.full;

    const remote = new Map<string, RemoteEntry>();
    for (const [key, entry] of view.entries) {
      if (is_ignored(entry.path, ignore.options)) continue;
      if (!check_path(entry.path).ok) continue;
      remote.set(key, entry);
    }
    const scan_started = Date.now();
    const base = new Map<string, BaseEntry>();
    for (const entry of Object.values(state.files)) {
      if (is_ignored(entry.path, ignore.options)) continue;
      base.set(path_key(entry.path), entry);
    }
    const scan = await scan_folder(options.storage, ignore.options, max_file_bytes, (key) => base.get(key)?.path, hasher);
    if (cycle === 1) {
      report.skipped.push(...scan.skipped);
      for (const skipped of scan.skipped) emit({ kind: "skipped", ...skipped });
    }
    const skipped_keys = new Set(scan.skipped.map((entry) => path_key(entry.path)));
    const plan = plan_sync({
      base,
      local: scan.files,
      remote,
      skipped: skipped_keys,
      conflicts: state.settings.conflicts,
      device: options.device,
      now: now(),
    });
    for (const notice of plan.notices) {
      if (!report.notices.includes(notice)) {
        report.notices.push(notice);
        emit({ kind: "notice", message: notice });
      }
    }

    const deletes = counted_deletes(plan);
    if (!options.allow_deletes && mass_delete_blocked(deletes, base.size)) {
      throw new SyncError(
        `This sync would delete ${deletes} of the ${base.size} files in the vault, so it stopped and deleted nothing. If you really deleted them, choose Sync and allow deletes in the Nemu Sync settings.`,
        "mass_delete",
      );
    }

    if (dry_run) {
      report.planned = plan.actions;
      return report;
    }

    const taken = new Set<string>([...base.keys(), ...scan.files.keys(), ...remote.keys(), ...skipped_keys]);
    for (const action of plan.actions) {
      if (action.kind === "keep_both") taken.add(path_key(action.copy_path));
      if (action.kind === "rename_local") taken.add(path_key(action.to));
    }
    const known = new Map<string, number>();
    for (const entry of remote.values()) known.set(entry.note_id, entry.version);
    const groups = linked_groups(plan.actions);
    const failed = new Set<string>();
    let retry = false;
    let stale = plan.deferred;
    let checkpoint = 0;

    const record = (note: { path: string; note_id: string; version: number; hash: string }) => {
      known.set(note.note_id, note.version);
      for (const [key, existing] of Object.entries(state.files)) {
        if (existing.note_id === note.note_id && key !== path_key(note.path)) delete state.files[key];
      }
      state.files[path_key(note.path)] = {
        path: note.path.normalize("NFC"),
        note_id: note.note_id,
        version: note.version,
        hash: note.hash,
      };
    };
    const record_note = (note: RemoteNote) =>
      record({ path: note.path, note_id: note.id, version: note.version, hash: note.hash });

    const stable = async (local: LocalRef): Promise<Uint8Array> => {
      const ready_at = scan_started + quiet_ms;
      if (Date.now() < ready_at) await wait(ready_at - Date.now());
      const content = await read_if(options.storage, local.disk, local.hash, hasher);
      if (content === null) {
        if (!report.waiting.includes(local.path)) report.waiting.push(local.path);
        throw new GroupFailed(true);
      }
      return content;
    };

    const log_merge = async (
      path: string,
      merged_version: number,
      remote_version: number,
      local: Uint8Array,
    ): Promise<void> => {
      if (merged_version <= remote_version) return;
      try {
        await options.api.record_merge({ path, merged_version, remote_version, local });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const message = `${path} was merged, but the merge log did not record it: ${reason}`;
        report.notices.push(message);
        emit({ kind: "notice", message });
      }
    };

    const push_content = async (
      path: string,
      content: Uint8Array,
      note_id: string | null,
    ): Promise<RemoteNote | null> => {
      if (report.blocked !== null) throw new GroupFailed(false);
      const version = note_id === null ? null : (known.get(note_id) ?? null);
      try {
        return await options.api.write(path, content, version);
      } catch (error) {
        if (error instanceof RemoteError && error.status === 409) {
          const current = error.current;
          if (current !== null && current !== undefined && !current.deleted && current.hash === hasher(content)) {
            record_note(current);
            return current;
          }
          throw new GroupFailed(true);
        }
        if (is_storage_block(error)) {
          const failure = error as RemoteError;
          report.blocked = { code: failure.code, message: failure.message };
          emit({ kind: "notice", message: `Uploads stopped: ${failure.message} Downloads continue.` });
          throw new GroupFailed(false);
        }
        if (
          error instanceof RemoteError &&
          (error.code === "file_too_large" || error.status === 400 || error.status === 422)
        ) {
          report.skipped.push({ path, reason: error.message });
          emit({ kind: "skipped", path, reason: error.message });
          throw new GroupFailed(false);
        }
        throw error;
      }
    };

    const fetch_remote = async (path: string, note_id: string) => {
      try {
        const fetched = await options.api.read(path);
        if (fetched.id !== note_id || hasher(fetched.content) !== fetched.hash) {
          stale = true;
          throw new GroupFailed(true);
        }
        return fetched;
      } catch (error) {
        if (error instanceof RemoteError && error.status === 404) {
          stale = true;
          throw new GroupFailed(true);
        }
        throw error;
      }
    };

    const keep_both = async (
      remote_entry: RemoteEntry,
      local: LocalRef,
      copy_path: string,
      local_content: Uint8Array,
      remote_content?: FetchedNote,
    ) => {
      if (!(await write_atomic_file(options.storage, copy_path, local_content, null, hasher))) throw new GroupFailed(true);
      const fetched = remote_content ?? (await fetch_remote(remote_entry.path, remote_entry.note_id));
      if (
        !(await write_atomic_file(
          options.storage,
          remote_entry.path,
          fetched.content,
          { disk: local.disk, hash: local.hash },
          hasher,
        ))
      ) {
        throw new GroupFailed(true);
      }
      record({ path: remote_entry.path, note_id: fetched.id, version: fetched.version, hash: fetched.hash });
      report.conflicts.push({ path: remote_entry.path, copy: copy_path });
      emit({ kind: "conflict", path: remote_entry.path, copy: copy_path });
      const pushed = await push_content(copy_path, local_content, null).catch((error: unknown) => {
        if (error instanceof GroupFailed) return null;
        throw error;
      });
      if (pushed !== null) record_note(pushed);
    };

    const execute = async (action: Action): Promise<void> => {
      switch (action.kind) {
        case "delete_local": {
          if (!(await delete_local(options.storage, action.disk, action.hash, hasher))) throw new GroupFailed(true);
          report.deleted_local.push(action.disk);
          emit({ kind: "deleted_local", path: action.disk });
          return;
        }
        case "rename_local": {
          if (!(await rename_local(options.storage, action.from, action.to))) throw new GroupFailed(true);
          if (action.reason !== "conflict") {
            report.moved.push({ from: action.from, to: action.to });
            emit({ kind: "moved", from: action.from, to: action.to });
          }
          return;
        }
        case "forget": {
          delete state.files[action.key];
          return;
        }
        case "move_remote": {
          if (report.blocked !== null) throw new GroupFailed(false);
          const version = known.get(action.note_id);
          if (version === undefined) throw new GroupFailed(true);
          try {
            const note = await options.api.move(action.from, action.to, version);
            delete state.files[path_key(action.from)];
            record_note(note);
            report.moved.push({ from: action.from, to: action.to });
            emit({ kind: "moved", from: action.from, to: action.to });
          } catch (error) {
            if (error instanceof RemoteError && (error.status === 409 || error.status === 404)) {
              stale = true;
              throw new GroupFailed(true);
            }
            if (is_storage_block(error)) {
              report.blocked = { code: (error as RemoteError).code, message: (error as RemoteError).message };
              throw new GroupFailed(false);
            }
            throw error;
          }
          return;
        }
        case "pull": {
          const fetched = await fetch_remote(action.path, action.note_id);
          const written = await write_atomic_file(
            options.storage,
            action.path,
            fetched.content,
            action.replace === null ? null : { disk: action.replace.disk, hash: action.replace.hash },
            hasher,
          );
          if (!written) throw new GroupFailed(true);
          record({ path: action.path, note_id: fetched.id, version: fetched.version, hash: fetched.hash });
          report.pulled.push(action.path);
          emit({ kind: "pulled", path: action.path });
          return;
        }
        case "adopt": {
          record({
            path: action.remote.path,
            note_id: action.remote.note_id,
            version: known.get(action.remote.note_id) ?? action.remote.version,
            hash: action.remote.hash,
          });
          return;
        }
        case "push": {
          const content = await stable(action.local);
          const note = await push_content(action.local.path, content, action.note_id);
          if (note === null) return;
          record_note(note);
          if (action.reason === "restore") {
            report.pushed.push(action.local.path);
            emit({ kind: "restored", path: action.local.path });
            return;
          }
          if (action.reason === "conflict") return;
          report.pushed.push(action.local.path);
          emit({ kind: "pushed", path: action.local.path });
          return;
        }
        case "merge": {
          const local_content = await stable(action.local);
          const fetched = await fetch_remote(action.remote.path, action.remote.note_id);
          let base_content: Uint8Array | null = null;
          try {
            base_content = await options.api.read_version(action.base.note_id, action.base.version);
          } catch (error) {
            if (!(error instanceof RemoteError) || error.status !== 404) throw error;
          }
          const texts = [base_content, local_content, fetched.content].map((value) =>
            value === null ? null : decode(value),
          );
          const merged =
            base_content !== null && hasher(base_content) === action.base.hash && texts.every((text) => text !== null)
              ? merge_text(texts[0]!, texts[1]!, texts[2]!)
              : ({ kind: "conflict" } as const);
          if (merged.kind === "conflict") {
            const copy_path = conflict_path(action.remote.path, options.device, now(), (key) => taken.has(key));
            taken.add(path_key(copy_path));
            await keep_both(action.remote, action.local, copy_path, local_content, fetched);
            return;
          }
          const bytes = utf8(merged.text);
          if (
            !(await write_atomic_file(
              options.storage,
              action.remote.path,
              bytes,
              { disk: action.local.disk, hash: action.local.hash },
              hasher,
            ))
          ) {
            throw new GroupFailed(true);
          }
          known.set(fetched.id, fetched.version);
          if (hasher(bytes) === fetched.hash) {
            record({ path: action.remote.path, note_id: fetched.id, version: fetched.version, hash: fetched.hash });
          } else {
            const note = await push_content(action.remote.path, bytes, fetched.id);
            if (note !== null) {
              record_note(note);
              await log_merge(action.remote.path, note.version, fetched.version, local_content);
            }
          }
          report.merged.push(action.remote.path);
          emit({ kind: "merged", path: action.remote.path });
          return;
        }
        case "keep_both": {
          const local_content = await stable(action.local);
          await keep_both(action.remote, action.local, action.copy_path, local_content);
          return;
        }
        case "delete_remote": {
          if (report.blocked !== null) throw new GroupFailed(false);
          const version = known.get(action.note_id);
          if (version === undefined) throw new GroupFailed(true);
          try {
            await options.api.remove(action.path, version);
          } catch (error) {
            if (error instanceof RemoteError && error.status === 404) {
              delete state.files[path_key(action.path)];
              return;
            }
            if (error instanceof RemoteError && error.status === 409) {
              stale = true;
              throw new GroupFailed(true);
            }
            throw error;
          }
          delete state.files[path_key(action.path)];
          if (action.counted) {
            report.deleted_remote.push(action.path);
            emit({ kind: "deleted_remote", path: action.path });
          }
          return;
        }
      }
    };

    try {
      for (const action of plan.actions) {
        const group = groups.get(group_of(action)) ?? group_of(action);
        if (failed.has(group)) continue;
        try {
          await execute(action);
        } catch (error) {
          if (error instanceof GroupFailed) {
            failed.add(group);
            stale = true;
            if (error.retry) retry = true;
            continue;
          }
          if (is_stop(error)) throw stopped(error);
          throw error;
        }
        checkpoint += 1;
        if (checkpoint % 50 === 0) await save();
      }
    } catch (error) {
      state.full_next = true;
      if (error instanceof SyncError) await save();
      throw error;
    }

    state.cursor = view.revision;
    state.full_next = stale;
    state.synced_at = now().toISOString();
    await save();
    if (!retry) break;
  }
  return report;
}

function stopped(error: unknown): SyncError {
  const failure = error as RemoteError;
  const reason =
    failure.code === "device_revoked"
      ? "this device was revoked"
      : failure.status === 401
        ? "the sign in is no longer valid"
        : "access to this vault was refused";
  return new SyncError(
    `Sync stopped because ${reason}. Nothing was deleted on this device. Sign in again in the Nemu Sync settings.`,
    "sync_stopped",
    failure.status,
  );
}
