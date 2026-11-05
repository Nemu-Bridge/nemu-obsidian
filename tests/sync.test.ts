import { describe, expect, test } from "bun:test";
import { utf8 } from "../src/bytes.js";
import { VaultApi } from "../src/sync/api.js";
import { run_sync } from "../src/sync/engine.js";
import type { SyncState } from "../src/sync/state.js";
import { FakeServer } from "./fake-server.js";
import { MemoryStorage } from "./memory-storage.js";

const VAULT = "11111111-1111-4111-8111-111111111111";

class Device {
  readonly storage = new MemoryStorage();
  state: SyncState | null = null;

  constructor(
    readonly server: FakeServer,
    readonly name: string,
  ) {}

  sync(allow_deletes = false) {
    return run_sync({
      storage: this.storage,
      root: this.name,
      api: new VaultApi(this.server.transport(), VAULT, `test ${this.name}`),
      state: {
        read: async () => this.state,
        write: async (state) => {
          this.state = structuredClone(state);
        },
      },
      device: this.name,
      quiet_ms: 0,
      allow_deletes,
      now: () => new Date("2026-10-30T10:00:00Z"),
    });
  }
}

function pair() {
  const server = new FakeServer(VAULT);
  return { server, laptop: new Device(server, "Laptop"), phone: new Device(server, "Phone") };
}

describe("syncing an Obsidian vault", () => {
  test("a first sync uploads local notes and downloads remote ones", async () => {
    const { server, laptop } = pair();
    laptop.storage.put("ideas/lobby.md", "# Lobby\n");
    server.write("remote.md", utf8("from the server\n"));
    const report = await laptop.sync();
    expect(report.pushed).toEqual(["ideas/lobby.md"]);
    expect(report.pulled).toEqual(["remote.md"]);
    expect(server.text("ideas/lobby.md")).toBe("# Lobby\n");
    expect(laptop.storage.text("remote.md")).toBe("from the server\n");
  });

  test("a note reaches a second device", async () => {
    const { laptop, phone } = pair();
    laptop.storage.put("a.md", "one\n");
    await laptop.sync();
    await phone.sync();
    expect(phone.storage.text("a.md")).toBe("one\n");
  });

  test("edits on both devices to different lines merge cleanly", async () => {
    const { server, laptop, phone } = pair();
    laptop.storage.put("a.md", "first\nsecond\nthird\n");
    await laptop.sync();
    await phone.sync();
    laptop.storage.put("a.md", "FIRST\nsecond\nthird\n");
    phone.storage.put("a.md", "first\nsecond\nTHIRD\n");
    await laptop.sync();
    const report = await phone.sync();
    expect(report.merged).toEqual(["a.md"]);
    expect(phone.storage.text("a.md")).toBe("FIRST\nsecond\nTHIRD\n");
    expect(server.text("a.md")).toBe("FIRST\nsecond\nTHIRD\n");
    expect(server.merges.length).toBe(1);
    await laptop.sync();
    expect(laptop.storage.text("a.md")).toBe("FIRST\nsecond\nTHIRD\n");
  });

  test("edits to the same line keep both, the local one as a conflict copy", async () => {
    const { server, laptop, phone } = pair();
    laptop.storage.put("a.md", "line\n");
    await laptop.sync();
    await phone.sync();
    laptop.storage.put("a.md", "laptop\n");
    phone.storage.put("a.md", "phone\n");
    await laptop.sync();
    const report = await phone.sync();
    expect(report.conflicts.length).toBe(1);
    const copy = report.conflicts[0]!.copy;
    expect(copy).toBe("a (conflict, Phone, 2026-10-30 10-00).md");
    expect(phone.storage.text("a.md")).toBe("laptop\n");
    expect(phone.storage.text(copy)).toBe("phone\n");
    expect(server.text(copy)).toBe("phone\n");
  });

  test("a delete on one device removes the note everywhere", async () => {
    const { server, laptop, phone } = pair();
    laptop.storage.put("a.md", "a\n");
    laptop.storage.put("b.md", "b\n");
    laptop.storage.put("c.md", "c\n");
    await laptop.sync();
    await phone.sync();
    await laptop.storage.remove("a.md");
    const report = await laptop.sync();
    expect(report.deleted_remote).toEqual(["a.md"]);
    expect(server.live_paths()).toEqual(["b.md", "c.md"]);
    const pulled = await phone.sync();
    expect(pulled.deleted_local).toEqual(["a.md"]);
    expect(phone.storage.paths()).toEqual(["b.md", "c.md"]);
  });

  test("a sync that would delete most of the vault stops and deletes nothing", async () => {
    const { server, laptop } = pair();
    for (const name of ["a", "b", "c", "d", "e", "f"]) laptop.storage.put(`${name}.md`, `${name}\n`);
    await laptop.sync();
    for (const path of laptop.storage.paths()) await laptop.storage.remove(path);
    await expect(laptop.sync()).rejects.toThrow("would delete 6 of the 6");
    expect(server.live_paths().length).toBe(6);
    const allowed = await laptop.sync(true);
    expect(allowed.deleted_remote.length).toBe(6);
    expect(server.live_paths()).toEqual([]);
  });

  test("a rename moves the note on the server and on the other device", async () => {
    const { server, laptop, phone } = pair();
    laptop.storage.put("old.md", "body\n");
    await laptop.sync();
    await phone.sync();
    await laptop.storage.rename("old.md", "folder/new.md");
    laptop.storage.folders.add("folder");
    const report = await laptop.sync();
    expect(report.moved).toEqual([{ from: "old.md", to: "folder/new.md" }]);
    expect(server.live_paths()).toEqual(["folder/new.md"]);
    await phone.sync();
    expect(phone.storage.paths()).toEqual(["folder/new.md"]);
    expect(phone.storage.text("folder/new.md")).toBe("body\n");
  });

  test("Obsidian settings stay out unless asked for, and plugins never sync", async () => {
    const { server, laptop } = pair();
    laptop.storage.put(".obsidian/app.json", "{}");
    laptop.storage.put(".obsidian/plugins/nemu-sync/data.json", "{\"secret\":1}");
    laptop.storage.put("note.md", "n\n");
    await laptop.sync();
    expect(server.live_paths()).toEqual(["note.md"]);
    const configured = await run_sync({
      storage: laptop.storage,
      root: "Laptop",
      api: new VaultApi(server.transport(), VAULT, "test"),
      state: { read: async () => laptop.state, write: async (state) => { laptop.state = structuredClone(state); } },
      device: "Laptop",
      quiet_ms: 0,
      settings: { obsidian: true },
    });
    expect(configured.pushed).toContain(".obsidian/app.json");
    expect(server.live_paths()).not.toContain(".obsidian/plugins/nemu-sync/data.json");
  });
});
