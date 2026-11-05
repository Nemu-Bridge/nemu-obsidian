import { from_base64 } from "../bytes.js";
import {
  PASSWORD_LIMITS,
  PrivateCryptoError,
  password_kek,
  recovery_kek,
  unwrap_key,
  type LockParams,
  type PasswordParams,
} from "./crypto.js";

function within(value: string | number | undefined, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new PrivateCryptoError("The password lock has settings outside the safe range", "bad_lock");
  }
  return parsed;
}

export function password_settings(params: LockParams): { salt: Uint8Array; settings: PasswordParams } {
  if (params.alg !== "argon2id" || typeof params.salt !== "string") {
    throw new PrivateCryptoError("The password lock is damaged", "bad_lock");
  }
  const salt = from_base64(params.salt);
  if (salt.length < 16) throw new PrivateCryptoError("The password lock is damaged", "bad_lock");
  return {
    salt,
    settings: {
      memory_kib: within(params.m, PASSWORD_LIMITS.min_memory_kib, PASSWORD_LIMITS.max_memory_kib),
      iterations: within(params.t, PASSWORD_LIMITS.min_iterations, PASSWORD_LIMITS.max_iterations),
      parallelism: within(params.p, 1, PASSWORD_LIMITS.max_parallelism),
    },
  };
}

export async function open_password_lock(
  vault_id: string,
  params: LockParams,
  wrapped: string,
  password: string,
): Promise<Uint8Array> {
  const { salt, settings } = password_settings(params);
  const kek = await password_kek(password, salt, settings);
  return unwrap_key(kek, vault_id, "password", params, from_base64(wrapped));
}

export function open_recovery_lock(vault_id: string, params: LockParams, wrapped: string, recovery: Uint8Array): Uint8Array {
  return unwrap_key(recovery_kek(recovery), vault_id, "recovery", params, from_base64(wrapped));
}
