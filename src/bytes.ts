const encoder = new TextEncoder();
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function text_of(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

export function strict_text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function base64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    out += BASE64[(value >>> 18) & 63];
    out += BASE64[(value >>> 12) & 63];
    out += second === undefined ? "=" : BASE64[(value >>> 6) & 63];
    out += third === undefined ? "=" : BASE64[value & 63];
  }
  return out;
}

export function base64url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function from_base64(text: string): Uint8Array {
  const clean = text.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const character of clean) {
    value = (value << 6) | BASE64.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function random_bytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

export function random_hex(length: number): string {
  return hex(random_bytes(length));
}
