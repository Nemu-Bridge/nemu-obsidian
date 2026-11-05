import type { Listing, Storage } from "../src/sync/files.js";
import { text_of, utf8 } from "../src/bytes.js";

export class MemoryStorage implements Storage {
  readonly files = new Map<string, Uint8Array>();
  readonly folders = new Set<string>();

  put(path: string, text: string): void {
    this.files.set(path, utf8(text));
    const segments = path.split("/").slice(0, -1);
    segments.forEach((_, index) => this.folders.add(segments.slice(0, index + 1).join("/")));
  }

  text(path: string): string | null {
    const content = this.files.get(path);
    return content === undefined ? null : text_of(content);
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  async list(folder: string): Promise<Listing> {
    const prefix = folder === "" ? "" : `${folder}/`;
    const direct = (path: string) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/");
    return {
      files: [...this.files.keys()].filter(direct),
      folders: [...this.folders].filter(direct),
    };
  }

  async size(path: string): Promise<number | null> {
    const content = this.files.get(path);
    if (content !== undefined) return content.length;
    return this.folders.has(path) ? 0 : null;
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, content: Uint8Array): Promise<void> {
    this.files.set(path, content);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    if (content === undefined) throw new Error("missing");
    if (this.files.has(to)) throw new Error("exists");
    this.files.delete(from);
    this.files.set(to, content);
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async rmdir(path: string): Promise<boolean> {
    const listing = await this.list(path);
    if (listing.files.length > 0 || listing.folders.length > 0) return false;
    this.folders.delete(path);
    return true;
  }

  is_hidden_folder(): boolean {
    return false;
  }
}
