import { random_hex } from "../bytes.js";
import { hash_of, type Hasher } from "./hash.js";
import { is_ignored, type IgnoreOptions } from "./ignore.js";
import { check_path, normalize_path, path_key } from "./paths.js";

export interface LocalEntry {
  path: string;
  disk: string;
  hash: string;
  size: number;
}

export interface Skipped {
  path: string;
  reason: string;
}

export interface ScanResult {
  files: Map<string, LocalEntry>;
  skipped: Skipped[];
}

export interface Listing {
  files: string[];
  folders: string[];
}

export interface Storage {
  list(folder: string): Promise<Listing>;
  size(path: string): Promise<number | null>;
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, content: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<boolean>;
  is_hidden_folder(path: string): boolean;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function parent_of(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function name_of(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function is_safe(relative: string): boolean {
  if (relative.length === 0 || relative.startsWith("/")) return false;
  return relative.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export async function scan_folder(
  storage: Storage,
  ignore: IgnoreOptions,
  max_file_bytes: number,
  preferred: (key: string) => string | undefined = () => undefined,
  hasher: Hasher = hash_of,
): Promise<ScanResult> {
  const files = new Map<string, LocalEntry>();
  const skipped: Skipped[] = [];
  const clashes = new Map<string, LocalEntry[]>();

  const walk = async (relative_folder: string): Promise<void> => {
    const listing = await storage.list(relative_folder).catch(() => ({ files: [], folders: [] }));
    const folders = [...listing.folders].sort();
    const names = [...listing.files].sort();
    for (const folder of folders) {
      const path = normalize_path(folder);
      if (relative_folder === "" && name_of(folder) === ".nemu") continue;
      if (storage.is_hidden_folder(folder)) continue;
      if (is_ignored(path, ignore, true)) continue;
      await walk(folder);
    }
    for (const disk of names) {
      const path = normalize_path(disk);
      if (is_ignored(path, ignore)) continue;
      const checked = check_path(path);
      if (!checked.ok) {
        skipped.push({ path, reason: `not synced: ${checked.error}` });
        continue;
      }
      const size = await storage.size(disk).catch(() => null);
      if (size === null) continue;
      if (size > max_file_bytes) {
        skipped.push({
          path,
          reason: `${megabytes(size)}, above the ${megabytes(max_file_bytes)} your plan allows per file`,
        });
        continue;
      }
      const content = await storage.read(disk).catch(() => null);
      if (content === null) continue;
      const local: LocalEntry = { path, disk, hash: hasher(content), size: content.length };
      const key = path_key(path);
      const group = clashes.get(key) ?? [];
      group.push(local);
      clashes.set(key, group);
    }
  };

  await walk("");

  for (const [key, group] of clashes) {
    if (group.length === 1) {
      files.set(key, group[0]!);
      continue;
    }
    const wanted = preferred(key);
    const keep = group.find((entry) => entry.path === wanted) ?? group[0]!;
    files.set(key, keep);
    for (const entry of group) {
      if (entry === keep) continue;
      skipped.push({
        path: entry.path,
        reason: `differs from "${keep.path}" only by case, which macOS and Windows cannot hold side by side`,
      });
    }
  }
  return { files, skipped };
}

export async function read_hash(storage: Storage, disk: string, hasher: Hasher = hash_of): Promise<string | null> {
  const content = await storage.read(disk).catch(() => null);
  return content === null ? null : hasher(content);
}

export async function read_if(
  storage: Storage,
  disk: string,
  expected_hash: string,
  hasher: Hasher = hash_of,
): Promise<Uint8Array | null> {
  const content = await storage.read(disk).catch(() => null);
  if (content === null || hasher(content) !== expected_hash) return null;
  return content;
}

async function ensure_parent(storage: Storage, relative: string): Promise<void> {
  const parent = parent_of(relative);
  if (parent === "") return;
  const segments = parent.split("/");
  for (let index = 1; index <= segments.length; index += 1) {
    const folder = segments.slice(0, index).join("/");
    if ((await storage.size(folder).catch(() => null)) !== null) continue;
    await storage.mkdir(folder).catch(() => undefined);
  }
}

async function exists(storage: Storage, relative: string): Promise<boolean> {
  return (await storage.size(relative).catch(() => null)) !== null;
}

export async function write_atomic_file(
  storage: Storage,
  relative: string,
  content: Uint8Array,
  expected: { disk: string; hash: string } | null,
  hasher: Hasher = hash_of,
): Promise<boolean> {
  if (!is_safe(relative)) return false;
  if (expected === null) {
    if (await exists(storage, relative)) return false;
  } else if ((await read_hash(storage, expected.disk, hasher)) !== expected.hash) {
    return false;
  }
  await ensure_parent(storage, relative);
  if (expected !== null && expected.disk !== relative) {
    await storage.remove(expected.disk).catch(() => undefined);
  }
  await storage.write(relative, content);
  return true;
}

export async function rename_local(storage: Storage, from: string, to: string): Promise<boolean> {
  if (!is_safe(from) || !is_safe(to)) return false;
  const same_key = path_key(normalize_path(from)) === path_key(normalize_path(to));
  if (!same_key && (await exists(storage, to))) return false;
  await ensure_parent(storage, to);
  try {
    if (same_key) {
      const step = `${to}.${random_hex(4)}.nemu.tmp`;
      await storage.rename(from, step);
      await storage.rename(step, to);
    } else {
      await storage.rename(from, to);
    }
  } catch {
    return false;
  }
  await prune_folders(storage, parent_of(from));
  return true;
}

export async function delete_local(
  storage: Storage,
  disk: string,
  expected_hash: string,
  hasher: Hasher = hash_of,
): Promise<boolean> {
  if (!is_safe(disk)) return false;
  if ((await read_hash(storage, disk, hasher)) !== expected_hash) return false;
  await storage.remove(disk);
  await prune_folders(storage, parent_of(disk));
  return true;
}

async function prune_folders(storage: Storage, relative_folder: string): Promise<void> {
  let current = relative_folder;
  while (current !== "") {
    if (!(await storage.rmdir(current).catch(() => false))) return;
    current = parent_of(current);
  }
}
