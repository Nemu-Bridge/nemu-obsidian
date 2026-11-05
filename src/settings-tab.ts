import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type NemuSyncPlugin from "./main.js";
import type { RemoteVault } from "./sync/api.js";

const INTERVALS: Record<string, string> = {
  "0": "Only when I choose Sync now",
  "1": "Every minute",
  "5": "Every 5 minutes",
  "15": "Every 15 minutes",
  "60": "Every hour",
};

function message_of(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class NemuSettingTab extends PluginSettingTab {
  private sign_in: AbortController | null = null;
  private vaults: RemoteVault[] | null = null;
  private secret = "";
  private keep = false;

  constructor(
    app: App,
    private readonly plugin: NemuSyncPlugin,
  ) {
    super(app, plugin);
  }

  hide(): void {
    this.sign_in?.abort();
    this.sign_in = null;
    this.secret = "";
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.account(containerEl);
    if (!this.plugin.session.is_signed_in()) return;
    this.vault(containerEl);
    if (this.plugin.settings.link === null) return;
    if (this.plugin.settings.link.mode === "private") this.private_vault(containerEl);
    this.syncing(containerEl);
  }

  private account(container: HTMLElement): void {
    new Setting(container).setName("Account").setHeading();
    const credentials = this.plugin.session.credentials();
    if (credentials !== null) {
      new Setting(container)
        .setName("Signed in")
        .setDesc(`To ${credentials.api_url}. This device is listed under Context, Devices in the console.`)
        .addButton((button) =>
          button.setButtonText("Sign out").onClick(() => {
            this.plugin.sign_out();
            this.vaults = null;
            this.display();
          }),
        );
      return;
    }
    new Setting(container)
      .setName("Nemu server")
      .setDesc("Leave this as it is unless you run your own Nemu.")
      .addText((text) =>
        text.setValue(this.plugin.settings.api_url).onChange(async (value) => {
          this.plugin.settings.api_url = value.trim();
          await this.plugin.save_settings();
        }),
      );
    const status = container.createDiv({ cls: "nemu-sync-sign-in" });
    new Setting(container)
      .setName("Sign in")
      .setDesc("Opens Nemu in your browser and shows a code to confirm there.")
      .addButton((button) =>
        button
          .setButtonText(this.sign_in === null ? "Sign in" : "Cancel")
          .setCta()
          .onClick(async () => {
            if (this.sign_in !== null) {
              this.sign_in.abort();
              this.sign_in = null;
              this.display();
              return;
            }
            const controller = new AbortController();
            this.sign_in = controller;
            button.setButtonText("Cancel");
            try {
              await this.plugin.start_sign_in((code) => {
                status.empty();
                status.createEl("p", { text: "Confirm this code in the browser:" });
                status.createEl("p", { text: code.user_code, cls: "nemu-sync-code" });
                const link = status.createEl("a", { text: "Open the sign in page", href: code.verification_uri_complete ?? code.verification_uri });
                link.setAttr("target", "_blank");
                window.open(code.verification_uri_complete ?? code.verification_uri);
              }, controller.signal);
              new Notice("Nemu: signed in.");
            } catch (error) {
              if (!controller.signal.aborted) new Notice(`Nemu: ${message_of(error)}`);
            } finally {
              this.sign_in = null;
              this.display();
            }
          }),
      );
  }

  private vault(container: HTMLElement): void {
    new Setting(container).setName("Vault").setHeading();
    const link = this.plugin.settings.link;
    if (link !== null) {
      new Setting(container)
        .setName(`Linked to ${link.vault_name}`)
        .setDesc(
          link.mode === "private"
            ? "A private vault: notes are sealed on this device before they are sent."
            : "Notes sync with this vault in Nemu.",
        )
        .addButton((button) =>
          button.setButtonText("Unlink").onClick(async () => {
            await this.plugin.unlink();
            this.display();
          }),
        );
      return;
    }
    const setting = new Setting(container)
      .setName("Choose a vault")
      .setDesc("This Obsidian vault will sync with the Nemu vault you choose. Files already here are kept and uploaded.");
    if (this.vaults === null) {
      setting.addButton((button) =>
        button.setButtonText("Load vaults").onClick(async () => {
          try {
            this.vaults = await this.plugin.vaults();
          } catch (error) {
            new Notice(`Nemu: ${message_of(error)}`);
          }
          this.display();
        }),
      );
      return;
    }
    if (this.vaults.length === 0) {
      setting.setDesc("This workspace has no vault yet. Create one under Context, Vaults in the console.");
      return;
    }
    let chosen = this.vaults[0]?.id ?? "";
    setting.addDropdown((dropdown) => {
      for (const vault of this.vaults ?? []) {
        dropdown.addOption(vault.id, vault.mode === "private" ? `${vault.name} (private)` : vault.name);
      }
      dropdown.setValue(chosen).onChange((value) => {
        chosen = value;
      });
    });
    setting.addButton((button) =>
      button
        .setButtonText("Link")
        .setCta()
        .onClick(async () => {
          const vault = this.vaults?.find((entry) => entry.id === chosen);
          if (vault === undefined) return;
          await this.plugin.link(vault);
          this.display();
        }),
    );
  }

  private private_vault(container: HTMLElement): void {
    new Setting(container).setName("Private vault").setHeading();
    if (!this.plugin.is_locked()) {
      new Setting(container)
        .setName("Unlocked on this device")
        .setDesc(
          this.plugin.is_key_kept()
            ? "The vault key is kept on this device until you lock it."
            : "The vault key is kept in memory until Obsidian closes.",
        )
        .addButton((button) =>
          button.setButtonText("Lock").onClick(() => {
            this.plugin.lock();
            this.display();
          }),
        );
      return;
    }
    new Setting(container)
      .setName("Vault password or recovery key")
      .setDesc("Not your Nemu password. Nemu never sees it.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text.setValue(this.secret).onChange((value) => {
          this.secret = value;
        });
      });
    new Setting(container)
      .setName("Keep it unlocked on this device")
      .setDesc("Stores the vault key on this device, outside the vault, until you lock it. Otherwise you unlock again after Obsidian restarts.")
      .addToggle((toggle) =>
        toggle.setValue(this.keep).onChange((value) => {
          this.keep = value;
        }),
      );
    new Setting(container).addButton((button) =>
      button
        .setButtonText("Unlock")
        .setCta()
        .onClick(async () => {
          const secret = this.secret.trim();
          if (secret.length === 0) return;
          const method = /^[a-z2-7]{52}$/i.test(secret.replace(/[\s-]/g, "")) ? "recovery" : "password";
          button.setDisabled(true).setButtonText("Unlocking");
          try {
            await this.plugin.unlock(method, method === "recovery" ? secret : this.secret, this.keep);
            this.secret = "";
            new Notice("Nemu: unlocked.");
          } catch (error) {
            new Notice(`Nemu: ${message_of(error)}`);
          }
          this.display();
        }),
    );
  }

  private syncing(container: HTMLElement): void {
    new Setting(container).setName("Sync").setHeading();
    new Setting(container)
      .setName("Sync automatically")
      .setDesc("Also syncs about 20 seconds after you change a file.")
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(INTERVALS)) dropdown.addOption(value, label);
        dropdown.setValue(String(this.plugin.settings.interval_minutes)).onChange(async (value) => {
          this.plugin.settings.interval_minutes = Number(value);
          await this.plugin.save_settings();
          this.plugin.restart_interval();
        });
      });
    new Setting(container)
      .setName("Sync Obsidian settings")
      .setDesc(`Includes ${this.app.vault.configDir} without its plugins, which never sync, because plugins are code Obsidian runs.`)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.sync_config).onChange(async (value) => {
          this.plugin.settings.sync_config = value;
          await this.plugin.save_settings();
        }),
      );
    new Setting(container)
      .setName("Sync now")
      .setDesc("A sync that would delete most of the vault stops and deletes nothing. If you really deleted those files, sync and allow deletes.")
      .addButton((button) =>
        button
          .setButtonText("Sync now")
          .setCta()
          .onClick(async () => {
            await this.plugin.sync_now(false);
            this.display();
          }),
      )
      .addButton((button) =>
        button.setButtonText("Sync and allow deletes").setWarning().onClick(async () => {
          await this.plugin.sync_now(true);
          this.display();
        }),
      );
  }
}
