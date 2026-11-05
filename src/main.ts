import { Notice, Platform, Plugin } from "obsidian";
import { poll_code, request_code, type DeviceCode } from "./auth.js";
import { obsidian_http } from "./http.js";
import { describe_vault, open_linked, unlock_with, type LinkedVault } from "./link.js";
import { LocalStore } from "./local.js";
import { ObsidianStorage } from "./obsidian-storage.js";
import { ensure_device, Session } from "./session.js";
import { NemuSettingTab } from "./settings-tab.js";
import { list_vaults, type RemoteVault } from "./sync/api.js";
import { run_sync, type SyncReport } from "./sync/engine.js";
import type { SyncState } from "./sync/state.js";

export const VERSION = "1.0.0";
const DEFAULT_API_URL = "https://app.nemu.cc";
const CHANGE_DELAY_MS = 20_000;

export interface PluginSettings {
  api_url: string;
  link: LinkedVault | null;
  interval_minutes: number;
  sync_config: boolean;
  states: Record<string, SyncState>;
}

const DEFAULTS: PluginSettings = {
  api_url: DEFAULT_API_URL,
  link: null,
  interval_minutes: 5,
  sync_config: false,
  states: {},
};

export type Status =
  | { kind: "idle"; at: Date | null }
  | { kind: "syncing" }
  | { kind: "locked" }
  | { kind: "signed_out" }
  | { kind: "unlinked" }
  | { kind: "failed"; message: string };

