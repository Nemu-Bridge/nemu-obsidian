import { z } from "zod";

const base_schema = z.object({
  path: z.string(),
  note_id: z.string(),
  version: z.number().int(),
  hash: z.string(),
});

export type BaseEntry = z.infer<typeof base_schema>;

const settings_schema = z.object({
  conflicts: z.enum(["merge", "file"]).default("merge"),
  obsidian: z.boolean().default(false),
  obsidian_plugins: z.boolean().default(false),
});

export type DeviceSettings = z.infer<typeof settings_schema>;

const state_schema = z.object({
  version: z.literal(1),
  vault_id: z.string(),
  root: z.string(),
  cursor: z.number().int().nullable(),
  full_next: z.boolean().default(false),
  ignore_fingerprint: z.string().default(""),
  settings: settings_schema.default({ conflicts: "merge", obsidian: false, obsidian_plugins: false }),
  limits: z
    .object({ max_file_bytes: z.number(), max_storage_bytes: z.number().nullable() })
    .nullable()
    .default(null),
  files: z.record(z.string(), base_schema),
  synced_at: z.string().nullable().default(null),
});

export type SyncState = z.infer<typeof state_schema>;

export interface StateStore {
  read(): Promise<unknown>;
  write(state: SyncState): Promise<void>;
}

export function parse_state(raw: unknown): SyncState | null {
  const parsed = state_schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function empty_state(vault_id: string, root: string, settings?: Partial<DeviceSettings>): SyncState {
  return {
    version: 1,
    vault_id,
    root,
    cursor: null,
    full_next: true,
    ignore_fingerprint: "",
    settings: {
      conflicts: settings?.conflicts ?? "merge",
      obsidian: settings?.obsidian ?? false,
      obsidian_plugins: false,
    },
    limits: null,
    files: {},
    synced_at: null,
  };
}
