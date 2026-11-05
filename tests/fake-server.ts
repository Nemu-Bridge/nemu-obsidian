import { hash_of } from "../src/sync/hash.js";
import { from_base64, text_of } from "../src/bytes.js";
import type { Reply, Transport, TransportOptions } from "../src/sync/api.js";

interface Version {
  version: number;
  path: string;
  sealed_path?: string;
  content: Uint8Array;
  hash: string;
  deleted: boolean;
}

interface Note {
  id: string;
  path: string;
  sealed_path?: string;
  version: number;
  hash: string;
  content: Uint8Array;
  revision: number;
  deleted: boolean;
  versions: Version[];
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body));
  const lowered = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return {
    status,
    header: (name) => lowered.get(name.toLowerCase()) ?? null,
    bytes: () => bytes,
    json: () => JSON.parse(text_of(bytes)) as unknown,
  };
}

function body_bytes(options: TransportOptions): Uint8Array {
  if (options.body === undefined) return new Uint8Array(0);
  return typeof options.body === "string" ? new TextEncoder().encode(options.body) : options.body;
}

export class FakeServer {
  readonly notes = new Map<string, Note>();
  revision = 0;
  locks: { id: string; kind: string; label: string; params: Record<string, string | number>; wrapped: string }[] = [];
  merges: unknown[] = [];
  private next_id = 1;

  constructor(
    readonly vault_id: string,
    readonly mode: "standard" | "private" = "standard",
  ) {}

  private key(path: string): string {
    return path.normalize("NFC").toLowerCase();
  }

  private find(path: string): Note | undefined {
    const note = [...this.notes.values()].find((entry) => this.key(entry.path) === this.key(path) && !entry.deleted);
    return note;
  }

  private present(note: Note) {
    return {
      id: note.id,
      path: note.path,
      kind: note.path.endsWith(".md") ? "markdown" : "file",
      version: note.version,
      hash: note.hash,
      size: note.content.length,
      revision: note.revision,
      deleted: note.deleted,
      ...(note.sealed_path === undefined ? {} : { sealed_path: note.sealed_path }),
    };
  }

  text(path: string): string | null {
    const note = this.find(path);
    return note === undefined ? null : text_of(note.content);
  }

  live_paths(): string[] {
    return [...this.notes.values()].filter((note) => !note.deleted).map((note) => note.path).sort();
  }

  write(path: string, content: Uint8Array, hash = hash_of(content), sealed_path?: string): Note {
    const existing = this.find(path);
    this.revision += 1;
    if (existing === undefined) {
      const note: Note = {
        id: `note-${this.next_id++}`,
        path,
        sealed_path,
        version: 1,
        hash,
        content,
        revision: this.revision,
        deleted: false,
        versions: [],
      };
      note.versions.push({ version: 1, path, sealed_path, content, hash, deleted: false });
      this.notes.set(note.id, note);
      return note;
    }
    existing.version += 1;
    existing.content = content;
    existing.hash = hash;
    existing.path = path;
    existing.sealed_path = sealed_path;
    existing.revision = this.revision;
    existing.versions.push({ version: existing.version, path, sealed_path, content, hash, deleted: false });
    return existing;
  }

  transport(): Transport {
    return async (method, raw_path, options) => this.handle(method, raw_path, options);
  }

