# Nemu Sync for Obsidian

Syncs an Obsidian vault with a vault in [Nemu Context](https://docs.nemu.cc/context/obsidian), on
desktop and mobile, including private vaults whose notes are sealed on your device before they are
sent.

This is an alpha. It has passed its tests and a run against Nemu, but it has not yet been used
inside Obsidian by a person. Keep a copy of your notes before linking a vault you care about, and
report anything odd.

## Install with BRAT

1. Install the BRAT community plugin in Obsidian.
2. In BRAT, choose Add beta plugin and enter `Nemu-Bridge/nemu-obsidian`.
3. Enable Nemu Sync under Settings, Community plugins.

## Install by hand

1. Build it, or take `main.js`, `manifest.json` and `styles.css` from a release.
2. Copy the three files into `<your vault>/.obsidian/plugins/nemu-sync/`.
3. In Obsidian, open Settings, Community plugins, turn on community plugins if needed, and enable
   Nemu Sync.
4. Open Nemu Sync's settings, sign in, load your vaults and link one.

## Build

```bash
bun install
bun run lint
bun run test
bun run build
```

`bun run build` writes `main.js`. Do not install or build on a drive that cannot hold symbolic links.

## How it syncs

The sync engine is the Nemu CLI's (`nemu sync`), moved onto Obsidian's file API: the same three way
merge, conflict copies named `note (conflict, <device>, <date>).md`, the guard that stops a sync
that would delete most of the vault, and the same `.nemuignore` rules. Obsidian's settings folder
syncs only when you turn it on, and its plugins never sync. The sync state of this device is kept in
the plugin's own data, outside the synced files.

A private vault is unlocked with its vault password or recovery key. The key stays in memory until
Obsidian closes, or on this device until you lock it if you choose to keep it unlocked. Notes are
sealed with the same format as the Nemu CLI and the console, so all three open each other's notes.

## License

MIT
