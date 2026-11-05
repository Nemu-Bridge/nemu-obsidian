const IGNORED_SEGMENTS = new Set([
  ".git",
  ".trash",
  ".nemu",
  "node_modules",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  ".claude",
  ".codex",
  ".cursor",
  ".vscode",
  ".idea",
  ".husky",
]);

const EXECUTABLE_FOLDERS = [".github/workflows", ".git/hooks"];

export interface IgnoreRule {
  pattern: RegExp;
  negated: boolean;
  folder_only: boolean;
}

export interface IgnoreOptions {
  obsidian: boolean;
  obsidian_plugins: boolean;
  rules: IgnoreRule[];
}

function glob_source(glob: string): string {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    if (character === "*") {
      if (glob[index + 1] === "*") {
        const slash = glob[index + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        index += slash ? 2 : 1;
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return source;
}

export function parse_ignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    let body = negated ? line.slice(1) : line;
    const folder_only = body.endsWith("/");
    if (folder_only) body = body.replace(/\/+$/, "");
    const anchored = body.startsWith("/") || body.includes("/");
    body = body.replace(/^\/+/, "");
    if (body.length === 0) continue;
    const source = glob_source(body.normalize("NFC"));
    const prefix = anchored ? "^" : "^(?:.*/)?";
    rules.push({ pattern: new RegExp(`${prefix}${source}$`, "i"), negated, folder_only });
  }
  return rules;
}

function rule_matches(rule: IgnoreRule, path: string, is_folder: boolean): boolean {
  const segments = path.split("/");
  const limit = rule.folder_only && !is_folder ? segments.length - 1 : segments.length;
  for (let length = 1; length <= limit; length += 1) {
    if (rule.pattern.test(segments.slice(0, length).join("/"))) return true;
  }
  return false;
}

function is_obsidian_noise(segments: string[]): boolean {
  if (segments[0] !== ".obsidian") return false;
  if (segments.length === 2 && /^workspace.*\.json$/i.test(segments[1]!)) return true;
  return segments.includes("cache");
}

export function is_default_ignored(path: string, obsidian: boolean, obsidian_plugins = false): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return true;
  if (segments.some((segment) => segment.startsWith("._"))) return true;
  if (EXECUTABLE_FOLDERS.some((folder) => path === folder || path.startsWith(`${folder}/`))) return true;
  if (segments[0] === ".obsidian" && (!obsidian || is_obsidian_noise(segments))) return true;
  if (segments[0] === ".obsidian" && segments[1] === "plugins" && !obsidian_plugins) return true;
  return /\.(tmp|swp|crdownload|part)$/i.test(path) || path.endsWith("~");
}

export function is_ignored(path: string, options: IgnoreOptions, is_folder = false): boolean {
  if (is_default_ignored(path, options.obsidian, options.obsidian_plugins)) return true;
  let ignored = false;
  for (const rule of options.rules) {
    if (rule.negated === ignored && rule_matches(rule, path, is_folder)) ignored = !rule.negated;
  }
  return ignored;
}

export function ignore_fingerprint(options: IgnoreOptions, source: string): string {
  const mode = options.obsidian ? (options.obsidian_plugins ? "obsidian+plugins" : "obsidian") : "plain";
  return `${mode}:${source.length}:${source}`;
}
