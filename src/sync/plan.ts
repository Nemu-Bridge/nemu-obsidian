import type { BaseEntry } from "./state.js";
import type { LocalEntry } from "./files.js";
import { conflict_path, is_markdown, numbered_path, path_key } from "./paths.js";

export interface RemoteEntry {
  path: string;
  note_id: string;
  version: number;
  hash: string;
}

export interface LocalRef {
  path: string;
  disk: string;
  hash: string;
}

export type Action =
  | { kind: "delete_local"; key: string; disk: string; hash: string }
  | { kind: "rename_local"; from: string; to: string; hash: string; reason: "remote_move" | "collision" | "conflict" }
  | { kind: "forget"; key: string }
  | { kind: "move_remote"; note_id: string; from: string; to: string }
  | { kind: "pull"; note_id: string; path: string; hash: string; replace: LocalRef | null }
  | { kind: "push"; note_id: string | null; local: LocalRef; reason: "edit" | "new" | "restore" | "conflict" | "renamed" }
  | { kind: "merge"; base: BaseEntry; remote: RemoteEntry; local: LocalRef }
  | { kind: "keep_both"; remote: RemoteEntry; local: LocalRef; copy_path: string }
  | { kind: "adopt"; remote: RemoteEntry }
  | { kind: "delete_remote"; note_id: string; path: string; counted: boolean };

export interface PlanInput {
  base: Map<string, BaseEntry>;
  local: Map<string, LocalEntry>;
  remote: Map<string, RemoteEntry>;
  skipped: Set<string>;
  conflicts: "merge" | "file";
  device: string;
  now: Date;
}

export interface Plan {
  actions: Action[];
  notices: string[];
  deferred: boolean;
}

const PHASES: Record<Action["kind"], number> = {
  delete_local: 0,
  rename_local: 1,
  forget: 2,
  move_remote: 3,
  pull: 4,
  adopt: 4,
  merge: 4,
  keep_both: 4,
  push: 5,
  delete_remote: 6,
};

function order_renames(renames: Extract<Action, { kind: "rename_local" }>[]): Action[] {
  const pending = [...renames];
  const ordered: Action[] = [];
  while (pending.length > 0) {
    const sources = new Set(pending.map((rename) => path_key(rename.from)));
    const ready = pending.findIndex(
      (rename) => !sources.has(path_key(rename.to)) || path_key(rename.to) === path_key(rename.from),
    );
    const index = ready === -1 ? 0 : ready;
    ordered.push(pending.splice(index, 1)[0]!);
  }
  return ordered;
}

function sort_actions(actions: Action[]): Action[] {
  const renames = actions.filter(
    (action): action is Extract<Action, { kind: "rename_local" }> => action.kind === "rename_local",
  );
  const others = actions.filter((action) => action.kind !== "rename_local");
  const ordered_renames = order_renames(renames);
  return [...others, ...ordered_renames]
    .map((action, index) => ({ action, index }))
    .sort((left, right) => PHASES[left.action.kind] - PHASES[right.action.kind] || left.index - right.index)
    .map(({ action }) => action);
}

