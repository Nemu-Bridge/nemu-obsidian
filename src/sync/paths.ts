export const MAX_PATH_LENGTH = 240;
export const MAX_SEGMENT_LENGTH = 200;
const FORBIDDEN_CHARACTERS = /[<>:"|?*\\\u0000-\u001f\u007f]/;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.[^.]*)?$/i;
const RESERVED_ROOTS = new Set([".nemu"]);

export type PathCheck = { ok: true; path: string } | { ok: false; error: string };

export function normalize_path(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

function check_segment(segment: string): string | null {
  if (segment.length === 0) return "a folder name is empty";
  if (segment === "." || segment === "..") return "it contains . or ..";
  if (segment.length > MAX_SEGMENT_LENGTH) {
    return `a name is longer than ${MAX_SEGMENT_LENGTH} characters`;
  }
  if (FORBIDDEN_CHARACTERS.test(segment)) {
    return `"${segment}" has a character Windows cannot store (< > : " | ? * \\ or a control character)`;
  }
  if (/[. ]$/.test(segment)) return `"${segment}" ends with a dot or a space, which Windows cannot store`;
  if (RESERVED_NAMES.test(segment)) return `"${segment}" is a name Windows reserves`;
  return null;
}

export function check_path(raw: string): PathCheck {
  const path = normalize_path(raw);
  if (path.length === 0) return { ok: false, error: "the path is empty" };
  if (path.length > MAX_PATH_LENGTH) {
    return { ok: false, error: `the path is longer than ${MAX_PATH_LENGTH} characters` };
  }
  const segments = path.split("/");
  if (RESERVED_ROOTS.has(segments[0]!.toLowerCase())) {
    return { ok: false, error: "the .nemu folder is reserved for sync" };
  }
  for (const segment of segments) {
    const problem = check_segment(segment);
    if (problem !== null) return { ok: false, error: problem };
  }
  return { ok: true, path };
}

export function path_key(path: string): string {
  return normalize_path(path).toLowerCase();
}

export function is_markdown(path: string): boolean {
  return /\.md$/i.test(path);
}

function split_name(path: string): { folder: string; stem: string; extension: string } {
  const slash = path.lastIndexOf("/");
  const folder = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? { folder, stem: name.slice(0, dot), extension: name.slice(dot) }
    : { folder, stem: name, extension: "" };
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

export function conflict_stamp(date: Date): string {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}-${two(date.getMinutes())}`;
}

export function safe_device_name(raw: string): string {
  const cleaned = raw
    .normalize("NFC")
    .replace(/[<>:"|?*\\/\u0000-\u001f\u007f(),]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : "this device";
}

function free_name(candidates: (index: number) => string, taken: (key: string) => boolean): string {
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = candidates(index);
    if (!taken(path_key(candidate))) return candidate;
  }
  throw new Error("No free file name was found.");
}

export function conflict_path(
  path: string,
  device: string,
  date: Date,
  taken: (key: string) => boolean,
): string {
  const { folder, stem, extension } = split_name(path);
  const label = `conflict, ${safe_device_name(device)}, ${conflict_stamp(date)}`;
  return free_name(
    (index) =>
      index === 1
        ? `${folder}${stem} (${label})${extension}`
        : `${folder}${stem} (${label} ${index})${extension}`,
    taken,
  );
}

export function numbered_path(path: string, taken: (key: string) => boolean): string {
  const { folder, stem, extension } = split_name(path);
  return free_name((index) => `${folder}${stem} (${index + 1})${extension}`, taken);
}

export function is_conflict_copy(path: string): boolean {
  return /\(conflict, [^()]*, \d{4}-\d{2}-\d{2} \d{2}-\d{2}( \d+)?\)(\.[^./]*)?$/.test(path);
}
