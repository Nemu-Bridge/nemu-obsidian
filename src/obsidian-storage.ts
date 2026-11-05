import type { DataAdapter } from "obsidian";
import type { Listing, Storage } from "./sync/files.js";

function adapter_path(path: string): string {
  return path === "" ? "/" : path;
}

function buffer_of(content: Uint8Array): ArrayBuffer {
  return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
}

export class ObsidianStorage implements Storage {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly config_dir: string,
  ) {}

  async list(folder: string): Promise<Listing> {
    const listed = await this.adapter.list(adapter_path(folder));
    return {
      files: listed.files.map((path) => path.replace(/^\/+/, "")),
      folders: listed.folders.map((path) => path.replace(/^\/+/, "")),
    };
  }

  async size(path: string): Promise<number | null> {
    const stat = await this.adapter.stat(path);
    if (stat === null) return null;
    return stat.type === "file" ? stat.size : 0;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const stat = await this.adapter.stat(path);
    if (stat === null || stat.type !== "file") return null;
    return new Uint8Array(await this.adapter.readBinary(path));
  }

  async write(path: string, content: Uint8Array): Promise<void> {
    await this.adapter.writeBinary(path, buffer_of(content));
  }

  async remove(path: string): Promise<void> {
    await this.adapter.remove(path);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.adapter.rename(from, to);
  }

  async mkdir(path: string): Promise<void> {
    await this.adapter.mkdir(path);
  }

  async rmdir(path: string): Promise<boolean> {
    const listed = await this.adapter.list(path);
    if (listed.files.length > 0 || listed.folders.length > 0) return false;
    await this.adapter.rmdir(path, false);
    return true;
  }

  is_hidden_folder(path: string): boolean {
    return this.config_dir !== ".obsidian" && path === this.config_dir;
  }
}
