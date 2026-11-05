import { z } from "zod";
import type { Credentials } from "./auth.js";
import { base64, from_base64, random_hex } from "./bytes.js";
import type { CredentialStore } from "./session.js";

const credentials_schema = z.object({
  api_url: z.string(),
  access_token: z.string(),
  refresh_token: z.string().nullable(),
  expires_at: z.number(),
  scope: z.string(),
  account: z.string().nullable(),
});

export class LocalStore implements CredentialStore {
  constructor(private readonly prefix: string) {}

  private key(name: string): string {
    return `nemu-sync:${this.prefix}:${name}`;
  }

  private get(name: string): string | null {
    try {
      return window.localStorage.getItem(this.key(name));
    } catch {
      return null;
    }
  }

  private set(name: string, value: string | null): void {
    try {
      if (value === null) window.localStorage.removeItem(this.key(name));
      else window.localStorage.setItem(this.key(name), value);
    } catch {
      return;
    }
  }

  load(): Credentials | null {
    const raw = this.get("credentials");
    if (raw === null) return null;
    try {
      const parsed = credentials_schema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  save(credentials: Credentials | null): void {
    this.set("credentials", credentials === null ? null : JSON.stringify(credentials));
  }

  install_id(): string {
    const existing = this.get("install");
    if (existing !== null) return existing;
    const created = random_hex(16);
    this.set("install", created);
    return created;
  }

  device_id(): string | null {
    return this.get("device");
  }

  set_device_id(id: string | null): void {
    this.set("device", id);
  }

  vault_key(vault_id: string): Uint8Array | null {
    const raw = this.get(`vault-key:${vault_id}`);
    if (raw === null) return null;
    const key = from_base64(raw);
    return key.length === 32 ? key : null;
  }

  keep_vault_key(vault_id: string, key: Uint8Array | null): void {
    this.set(`vault-key:${vault_id}`, key === null ? null : base64(key));
  }
}