export default class NemuSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULTS };
  local!: LocalStore;
  session!: Session;
  status: Status = { kind: "idle", at: null };
  private vault_key: Uint8Array | null = null;
  private status_item!: HTMLElement;
  private running: Promise<SyncReport | null> | null = null;
  private interval_id: number | null = null;
  private change_timer: number | null = null;
  private last_failure: string | null = null;

  async onload(): Promise<void> {
    const loaded: unknown = await this.loadData();
    this.settings = { ...DEFAULTS, ...(typeof loaded === "object" && loaded !== null ? loaded : {}) };
    const app_id: unknown = Reflect.get(this.app, "appId");
    this.local = new LocalStore(typeof app_id === "string" && app_id.length > 0 ? app_id : this.app.vault.getName());
    this.session = new Session(obsidian_http, this.local);
    this.session.device_id = this.local.device_id();
    if (this.settings.link !== null) this.vault_key = this.local.vault_key(this.settings.link.vault_id);
    this.status_item = this.addStatusBarItem();
    this.addSettingTab(new NemuSettingTab(this.app, this));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.sync_now(false) });
    this.addCommand({ id: "lock-vault", name: "Lock vault", callback: () => this.lock() });
    this.registerEvent(this.app.vault.on("modify", () => this.schedule_after_change()));
    this.registerEvent(this.app.vault.on("create", () => this.schedule_after_change()));
    this.registerEvent(this.app.vault.on("delete", () => this.schedule_after_change()));
    this.registerEvent(this.app.vault.on("rename", () => this.schedule_after_change()));
    this.restart_interval();
    this.refresh_status();
    this.app.workspace.onLayoutReady(() => void this.sync_now(false, true));
  }

  onunload(): void {
    if (this.change_timer !== null) window.clearTimeout(this.change_timer);
    this.vault_key = null;
  }

  async save_settings(): Promise<void> {
    await this.saveData(this.settings);
  }

  device_name(): string {
    const kind = Platform.isIosApp
      ? "iPhone or iPad"
      : Platform.isAndroidApp
        ? "Android"
        : Platform.isMacOS
          ? "Mac"
          : Platform.isWin
            ? "Windows"
            : "Linux";
    return `Obsidian on ${kind}`.slice(0, 64);
  }

  client_label(): string {
    return `nemu-obsidian/${VERSION} ${this.device_name()}`.replace(/[^\x20-\x7e]/g, "").slice(0, 64);
  }

  restart_interval(): void {
    if (this.interval_id !== null) window.clearInterval(this.interval_id);
    this.interval_id = null;
    if (this.settings.interval_minutes <= 0) return;
    this.interval_id = window.setInterval(() => void this.sync_now(false, true), this.settings.interval_minutes * 60_000);
    this.registerInterval(this.interval_id);
  }

  private schedule_after_change(): void {
    if (this.settings.link === null || this.settings.interval_minutes <= 0) return;
    if (this.change_timer !== null) window.clearTimeout(this.change_timer);
    this.change_timer = window.setTimeout(() => {
      this.change_timer = null;
      void this.sync_now(false, true);
    }, CHANGE_DELAY_MS);
  }

  is_locked(): boolean {
    return this.settings.link?.mode === "private" && this.vault_key === null;
  }

  is_key_kept(): boolean {
    return this.settings.link !== null && this.local.vault_key(this.settings.link.vault_id) !== null;
  }

  refresh_status(): void {
    const status: Status = !this.session.is_signed_in()
      ? { kind: "signed_out" }
      : this.settings.link === null
        ? { kind: "unlinked" }
        : this.is_locked()
          ? { kind: "locked" }
          : this.status;
    const label =
      status.kind === "syncing"
        ? "Nemu: syncing"
        : status.kind === "locked"
          ? "Nemu: locked"
          : status.kind === "signed_out"
            ? "Nemu: signed out"
            : status.kind === "unlinked"
              ? "Nemu: no vault linked"
              : status.kind === "failed"
                ? "Nemu: sync failed"
                : status.at === null
                  ? "Nemu: ready"
                  : `Nemu: synced ${status.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    this.status_item.setText(label);
    this.status_item.setAttr("aria-label", status.kind === "failed" ? status.message : label);
  }

  async start_sign_in(on_code: (code: DeviceCode) => void, signal: AbortSignal): Promise<void> {
    const api_url = this.settings.api_url.replace(/\/+$/, "");
    const code = await request_code(obsidian_http, api_url);
    on_code(code);
    const credentials = await poll_code(obsidian_http, api_url, code, signal);
    this.session.sign_in(credentials);
    this.session.device_id = null;
    const device = await ensure_device(this.session.transport(), null, this.device_name(), VERSION);
    this.local.set_device_id(device);
    this.session.device_id = device;
    this.refresh_status();
  }

  sign_out(): void {
    this.lock();
    this.session.sign_out();
    this.local.set_device_id(null);
    this.session.device_id = null;
    this.refresh_status();
  }

  async vaults(): Promise<RemoteVault[]> {
    return list_vaults(this.session.transport());
  }

  async link(vault: RemoteVault): Promise<void> {
    if (this.settings.link !== null && this.settings.link.vault_id !== vault.id) {
      this.lock();
      delete this.settings.states[this.local.install_id()];
    }
    this.settings.link = await describe_vault(
      this.session.transport(),
      vault.id,
      this.settings.api_url.replace(/\/+$/, ""),
    );
    await this.save_settings();
    this.refresh_status();
  }

  async unlink(): Promise<void> {
    this.lock();
    this.settings.link = null;
    delete this.settings.states[this.local.install_id()];
    await this.save_settings();
    this.refresh_status();
  }

  async unlock(method: "password" | "recovery", secret: string, keep: boolean): Promise<void> {
    const link = this.settings.link;
    if (link === null || link.mode !== "private") return;
    const key = await unlock_with(this.session.transport(link.workspace_id), link.vault_id, method, secret);
    this.vault_key = key;
    this.local.keep_vault_key(link.vault_id, keep ? key : null);
    this.refresh_status();
  }

  lock(): void {
    const link = this.settings.link;
    if (link !== null) this.local.keep_vault_key(link.vault_id, null);
    this.vault_key = null;
    this.refresh_status();
  }

  sync_now(allow_deletes: boolean, quiet = false): Promise<SyncReport | null> {
    this.running ??= this.sync_once(allow_deletes, quiet).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async sync_once(allow_deletes: boolean, quiet: boolean): Promise<SyncReport | null> {
    const link = this.settings.link;
    if (link === null || !this.session.is_signed_in() || this.is_locked()) {
      if (!quiet) new Notice(this.is_locked() ? "Unlock the vault in the Nemu Sync settings first." : "Sign in and link a vault in the Nemu Sync settings first.");
      this.refresh_status();
      return null;
    }
    this.status = { kind: "syncing" };
    this.refresh_status();
    try {
      const device = await ensure_device(this.session.transport(), this.local.device_id(), this.device_name(), VERSION);
      this.local.set_device_id(device);
      this.session.device_id = device;
      const opened = await open_linked(this.session.transport(link.workspace_id), link, this.client_label(), this.vault_key);
      const install = this.local.install_id();
      const report = await run_sync({
        storage: new ObsidianStorage(this.app.vault.adapter, this.app.vault.configDir),
        root: this.app.vault.getName(),
        api: opened.api,
        state: {
          read: async () => this.settings.states[install] ?? null,
          write: async (state) => {
            this.settings.states[install] = state;
            await this.save_settings();
          },
        },
        device: this.device_name(),
        allow_deletes,
        settings: { obsidian: this.settings.sync_config },
      });
      this.status = { kind: "idle", at: new Date() };
      this.last_failure = null;
      const changes =
        report.pulled.length + report.pushed.length + report.merged.length + report.deleted_local.length + report.deleted_remote.length;
      if (report.conflicts.length > 0) {
        new Notice(`Nemu: ${report.conflicts.length} conflict${report.conflicts.length === 1 ? "" : "s"}. Your version was kept beside each note as a conflict copy.`);
      }
      if (report.blocked !== null) new Notice(`Nemu: uploads stopped. ${report.blocked.message}`);
      if (!quiet) new Notice(changes === 0 ? "Nemu: everything is in sync." : `Nemu: synced ${changes} change${changes === 1 ? "" : "s"}.`);
      return report;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status = { kind: "failed", message };
      if (!quiet || message !== this.last_failure) new Notice(`Nemu: ${message}`);
      this.last_failure = message;
      return null;
    } finally {
      this.refresh_status();
    }
  }
}
