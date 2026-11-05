import { SyncError } from "../errors.js";
import {
  RemoteError,
  type FetchedNote,
  type RemoteNote,
  type RemoteVersion,
  type VaultApi,
  type VaultClient,
  type VaultInfo,
} from "../sync/api.js";
import {
  content_mac,
  open_content,
  open_path,
  remote_path,
  seal_content,
  seal_path,
  type VaultKeys,
} from "./crypto.js";

function unreadable(): SyncError {
  return new SyncError(
    "A note in this private vault did not open with the key on this device. Nothing was changed. Lock the vault in the Nemu Sync settings, then unlock it again.",
    "private_key_mismatch",
  );
}

export class PrivateVaultApi implements VaultClient {
  readonly vault_id: string;

  constructor(
    private readonly inner: VaultApi,
    private readonly keys: VaultKeys,
  ) {
    this.vault_id = inner.vault_id;
  }

  hash(content: Uint8Array): string {
    return content_mac(this.keys, content);
  }

  private plain_path(remote: string, sealed: string | undefined): string {
    if (sealed === undefined) throw unreadable();
    try {
      return open_path(this.keys, remote, sealed);
    } catch {
      throw unreadable();
    }
  }

  private plain(note: RemoteNote): RemoteNote {
    const { sealed_path, ...rest } = note;
    return { ...rest, path: this.plain_path(note.path, sealed_path) };
  }

  private async guard<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof RemoteError && error.current !== undefined && error.current !== null) {
        throw new RemoteError(
          error.message,
          error.code,
          error.status ?? 0,
          this.plain(error.current),
          error.reference,
        );
      }
      throw error;
    }
  }

  async info(): Promise<VaultInfo> {
    return this.inner.info();
  }

  async notes(trash = false): Promise<{ revision: number; notes: RemoteNote[] }> {
    const listed = await this.inner.notes(trash);
    return { revision: listed.revision, notes: listed.notes.map((note) => this.plain(note)) };
  }

  async changes(since: number): Promise<{ notes: RemoteNote[]; revision: number; has_more: boolean }> {
    const page = await this.inner.changes(since);
    return { ...page, notes: page.notes.map((note) => this.plain(note)) };
  }

  async read(path: string): Promise<FetchedNote> {
    const remote = remote_path(this.keys, path);
    const fetched = await this.guard(() => this.inner.read(remote));
    try {
      return { ...fetched, content: open_content(this.keys, remote, fetched.content) };
    } catch {
      throw unreadable();
    }
  }

  async write(path: string, content: Uint8Array, base_version: number | null): Promise<RemoteNote> {
    const remote = remote_path(this.keys, path);
    const written = await this.guard(() =>
      this.inner.write(remote, seal_content(this.keys, path, content), base_version, {
        sealed_path: seal_path(this.keys, path),
        content_hash: content_mac(this.keys, content),
      }),
    );
    return this.plain(written);
  }

  async remove(path: string, version: number): Promise<RemoteNote> {
    const removed = await this.guard(() => this.inner.remove(remote_path(this.keys, path), version));
    return this.plain(removed);
  }

  async move(from: string, to: string, base_version: number): Promise<RemoteNote> {
    const current = await this.read(from);
    const moved = await this.guard(() =>
      this.inner.move(remote_path(this.keys, from), remote_path(this.keys, to), base_version, {
        sealed_path: seal_path(this.keys, to),
        content_hash: content_mac(this.keys, current.content),
        content: seal_content(this.keys, to, current.content),
      }),
    );
    return this.plain(moved);
  }

  async record_merge(): Promise<void> {
    return;
  }

  async read_version(note_id: string, version: number): Promise<Uint8Array> {
    const versions = await this.inner.history(note_id);
    const found = versions.find((entry) => entry.version === version);
    if (found === undefined) {
      throw new RemoteError("That version is not in the history any more.", "version_not_found", 404, undefined, undefined);
    }
    const sealed = await this.inner.read_version(note_id, version);
    try {
      return open_content(this.keys, found.path, sealed);
    } catch {
      throw unreadable();
    }
  }

  async history(note_id: string, limit = 200): Promise<RemoteVersion[]> {
    const versions = await this.inner.history(note_id, limit);
    return versions.map((version) => {
      const { sealed_path, ...rest } = version;
      return { ...rest, path: this.plain_path(version.path, sealed_path) };
    });
  }
}
