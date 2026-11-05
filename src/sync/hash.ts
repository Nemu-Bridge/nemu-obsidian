import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "../bytes.js";

export type Hasher = (content: Uint8Array) => string;

export function hash_of(content: Uint8Array): string {
  return hex(sha256(content));
}
