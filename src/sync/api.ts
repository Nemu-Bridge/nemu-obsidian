import { z } from "zod";
import { base64, base64url } from "../bytes.js";
import { SyncError } from "../errors.js";
import { hash_of } from "./hash.js";

export interface TransportOptions {
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

export interface Reply {
  status: number;
  header(name: string): string | null;
  bytes(): Uint8Array;
  json(): unknown;
}

export type Transport = (method: string, path: string, options: TransportOptions) => Promise<Reply>;

const note_schema = z.object({
  id: z.string(),
  path: z.string(),
  kind: z.string(),
  version: z.number().int(),
  hash: z.string(),
  size: z.number(),
  revision: z.number(),
  deleted: z.boolean(),
  sealed_path: z.string().optional(),
});

export type RemoteNote = z.infer<typeof note_schema>;

const vault_schema = z.object({
  id: z.string(),
  name: z.string(),
  mode: z.enum(["standard", "private"]).optional(),
  revision: z.number(),
  notes: z.number().optional(),
  stored_bytes: z.number().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type RemoteVault = z.infer<typeof vault_schema>;

const info_schema = z.object({
  data: vault_schema,
  workspace_id: z.string().optional(),
  limits: z
    .object({
      max_file_bytes: z.number(),
      max_storage_bytes: z.number().nullable(),
    })
    .optional(),
});

export type VaultInfo = z.infer<typeof info_schema>;

const version_schema = z.object({
  version: z.number().int(),
  path: z.string(),
  sealed_path: z.string().optional(),
  hash: z.string(),
  size: z.number(),
  deleted: z.boolean(),
  origin: z.string(),
  origin_id: z.string().nullable(),
  client: z.string().nullable(),
  created_at: z.string(),
});

export type RemoteVersion = z.infer<typeof version_schema>;

const failure_schema = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
  reference: z.string().optional(),
  retry_after: z.number().optional(),
  current: note_schema.nullable().optional(),
});

export class RemoteError extends SyncError {
  constructor(
    message: string,
    code: string,
    status: number,
    readonly current: RemoteNote | null | undefined,
    readonly reference: string | undefined,
  ) {
    super(message, code, status);
    this.name = "RemoteError";
  }
}

const MAX_WAIT_MS = 60_000;
const ATTEMPTS = 4;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safe_json(reply: Reply): unknown {
  try {
    return reply.json();
  } catch {
    return null;
  }
}

export function error_of(reply: Reply): RemoteError {
  const parsed = failure_schema.safeParse(safe_json(reply));
  const body = parsed.success ? parsed.data : {};
  return new RemoteError(
    body.error ?? `Request failed with status ${reply.status}`,
    body.code ?? `http_${reply.status}`,
    reply.status,
    body.current,
    body.reference ?? reply.header("x-nemu-reference") ?? undefined,
  );
}

function retry_delay(reply: Reply, attempt: number): number {
  const header = Number(reply.header("retry-after") ?? "");
  const seconds = Number.isFinite(header) && header > 0 ? header : 2 ** attempt;
  return Math.min(MAX_WAIT_MS, seconds * 1000);
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SyncError("Nemu sent an answer this plugin does not understand. Update Nemu Sync.", "invalid_response");
  }
  return parsed.data;
}

function is_ok(reply: Reply): boolean {
  return reply.status >= 200 && reply.status < 300;
}

export interface SealedWrite {
  sealed_path: string;
  content_hash: string;
}

export interface FetchedNote {
  content: Uint8Array;
  id: string;
  version: number;
  hash: string;
}

export interface VaultClient {
  readonly vault_id: string;
  hash(content: Uint8Array): string;
  info(): Promise<VaultInfo>;
  notes(trash?: boolean): Promise<{ revision: number; notes: RemoteNote[] }>;
  changes(since: number): Promise<{ notes: RemoteNote[]; revision: number; has_more: boolean }>;
  read(path: string): Promise<FetchedNote>;
  write(path: string, content: Uint8Array, base_version: number | null): Promise<RemoteNote>;
  remove(path: string, version: number): Promise<RemoteNote>;
  move(from: string, to: string, base_version: number): Promise<RemoteNote>;
  record_merge(input: { path: string; merged_version: number; remote_version: number; local: Uint8Array }): Promise<void>;
  read_version(note_id: string, version: number): Promise<Uint8Array>;
  history(note_id: string, limit?: number): Promise<RemoteVersion[]>;
}

export async function call(transport: Transport, method: string, path: string, options: TransportOptions = {}): Promise<Reply> {
  for (let attempt = 1; ; attempt += 1) {
    const reply = await transport(method, path, options);
    if (reply.status !== 429 || attempt >= ATTEMPTS) {
      if (!is_ok(reply)) throw error_of(reply);
      return reply;
    }
    await wait(retry_delay(reply, attempt));
  }
}

export class VaultApi implements VaultClient {
  constructor(
    private readonly transport: Transport,
    readonly vault_id: string,
    private readonly client_label: string,
  ) {}

  private call(method: string, path: string, options: TransportOptions = {}): Promise<Reply> {
    return call(this.transport, method, path, options);
  }

  hash(content: Uint8Array): string {
    return hash_of(content);
  }

