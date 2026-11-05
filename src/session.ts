import { z } from "zod";
import { refresh_credentials, type Credentials, type Http } from "./auth.js";
import { SyncError } from "./errors.js";
import { call, parse, type Reply, type Transport, type TransportOptions } from "./sync/api.js";

const EXPIRY_SKEW_MS = 90_000;

export interface CredentialStore {
  load(): Credentials | null;
  save(credentials: Credentials | null): void;
}

export class Session {
  private refreshing: Promise<Credentials> | null = null;
  device_id: string | null = null;

  constructor(
    private readonly http: Http,
    private readonly store: CredentialStore,
  ) {}

  credentials(): Credentials | null {
    return this.store.load();
  }

  is_signed_in(): boolean {
    return this.store.load() !== null;
  }

  sign_in(credentials: Credentials): void {
    this.store.save(credentials);
  }

  sign_out(): void {
    this.store.save(null);
  }

  private async fresh(): Promise<Credentials> {
    const current = this.store.load();
    if (current === null) throw new SyncError("Not signed in. Sign in in the Nemu Sync settings.", "not_signed_in");
    if (Date.now() < current.expires_at - EXPIRY_SKEW_MS) return current;
    this.refreshing ??= refresh_credentials(this.http, current)
      .then((next) => {
        this.store.save(next);
        return next;
      })
      .catch((error: unknown) => {
        if (error instanceof SyncError && error.code === "not_signed_in") this.store.save(null);
        throw error;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  transport(workspace_id: string | null = null): Transport {
    return async (method: string, path: string, options: TransportOptions): Promise<Reply> => {
      const credentials = await this.fresh();
      const url = new URL(`${credentials.api_url}${path}`);
      for (const [name, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) url.searchParams.set(name, String(value));
      }
      return this.http({
        url: url.toString(),
        method,
        headers: {
          authorization: `Bearer ${credentials.access_token}`,
          accept: "application/json",
          ...(this.device_id === null ? {} : { "x-nemu-device": this.device_id }),
          ...(workspace_id === null ? {} : { "x-nemu-workspace": workspace_id }),
          ...(options.headers ?? {}),
        },
        body: options.body,
      });
    };
  }
}

const device_schema = z.object({ data: z.object({ id: z.string() }) });
const devices_schema = z.object({
  data: z.array(z.object({ id: z.string(), revoked_at: z.string().nullable() })),
});

export async function ensure_device(
  transport: Transport,
  known: string | null,
  name: string,
  client_version: string,
): Promise<string> {
  if (known !== null) {
    const listed = parse(devices_schema, (await call(transport, "GET", "/api/v1/devices")).json());
    if (listed.data.some((device) => device.id === known && device.revoked_at === null)) return known;
  }
  const created = await call(transport, "POST", "/api/v1/devices", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, platform: "other", client_version }),
  });
  return parse(device_schema, created.json()).data.id;
}
