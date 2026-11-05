export type MergeResult = { kind: "clean"; text: string } | { kind: "conflict" };

interface Hunk {
  side: "local" | "remote";
  base_start: number;
  base_length: number;
  side_start: number;
  side_length: number;
}

interface Lines {
  keys: string[];
  terminators: string[];
}

const MAX_EDIT_DISTANCE = 3000;

function split_lines(text: string): Lines {
  const keys: string[] = [];
  const terminators: string[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      keys.push(text.slice(start));
      terminators.push("");
      break;
    }
    const has_return = newline > start && text[newline - 1] === "\r";
    keys.push(text.slice(start, has_return ? newline - 1 : newline));
    terminators.push(has_return ? "\r\n" : "\n");
    start = newline + 1;
  }
  return { keys, terminators };
}

function line_ending_of(lines: Lines): string | null {
  let crlf = 0;
  let lf = 0;
  for (const terminator of lines.terminators) {
    if (terminator === "\r\n") crlf += 1;
    if (terminator === "\n") lf += 1;
  }
  if (crlf === 0 && lf === 0) return null;
  return crlf > lf ? "\r\n" : "\n";
}

function ends_with_newline(lines: Lines): boolean {
  const last = lines.terminators[lines.terminators.length - 1];
  return last !== undefined && last !== "";
}

function shortest_edit(a: string[], b: string[], max: number): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(max, n + m);
  const offset = limit + 1;
  const frontier = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let depth = 0; depth <= limit; depth += 1) {
    trace.push(frontier.slice(offset - depth - 1, offset + depth + 2));
    for (let k = -depth; k <= depth; k += 2) {
      const go_down =
        k === -depth || (k !== depth && frontier[offset + k - 1]! < frontier[offset + k + 1]!);
      let x = go_down ? frontier[offset + k + 1]! : frontier[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      frontier[offset + k] = x;
      if (x >= n && y >= m) {
        found = depth;
        break;
      }
    }
    if (found !== -1) break;
  }
  if (found === -1) return null;

  const matches: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let depth = found; depth > 0; depth -= 1) {
    const snapshot = trace[depth]!;
    const at = (k: number) => snapshot[k + depth + 1]!;
    const k = x - y;
    const go_down = k === -depth || (k !== depth && at(k - 1) < at(k + 1));
    const previous_k = go_down ? k + 1 : k - 1;
    const previous_x = at(previous_k);
    const previous_y = previous_x - previous_k;
    while (x > previous_x && y > previous_y) {
      x -= 1;
      y -= 1;
      matches.push([x, y]);
    }
    x = previous_x;
    y = previous_y;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    matches.push([x, y]);
  }
  return matches.reverse();
}

export function matching_lines(a: string[], b: string[]): Array<[number, number]> | null {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const middle = shortest_edit(
    a.slice(prefix, a.length - suffix),
    b.slice(prefix, b.length - suffix),
    MAX_EDIT_DISTANCE,
  );
  if (middle === null) return null;
  const matches: Array<[number, number]> = [];
  for (let index = 0; index < prefix; index += 1) matches.push([index, index]);
  for (const [left, right] of middle) matches.push([left + prefix, right + prefix]);
  for (let index = suffix; index > 0; index -= 1) {
    matches.push([a.length - index, b.length - index]);
  }
  return matches;
}

function hunks_of(
  base: string[],
  other: string[],
  side: Hunk["side"],
): Hunk[] | null {
  const matches = matching_lines(base, other);
  if (matches === null) return null;
  const hunks: Hunk[] = [];
  let base_at = 0;
  let other_at = 0;
  for (const [base_match, other_match] of [...matches, [base.length, other.length] as [number, number]]) {
    if (base_match > base_at || other_match > other_at) {
      hunks.push({
        side,
        base_start: base_at,
        base_length: base_match - base_at,
        side_start: other_at,
        side_length: other_match - other_at,
      });
    }
    base_at = base_match + 1;
    other_at = other_match + 1;
  }
  return hunks;
}