export function plan_sync(input: PlanInput): Plan {
  const { base, local, remote } = input;
  const actions: Action[] = [];
  const notices: string[] = [];
  let deferred = false;
  const reserved = new Set<string>([...base.keys(), ...local.keys(), ...remote.keys(), ...input.skipped]);
  const taken = (key: string) => reserved.has(key);
  const claim = (path: string) => {
    reserved.add(path_key(path));
    return path;
  };

  const remote_by_id = new Map<string, RemoteEntry>();
  for (const entry of remote.values()) remote_by_id.set(entry.note_id, entry);

  const associated = new Map<string, LocalEntry>();
  const used = new Set<string>();
  const missing: [string, BaseEntry][] = [];
  for (const [key, entry] of base) {
    if (input.skipped.has(key)) continue;
    const found = local.get(key);
    if (found !== undefined) {
      associated.set(key, found);
      used.add(key);
      continue;
    }
    missing.push([key, entry]);
  }
  const by_hash = new Map<string, string[]>();
  for (const [local_key, candidate] of local) {
    if (base.has(local_key)) continue;
    const keys = by_hash.get(candidate.hash) ?? [];
    keys.push(local_key);
    by_hash.set(candidate.hash, keys);
  }
  for (const [key, entry] of missing) {
    const moved = (by_hash.get(entry.hash) ?? []).find(
      (local_key) =>
        !used.has(local_key) && is_markdown(local.get(local_key)!.path) === is_markdown(entry.path),
    );
    if (moved === undefined) continue;
    associated.set(key, local.get(moved)!);
    used.add(moved);
  }

  const handled_remote = new Set<string>();
  const vacated = new Set<string>();
  const replaceable = new Map<string, LocalRef>();

  const move_aside = (entry: LocalEntry, reason: "collision" | "conflict", copy: string) => {
    const local_key = path_key(entry.path);
    used.add(local_key);
    vacated.add(local_key);
    actions.push({ kind: "rename_local", from: entry.disk, to: copy, hash: entry.hash, reason });
    actions.push({ kind: "push", note_id: null, local: { path: copy, disk: copy, hash: entry.hash }, reason: reason === "conflict" ? "conflict" : "renamed" });
  };

  const unassociated_at = (key: string): LocalEntry | undefined => {
    const entry = local.get(key);
    if (entry === undefined || used.has(key) || base.has(key)) return undefined;
    return entry;
  };

  const conflict_copy = (path: string) =>
    claim(conflict_path(path, input.device, input.now, taken));

  for (const [key, entry] of base) {
    if (input.skipped.has(key)) continue;
    const mine = associated.get(key) ?? null;
    const theirs = remote_by_id.get(entry.note_id) ?? null;
    if (theirs !== null) handled_remote.add(theirs.note_id);
    const local_changed = mine !== null && mine.hash !== entry.hash;
    const ref = (value: LocalEntry): LocalRef => ({ path: value.path, disk: value.disk, hash: value.hash });

    if (theirs === null) {
      if (mine === null) {
        actions.push({ kind: "forget", key });
        continue;
      }
      const occupant = remote.get(path_key(mine.path));
      if (!local_changed) {
        if (occupant !== undefined && occupant.note_id !== entry.note_id) {
          replaceable.set(path_key(mine.path), ref(mine));
          actions.push({ kind: "forget", key });
          continue;
        }
        actions.push({ kind: "delete_local", key: path_key(mine.path), disk: mine.disk, hash: mine.hash });
        vacated.add(path_key(mine.path));
        actions.push({ kind: "forget", key });
        continue;
      }
      actions.push({ kind: "forget", key });
      if (occupant !== undefined && occupant.note_id !== entry.note_id) {
        move_aside(mine, "conflict", conflict_copy(mine.path));
        notices.push(`"${mine.path}" was deleted elsewhere and replaced; your edits are kept as a conflict copy.`);
        continue;
      }
      actions.push({ kind: "push", note_id: null, local: ref(mine), reason: "restore" });
      notices.push(`"${mine.path}" was deleted elsewhere, but you edited it here, so it is restored.`);
      continue;
    }

    const remote_moved = theirs.path !== entry.path;
    const remote_changed = theirs.hash !== entry.hash;

    if (mine === null) {
      if (!remote_moved && !remote_changed) {
        actions.push({ kind: "delete_remote", note_id: entry.note_id, path: theirs.path, counted: true });
        actions.push({ kind: "forget", key });
        continue;
      }
      if (path_key(theirs.path) !== key) actions.push({ kind: "forget", key });
      const squatter = unassociated_at(path_key(theirs.path));
      if (squatter !== undefined) {
        used.add(path_key(squatter.path));
        if (squatter.hash === theirs.hash) {
          actions.push({ kind: "adopt", remote: theirs });
          continue;
        }
        actions.push({ kind: "keep_both", remote: theirs, local: ref(squatter), copy_path: conflict_copy(theirs.path) });
        continue;
      }
      actions.push({ kind: "pull", note_id: theirs.note_id, path: theirs.path, hash: theirs.hash, replace: null });
      if (remote_changed) notices.push(`"${theirs.path}" was deleted here but edited elsewhere, so it is restored.`);
      continue;
    }

    const local_moved = mine.path !== entry.path;
    let target = mine.path;
    let disk = mine.disk;

    if (remote_moved) {
      target = theirs.path;
      if (mine.path !== theirs.path) {
        const target_key = path_key(theirs.path);
        const squatter = target_key === path_key(mine.path) ? undefined : unassociated_at(target_key);
        if (squatter !== undefined) {
          const aside = claim(numbered_path(squatter.path, taken));
          move_aside(squatter, "collision", aside);
          notices.push(`"${squatter.path}" was new here, but another note moved onto that name; yours is now "${aside}".`);
        }
        actions.push({ kind: "rename_local", from: mine.disk, to: theirs.path, hash: mine.hash, reason: "remote_move" });
        vacated.add(path_key(mine.path));
        disk = theirs.path;
        if (local_moved && path_key(mine.path) !== key) {
          notices.push(`"${entry.path}" was renamed here and elsewhere; it keeps the other name, "${theirs.path}".`);
        }
      }
    } else if (local_moved) {
      const target_key = path_key(mine.path);
      const occupant = remote.get(target_key);
      if (is_markdown(mine.path) !== is_markdown(entry.path)) {
        actions.push({ kind: "push", note_id: null, local: ref(mine), reason: "renamed" });
        actions.push({ kind: "delete_remote", note_id: entry.note_id, path: theirs.path, counted: false });
        actions.push({ kind: "forget", key });
        continue;
      }
      if (occupant !== undefined && occupant.note_id !== entry.note_id) {
        const aside = claim(numbered_path(mine.path, taken));
        actions.push({ kind: "rename_local", from: mine.disk, to: aside, hash: mine.hash, reason: "collision" });
        vacated.add(target_key);
        notices.push(`"${mine.path}" is taken by another note, so this one is now "${aside}".`);
        target = aside;
        disk = aside;
      }
      actions.push({ kind: "move_remote", note_id: entry.note_id, from: theirs.path, to: target });
    }

    if (path_key(target) !== key) actions.push({ kind: "forget", key });
    const here: LocalRef = { path: target, disk, hash: mine.hash };

    if (local_changed && remote_changed) {
      if (mine.hash === theirs.hash) {
        actions.push({ kind: "adopt", remote: { ...theirs, path: target } });
        continue;
      }
      if (is_markdown(target) && input.conflicts === "merge") {
        actions.push({ kind: "merge", base: entry, remote: { ...theirs, path: target }, local: here });
        continue;
      }
      actions.push({
        kind: "keep_both",
        remote: { ...theirs, path: target },
        local: here,
        copy_path: conflict_copy(target),
      });
      continue;
    }
    if (local_changed) {
      actions.push({ kind: "push", note_id: entry.note_id, local: here, reason: "edit" });
      continue;
    }
    if (remote_changed) {
      actions.push({ kind: "pull", note_id: theirs.note_id, path: target, hash: theirs.hash, replace: here });
      continue;
    }
    if (theirs.version !== entry.version || remote_moved || local_moved) {
      actions.push({ kind: "adopt", remote: { ...theirs, path: target } });
    }
  }

  for (const [key, entry] of remote) {
    if (handled_remote.has(entry.note_id)) continue;
    if (input.skipped.has(key)) continue;
    const here = local.get(key);
    if (here === undefined || vacated.has(key)) {
      actions.push({ kind: "pull", note_id: entry.note_id, path: entry.path, hash: entry.hash, replace: null });
      continue;
    }
    if (!used.has(key) && !base.has(key)) {
      used.add(key);
      if (here.hash === entry.hash) {
        actions.push({ kind: "adopt", remote: entry });
        continue;
      }
      actions.push({
        kind: "keep_both",
        remote: entry,
        local: { path: here.path, disk: here.disk, hash: here.hash },
        copy_path: conflict_copy(entry.path),
      });
      continue;
    }
    const replace = replaceable.get(key);
    if (replace !== undefined) {
      actions.push({ kind: "pull", note_id: entry.note_id, path: entry.path, hash: entry.hash, replace });
      continue;
    }
    deferred = true;
    notices.push(`"${entry.path}" waits for the next run, because a file here is still in its way.`);
  }

  for (const [key, entry] of local) {
    if (used.has(key) || base.has(key)) continue;
    if (remote.has(key)) continue;
    actions.push({ kind: "push", note_id: null, local: { path: entry.path, disk: entry.disk, hash: entry.hash }, reason: "new" });
  }

  return { actions: sort_actions(actions), notices, deferred };
}

export function counted_deletes(plan: Plan): number {
  return plan.actions.filter((action) => action.kind === "delete_remote" && action.counted).length;
}

export function mass_delete_blocked(deletes: number, tracked: number): boolean {
  if (deletes === 0) return false;
  if (deletes > 10) return true;
  if (tracked >= 2 && deletes >= tracked) return true;
  return deletes >= 3 && deletes > tracked * 0.1;
}
