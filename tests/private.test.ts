import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { text_of, utf8 } from "../src/bytes.js";
import { open_linked, unlock_with, type LinkedVault } from "../src/link.js";
import {
  content_mac,
  open_content,
  open_path,
  path_id,
  remote_path,
  seal_content,
  seal_path,
  vault_keys,
} from "../src/private/crypto.js";
import { run_sync } from "../src/sync/engine.js";
import type { SyncState } from "../src/sync/state.js";
import { FakeServer } from "./fake-server.js";
import { MemoryStorage } from "./memory-storage.js";

const CLI = join(homedir(), ".nemu-dev", "packages", "cli", "src", "vault", "private");
const cli = await import(join(CLI, "crypto.ts"));
const cli_locks = await import(join(CLI, "locks.ts"));

const VAULT = "22222222-2222-4222-8222-222222222222";
const KEY = new Uint8Array(32).map((_, index) => index + 1);
const ours = vault_keys(VAULT, KEY);
const theirs = cli.vault_keys(VAULT, Buffer.from(KEY));
const PATH = "Journal/Ünïcode Day.md";

describe("private vault format, against the Nemu CLI", () => {
  test("names, ids and content checks are the same", () => {
    expect(path_id(ours, PATH)).toBe(cli.path_id(theirs, PATH));
    expect(remote_path(ours, PATH)).toBe(cli.remote_path(theirs, PATH));
    expect(content_mac(ours, utf8("hello"))).toBe(cli.content_mac(theirs, Buffer.from("hello")));
  });

  test("what the plugin seals, the CLI opens", () => {
    const remote = remote_path(ours, PATH);
    expect(cli.open_path(theirs, remote, seal_path(ours, PATH))).toBe(PATH);
    const opened = cli.open_content(theirs, remote, Buffer.from(seal_content(ours, PATH, utf8("secret text"))));
    expect(opened.toString("utf8")).toBe("secret text");
  });

  test("what the CLI seals, the plugin opens", () => {
    const remote = cli.remote_path(theirs, PATH);
    expect(open_path(ours, remote, cli.seal_path(theirs, PATH))).toBe(PATH);
    expect(text_of(open_content(ours, remote, cli.seal_content(theirs, PATH, Buffer.from("from the cli"))))).toBe("from the cli");
  });

  test("a changed byte or the wrong key does not open", () => {
    const remote = remote_path(ours, PATH);
    const sealed = seal_content(ours, PATH, utf8("x"));
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 1;
    expect(() => open_content(ours, remote, sealed)).toThrow("bad_content");
    const other = vault_keys(VAULT, new Uint8Array(32));
    expect(() => open_content(other, remote, seal_content(ours, PATH, utf8("x")))).toThrow("bad_content");
  });
});

describe("unlocking with the locks the CLI makes", () => {
  const server = new FakeServer(VAULT, "private");

  test("the vault password opens it and a wrong one does not", async () => {
    const lock = await cli_locks.password_lock(VAULT, Buffer.from(KEY), "correct horse battery staple 42");
    server.locks.push({ id: "lock-password", ...lock });
    const key = await unlock_with(server.transport(), VAULT, "password", "correct horse battery staple 42");
    expect([...key]).toEqual([...KEY]);
    await expect(unlock_with(server.transport(), VAULT, "password", "wrong password here")).rejects.toThrow(
      "That is not the vault password.",
    );
  }, 30_000);

  test("the recovery key opens it, typed with or without dashes", async () => {
    const recovery = Buffer.from(new Uint8Array(32).map((_, index) => 200 - index));
    server.locks.push({ id: "lock-recovery", ...cli_locks.recovery_lock(VAULT, Buffer.from(KEY), recovery) });
    const formatted = cli.format_recovery(recovery);
    expect([...(await unlock_with(server.transport(), VAULT, "recovery", formatted))]).toEqual([...KEY]);
    expect([...(await unlock_with(server.transport(), VAULT, "recovery", formatted.replace(/-/g, "").toLowerCase()))]).toEqual([...KEY]);
    await expect(
      unlock_with(server.transport(), VAULT, "recovery", cli.format_recovery(Buffer.alloc(32, 7))),
    ).rejects.toThrow("That recovery key does not open this vault.");
  });
});

describe("syncing a private vault", () => {
  const link = (mode: "standard" | "private"): LinkedVault => ({ vault_id: VAULT, vault_name: "Journal", api_url: "x", workspace_id: null, mode });

  test("only sealed data reaches the server, and another device reads it back", async () => {
    const server = new FakeServer(VAULT, "private");
    const run = async (storage: MemoryStorage, holder: { state: SyncState | null }) => {
      const opened = await open_linked(server.transport(), link("private"), "test", KEY);
      return run_sync({
        storage,
        root: "r",
        api: opened.api,
        state: { read: async () => holder.state, write: async (state) => { holder.state = structuredClone(state); } },
        device: "Laptop",
        quiet_ms: 0,
      });
    };
    const laptop = new MemoryStorage();
    laptop.put(PATH, "dear diary\n");
    await run(laptop, { state: null });
    const stored = [...server.notes.values()][0]!;
    expect(stored.path).toBe(remote_path(ours, PATH));
    expect(text_of(stored.content)).not.toContain("dear diary");
    expect(stored.sealed_path).toBeDefined();
    expect(text_of(cli.open_content(theirs, stored.path, Buffer.from(stored.content)))).toBe("dear diary\n");
    const phone = new MemoryStorage();
    await run(phone, { state: null });
    expect(phone.text(PATH)).toBe("dear diary\n");
  });

  test("a vault whose mode changed, or a locked one, syncs nothing", async () => {
    const private_server = new FakeServer(VAULT, "private");
    await expect(open_linked(private_server.transport(), link("standard"), "test", null)).rejects.toThrow("now reports");
    await expect(open_linked(private_server.transport(), link("private"), "test", null)).rejects.toThrow("is locked");
    const standard_server = new FakeServer(VAULT, "standard");
    await expect(open_linked(standard_server.transport(), link("private"), "test", KEY)).rejects.toThrow("now reports");
    await expect(open_linked(standard_server.transport(), link("standard"), "test", KEY)).rejects.toThrow("now reports");
    const opened = await open_linked(standard_server.transport(), link("standard"), "test", null);
    expect(opened.is_private).toBe(false);
  });
});