function same(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

interface Piece {
  side: "base" | "local" | "remote";
  start: number;
  end: number;
}

function side_range(
  hunks: Hunk[],
  side: Hunk["side"],
  region_start: number,
  region_end: number,
): [number, number] {
  const own = hunks.filter((hunk) => hunk.side === side);
  if (own.length === 0) return [-1, -1];
  const first = own[0]!;
  const last = own[own.length - 1]!;
  const start = first.side_start - (first.base_start - region_start);
  const end = last.side_start + last.side_length + (region_end - (last.base_start + last.base_length));
  return [start, end];
}

function merge_pieces(base: string[], local: string[], remote: string[]): Piece[] | null {
  const local_hunks = hunks_of(base, local, "local");
  const remote_hunks = hunks_of(base, remote, "remote");
  if (local_hunks === null || remote_hunks === null) return null;
  const hunks = [...local_hunks, ...remote_hunks].sort(
    (left, right) => left.base_start - right.base_start || (left.side === "local" ? -1 : 1),
  );
  const pieces: Piece[] = [];
  let cursor = 0;
  let index = 0;
  while (index < hunks.length) {
    const first = hunks[index]!;
    const region_start = first.base_start;
    let region_end = first.base_start + first.base_length;
    const region = [first];
    index += 1;
    while (index < hunks.length && hunks[index]!.base_start <= region_end) {
      const next = hunks[index]!;
      region_end = Math.max(region_end, next.base_start + next.base_length);
      region.push(next);
      index += 1;
    }
    if (region_start > cursor) pieces.push({ side: "base", start: cursor, end: region_start });
    const sides = new Set(region.map((hunk) => hunk.side));
    if (sides.size === 1) {
      const side = first.side;
      const [start, end] = side_range(region, side, region_start, region_end);
      pieces.push({ side, start, end });
    } else {
      const [local_start, local_end] = side_range(region, "local", region_start, region_end);
      const [remote_start, remote_end] = side_range(region, "remote", region_start, region_end);
      const local_part = local.slice(local_start, local_end);
      const remote_part = remote.slice(remote_start, remote_end);
      const base_part = base.slice(region_start, region_end);
      if (same(local_part, remote_part)) {
        pieces.push({ side: "local", start: local_start, end: local_end });
      } else if (same(local_part, base_part)) {
        pieces.push({ side: "remote", start: remote_start, end: remote_end });
      } else if (same(remote_part, base_part)) {
        pieces.push({ side: "local", start: local_start, end: local_end });
      } else {
        return null;
      }
    }
    cursor = region_end;
  }
  if (cursor < base.length) pieces.push({ side: "base", start: cursor, end: base.length });
  return pieces;
}

function trailing_newline(base: Lines, local: Lines, remote: Lines): boolean {
  const base_has = ends_with_newline(base);
  const local_has = ends_with_newline(local);
  return local_has !== base_has ? local_has : ends_with_newline(remote);
}

export function merge_text(base_text: string, local_text: string, remote_text: string): MergeResult {
  if (local_text === remote_text) return { kind: "clean", text: local_text };
  const base = split_lines(base_text);
  const local = split_lines(local_text);
  const remote = split_lines(remote_text);
  if (same(local.keys, remote.keys) && ends_with_newline(local) === ends_with_newline(remote)) {
    return { kind: "clean", text: local_text };
  }
  if (same(base.keys, remote.keys) && ends_with_newline(base) === ends_with_newline(remote)) {
    return { kind: "clean", text: local_text };
  }
  const pieces = merge_pieces(base.keys, local.keys, remote.keys);
  if (pieces === null) return { kind: "conflict" };
  const lines: string[] = [];
  const sources = { base: base.keys, local: local.keys, remote: remote.keys };
  for (const piece of pieces) {
    lines.push(...sources[piece.side].slice(piece.start, piece.end));
  }
  const ending = line_ending_of(local) ?? line_ending_of(remote) ?? line_ending_of(base) ?? "\n";
  const body = lines.join(ending);
  const text =
    lines.length > 0 && trailing_newline(base, local, remote) ? `${body}${ending}` : body;
  return { kind: "clean", text };
}

export function has_conflict_markers(text: string): boolean {
  return /^(<{7}|>{7})(\s|$)/m.test(text);
}
