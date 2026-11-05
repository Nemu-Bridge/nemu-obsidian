import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { argon2id } from "hash-wasm";
import { concat, equal, from_base64, base64url, hex, random_bytes, text_of, utf8 } from "../bytes.js";

export const PRIVATE_PREFIX = "private/";
const CONTENT_MAGIC = utf8("NPV1");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export interface PasswordParams {
  memory_kib: number;
  iterations: number;
  parallelism: number;
}

export const PASSWORD_LIMITS = {
  min_memory_kib: 65536,
  max_memory_kib: 1048576,
  min_iterations: 3,
  max_iterations: 10,
  max_parallelism: 4,
} as const;

export class PrivateCryptoError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(`${message} [${code}]`);
    this.name = "PrivateCryptoError";
  }
}

export interface VaultKeys {
  vault_id: string;
  content: Uint8Array;
  path: Uint8Array;
  mac: Uint8Array;
}

function subkey(vault_key: Uint8Array, name: string): Uint8Array {
  return hkdf(sha256, vault_key, new Uint8Array(0), utf8(`nemu-private|${name}|v1`), KEY_BYTES);
}

export function vault_keys(vault_id: string, vault_key: Uint8Array): VaultKeys {
  if (vault_key.length !== KEY_BYTES) throw new PrivateCryptoError("A vault key is 32 bytes", "bad_vault_key");
  return {
    vault_id,
    content: subkey(vault_key, "content"),
    path: subkey(vault_key, "path"),
    mac: subkey(vault_key, "mac"),
  };
}

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function unbase32(text: string): Uint8Array {
  const clean = text.toLowerCase().replace(/[\s-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const character of clean) {
    const index = BASE32.indexOf(character);
    if (index === -1) throw new PrivateCryptoError("That is not a recovery key", "bad_recovery_key");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): Uint8Array {
  const nonce = random_bytes(NONCE_BYTES);
  return concat(nonce, gcm(key, nonce, utf8(aad)).encrypt(plaintext));
}

function open(key: Uint8Array, sealed: Uint8Array, aad: string, code: string): Uint8Array {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new PrivateCryptoError("Sealed data is too short", code);
  try {
    return gcm(key, sealed.subarray(0, NONCE_BYTES), utf8(aad)).decrypt(sealed.subarray(NONCE_BYTES));
  } catch {
    throw new PrivateCryptoError("Sealed data did not open: wrong key or changed bytes", code);
  }
}

export function path_id(keys: VaultKeys, path: string): string {
  const digest = hmac(sha256, keys.mac, utf8(`path\u0000${path.normalize("NFC").toLowerCase()}`));
  return base32(digest).slice(0, 52);
}

export function remote_path(keys: VaultKeys, path: string): string {
  return `${PRIVATE_PREFIX}${path_id(keys, path)}`;
}

export function id_of_remote(remote: string): string {
  if (!remote.startsWith(PRIVATE_PREFIX)) throw new PrivateCryptoError("Not a private note path", "bad_remote_path");
  return remote.slice(PRIVATE_PREFIX.length);
}

export function seal_path(keys: VaultKeys, path: string): string {
  const normalized = path.normalize("NFC");
  return base64url(seal(keys.path, utf8(normalized), `path|${keys.vault_id}|${path_id(keys, normalized)}`));
}

export function open_path(keys: VaultKeys, remote: string, sealed_path: string): string {
  const id = id_of_remote(remote);
  const path = text_of(open(keys.path, from_base64(sealed_path), `path|${keys.vault_id}|${id}`, "bad_sealed_path"));
  if (path_id(keys, path) !== id) throw new PrivateCryptoError("A sealed name does not belong to its note", "bad_sealed_path");
  return path;
}

export function seal_content(keys: VaultKeys, path: string, content: Uint8Array): Uint8Array {
  return concat(CONTENT_MAGIC, seal(keys.content, content, `content|${keys.vault_id}|${path_id(keys, path)}`));
}

export function open_content(keys: VaultKeys, remote: string, sealed: Uint8Array): Uint8Array {
  if (!equal(sealed.subarray(0, CONTENT_MAGIC.length), CONTENT_MAGIC)) {
    throw new PrivateCryptoError("This is not a private note", "bad_content");
  }
  return open(
    keys.content,
    sealed.subarray(CONTENT_MAGIC.length),
    `content|${keys.vault_id}|${id_of_remote(remote)}`,
    "bad_content",
  );
}

export function content_mac(keys: VaultKeys, content: Uint8Array): string {
  return hex(hmac(sha256, keys.mac, concat(utf8("content\u0000"), content)));
}

export type LockParams = Record<string, string | number>;

export function lock_aad(vault_id: string, kind: string, params: LockParams): string {
  const canonical = Object.keys(params)
    .sort()
    .map((key) => {
      const value = String(params[key]);
      return `${key.length}:${key}=${value.length}:${value}`;
    })
    .join("|");
  return `lock|v2|${vault_id}|${kind}|${canonical}`;
}

export function wrap_key(kek: Uint8Array, vault_id: string, kind: string, params: LockParams, vault_key: Uint8Array): Uint8Array {
  return seal(kek, vault_key, lock_aad(vault_id, kind, params));
}

export function unwrap_key(kek: Uint8Array, vault_id: string, kind: string, params: LockParams, wrapped: Uint8Array): Uint8Array {
  return open(kek, wrapped, lock_aad(vault_id, kind, params), "wrong_secret");
}

export async function password_kek(password: string, salt: Uint8Array, params: PasswordParams): Promise<Uint8Array> {
  return argon2id({
    password: password.normalize("NFC"),
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memory_kib,
    hashLength: KEY_BYTES,
    outputType: "binary",
  });
}

export function recovery_kek(recovery: Uint8Array): Uint8Array {
  return hkdf(sha256, recovery, new Uint8Array(0), utf8("nemu-private|recovery|v1"), KEY_BYTES);
}