  private async handle(method: string, raw_path: string, options: TransportOptions): Promise<Reply> {
    const base = `/api/v1/vaults/${this.vault_id}`;
    const query = options.query ?? {};
    const headers = new Map(Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    if (method === "GET" && raw_path === "/api/v1/vaults") {
      return reply(200, { data: [{ id: this.vault_id, name: "Test", mode: this.mode, revision: this.revision }] });
    }
    if (!raw_path.startsWith(base)) return reply(404, { error: "Not found", code: "not_found" });
    const path = raw_path.slice(base.length);
    if (method === "GET" && path === "") {
      return reply(200, {
        data: { id: this.vault_id, name: "Test", mode: this.mode, revision: this.revision },
        limits: { max_file_bytes: 4 * 1024 * 1024, max_storage_bytes: null },
      });
    }
    if (method === "GET" && path === "/notes") {
      return reply(200, {
        vault: { id: this.vault_id, name: "Test", mode: this.mode, revision: this.revision },
        data: [...this.notes.values()].filter((note) => !note.deleted).map((note) => this.present(note)),
      });
    }
    if (method === "GET" && path === "/changes") {
      const since = Number(query.since);
      return reply(200, {
        data: [...this.notes.values()].filter((note) => note.revision > since).map((note) => this.present(note)),
        revision: this.revision,
        has_more: false,
      });
    }
    if (path === "/files") {
      const target = String(query.path);
      const current = this.find(target);
      if (method === "GET") {
        if (current === undefined) return reply(404, { error: "Note not found", code: "not_found" });
        return reply(200, current.content, {
          "x-nemu-note-id": current.id,
          "x-nemu-version": String(current.version),
          "x-nemu-hash": current.hash,
        });
      }
      if (method === "PUT") {
        const content = body_bytes(options);
        const if_none = headers.get("if-none-match");
        const if_match = headers.get("if-match");
        if (if_none === "*" && current !== undefined) {
          return reply(409, { error: "Exists", code: "conflict", current: this.present(current) });
        }
        if (if_match !== undefined) {
          if (current === undefined) return reply(409, { error: "Gone", code: "conflict", current: null });
          if (`"${current.version}"` !== if_match) {
            return reply(409, { error: "Changed", code: "conflict", current: this.present(current) });
          }
        }
        const mac = headers.get("x-nemu-content-mac");
        if (this.mode === "private" && (mac === undefined || headers.get("x-nemu-sealed-path") === undefined)) {
          return reply(400, { error: "A private vault takes sealed notes only", code: "not_sealed" });
        }
        const note = this.write(target, content, mac ?? hash_of(content), headers.get("x-nemu-sealed-path"));
        return reply(200, { data: this.present(note) });
      }
      if (method === "DELETE") {
        if (current === undefined) return reply(404, { error: "Note not found", code: "not_found" });
        if (Number(query.version) !== current.version) {
          return reply(409, { error: "Changed", code: "conflict", current: this.present(current) });
        }
        this.revision += 1;
        current.deleted = true;
        current.version += 1;
        current.revision = this.revision;
        current.versions.push({ version: current.version, path: current.path, content: current.content, hash: current.hash, deleted: true });
        return reply(200, { data: this.present(current) });
      }
    }
    if (method === "POST" && path === "/files/move") {
      const body = JSON.parse(text_of(body_bytes(options))) as {
        from: string;
        to: string;
        base_version: number;
        sealed_path?: string;
        content_hash?: string;
        content?: string;
      };
      const current = this.find(body.from);
      if (current === undefined) return reply(404, { error: "Note not found", code: "not_found" });
      if (current.version !== body.base_version) return reply(409, { error: "Changed", code: "conflict", current: this.present(current) });
      if (this.find(body.to) !== undefined && this.key(body.to) !== this.key(body.from)) {
        return reply(409, { error: "Taken", code: "conflict", current: null });
      }
      this.revision += 1;
      current.path = body.to;
      current.version += 1;
      current.revision = this.revision;
      if (body.content !== undefined) current.content = from_base64(body.content);
      if (body.sealed_path !== undefined) current.sealed_path = body.sealed_path;
      if (body.content_hash !== undefined) current.hash = body.content_hash;
      current.versions.push({ version: current.version, path: current.path, sealed_path: current.sealed_path, content: current.content, hash: current.hash, deleted: false });
      return reply(200, { data: this.present(current) });
    }
    if (method === "POST" && path === "/merges") {
      this.merges.push(JSON.parse(text_of(body_bytes(options))));
      return reply(200, { data: { id: "merge" } });
    }
    if (method === "GET" && path === "/history") {
      const note = this.notes.get(String(query.note_id));
      if (note === undefined) return reply(404, { error: "Note not found", code: "not_found" });
      return reply(200, {
        data: note.versions.map((version) => ({
          version: version.version,
          path: version.path,
          ...(version.sealed_path === undefined ? {} : { sealed_path: version.sealed_path }),
          hash: version.hash,
          size: version.content.length,
          deleted: version.deleted,
          origin: "device",
          origin_id: null,
          client: null,
          created_at: new Date().toISOString(),
        })),
      });
    }
    if (method === "GET" && path === "/history/version") {
      const note = this.notes.get(String(query.note_id));
      const version = note?.versions.find((entry) => entry.version === Number(query.version));
      if (version === undefined) return reply(404, { error: "Version not found", code: "not_found" });
      return reply(200, version.content);
    }
    if (method === "GET" && path === "/locks") {
      return reply(200, {
        data: this.locks.map((lock) => ({ id: lock.id, kind: lock.kind, label: lock.label, params: lock.params, created_at: "", last_used_at: null })),
      });
    }
    if (method === "GET" && path.startsWith("/locks/")) {
      const lock = this.locks.find((entry) => entry.id === path.slice("/locks/".length));
      return lock === undefined ? reply(404, { error: "No lock", code: "not_found" }) : reply(200, { data: { wrapped: lock.wrapped } });
    }
    return reply(404, { error: `No route ${method} ${path}`, code: "not_found" });
  }
}
