import { SyncError } from "./errors.js";
import { LockApi, VaultApi, type Transport, type VaultClient } from "./sync/api.js";
import { PrivateVaultApi } from "./private/api.js";
import { unbase32, vault_keys } from "./private/crypto.js";
import { open_password_lock, open_recovery_lock } from "./private/locks.js";

export type VaultMode = "standard" | "private";

export interface LinkedVault {
  vault_id: string;
  vault_name: string;
  api_url: string;
  workspace_id: string | null;
  mode: VaultMode;
}

export interface Opened {
  api: VaultClient;
  is_private: boolean;
}

export async function open_linked(
  transport: Transport,
  link: LinkedVault,
  client_label: string,
  vault_key: Uint8Array | null,
): Promise<Opened> {
  const api = new VaultApi(transport, link.vault_id, client_label);
  const info = await api.info();
  const says_private = info.data.mode === "private";
  const is_pinned_private = link.mode === "private" || vault_key !== null;
  if (is_pinned_private !== says_private) {
    throw new SyncError(
      `Nemu now reports "${link.vault_name}" as ${says_private ? "private" : "not private"}, but it was ${is_pinned_private ? "private" : "not private"} when this vault was linked. A vault never changes this, so nothing was synced. Check the vault in the console.`,
      "vault_mode_changed",
    );
  }
  if (!says_private) return { api, is_private: false };
  if (vault_key === null) {
    throw new SyncError(`"${link.vault_name}" is a private vault and is locked on this device. Unlock it first. Nothing was synced.`, "vault_locked");
  }
  return { api: new PrivateVaultApi(api, vault_keys(link.vault_id, vault_key)), is_private: true };
}

export async function describe_vault(
  transport: Transport,
  vault_id: string,
  api_url: string,
): Promise<LinkedVault> {
  const info = await new VaultApi(transport, vault_id, "nemu-obsidian").info();
  return {
    vault_id,
    vault_name: info.data.name,
    api_url,
    workspace_id: info.workspace_id ?? null,
    mode: info.data.mode === "private" ? "private" : "standard",
  };
}

export async function unlock_with(
  transport: Transport,
  vault_id: string,
  method: "password" | "recovery",
  secret: string,
): Promise<Uint8Array> {
  const locks = new LockApi(transport, vault_id);
  const lock = (await locks.locks()).find((entry) => entry.kind === method);
  if (lock === undefined) throw new SyncError(`This vault has no ${method} lock.`, "no_such_lock");
  const wrapped = await locks.wrapped(lock.id);
  try {
    if (method === "password") return await open_password_lock(vault_id, lock.params, wrapped, secret);
    const recovery = unbase32(secret);
    if (recovery.length !== 32) throw new SyncError("That is not a recovery key.", "bad_recovery_key");
    return open_recovery_lock(vault_id, lock.params, wrapped, recovery);
  } catch (error) {
    if (error instanceof SyncError) throw error;
    if (error instanceof Error && error.message.includes("[bad_lock]")) {
      throw new SyncError("This vault's password lock is damaged or was changed on the server, so it was not used.", "bad_lock");
    }
    throw new SyncError(
      method === "password" ? "That is not the vault password." : "That recovery key does not open this vault.",
      "wrong_secret",
    );
  }
}