  private base(): string {
    return `/api/v1/vaults/${encodeURIComponent(this.vault_id)}`;
  }

  async info(): Promise<VaultInfo> {
    const reply = await this.call("GET", this.base());
    return parse(info_schema, reply.json());
  }

  async notes(trash = false): Promise<{ revision: number; notes: RemoteNote[] }> {
    const reply = await this.call("GET", `${this.base()}/notes`, { query: trash ? { trash: "true" } : {} });
    const body = parse(z.object({ vault: vault_schema, data: z.array(note_schema) }), reply.json());
    return { revision: body.vault.revision, notes: body.data };
  }

  async changes(since: number): Promise<{ notes: RemoteNote[]; revision: number; has_more: boolean }> {
    const reply = await this.call("GET", `${this.base()}/changes`, { query: { since } });
    const body = parse(
      z.object({ data: z.array(note_schema), revision: z.number(), has_more: z.boolean() }),
      reply.json(),
    );
    return { notes: body.data, revision: body.revision, has_more: body.has_more };
  }

  async read(path: string): Promise<FetchedNote> {
    const reply = await this.call("GET", `${this.base()}/files`, { query: { path } });
    const id = reply.header("x-nemu-note-id");
    const version = Number(reply.header("x-nemu-version"));
    const hash = reply.header("x-nemu-hash");
    if (id === null || hash === null || !Number.isInteger(version)) {
      throw new SyncError("Nemu sent a file without its version. Update Nemu Sync.", "invalid_response");
    }
    return { content: reply.bytes(), id, version, hash };
  }

  async write(path: string, content: Uint8Array, base_version: number | null, sealed?: SealedWrite): Promise<RemoteNote> {
    const reply = await this.call("PUT", `${this.base()}/files`, {
      query: { path },
      headers: {
        "content-type": "application/octet-stream",
        "x-nemu-client": this.client_label,
        ...(base_version === null ? { "if-none-match": "*" } : { "if-match": `"${base_version}"` }),
        ...(sealed === undefined
          ? {}
          : { "x-nemu-sealed-path": sealed.sealed_path, "x-nemu-content-mac": sealed.content_hash }),
      },
      body: content,
    });
    return parse(z.object({ data: note_schema }), reply.json()).data;
  }

  async remove(path: string, version: number): Promise<RemoteNote> {
    const reply = await this.call("DELETE", `${this.base()}/files`, {
      query: { path, version },
      headers: { "x-nemu-client": this.client_label },
    });
    return parse(z.object({ data: note_schema }), reply.json()).data;
  }

  async move(
    from: string,
    to: string,
    base_version: number,
    sealed?: SealedWrite & { content: Uint8Array },
  ): Promise<RemoteNote> {
    const reply = await this.call("POST", `${this.base()}/files/move`, {
      headers: { "content-type": "application/json", "x-nemu-client": this.client_label },
      body: JSON.stringify({
        from,
        to,
        base_version,
        ...(sealed === undefined
          ? {}
          : {
              sealed_path: sealed.sealed_path,
              content_hash: sealed.content_hash,
              content: base64url(sealed.content),
            }),
      }),
    });
    return parse(z.object({ data: note_schema }), reply.json()).data;
  }

  async record_merge(input: { path: string; merged_version: number; remote_version: number; local: Uint8Array }): Promise<void> {
    await this.call("POST", `${this.base()}/merges`, {
      headers: { "content-type": "application/json", "x-nemu-client": this.client_label },
      body: JSON.stringify({
        path: input.path,
        merged_version: input.merged_version,
        remote_version: input.remote_version,
        content: base64(input.local),
        client: this.client_label,
      }),
    });
  }

  async read_version(note_id: string, version: number): Promise<Uint8Array> {
    const reply = await this.call("GET", `${this.base()}/history/version`, { query: { note_id, version } });
    return reply.bytes();
  }

  async history(note_id: string, limit = 200): Promise<RemoteVersion[]> {
    const reply = await this.call("GET", `${this.base()}/history`, { query: { note_id, limit } });
    return parse(z.object({ data: z.array(version_schema) }), reply.json()).data;
  }
}

const lock_schema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});

export type RemoteLock = z.infer<typeof lock_schema>;

export class LockApi {
  constructor(
    private readonly transport: Transport,
    readonly vault_id: string,
  ) {}

  private async request(method: string, path: string): Promise<unknown> {
    const reply = await call(this.transport, method, `/api/v1/vaults/${encodeURIComponent(this.vault_id)}${path}`);
    return reply.json();
  }

  async locks(): Promise<RemoteLock[]> {
    return parse(z.object({ data: z.array(lock_schema) }), await this.request("GET", "/locks")).data;
  }

  async wrapped(lock_id: string): Promise<string> {
    return parse(
      z.object({ data: z.object({ wrapped: z.string() }) }),
      await this.request("GET", `/locks/${encodeURIComponent(lock_id)}`),
    ).data.wrapped;
  }
}

export async function list_vaults(transport: Transport): Promise<RemoteVault[]> {
  const reply = await call(transport, "GET", "/api/v1/vaults");
  return parse(z.object({ data: z.array(vault_schema) }), reply.json()).data;
}
