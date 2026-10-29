import { z } from "zod";
import { JsonStore } from "../shared/json-store.js";
import type { Logger } from "../shared/logger.js";

export const effortLevels = ["low", "medium", "high", "xhigh", "max"] as const;
export const permissionModes = [
  "bypassPermissions",
  "acceptEdits",
  "default",
  "dontAsk",
  "plan",
] as const;

export type EffortSetting = (typeof effortLevels)[number];
export type PermissionModeSetting = (typeof permissionModes)[number];

const settingsShape = {
  remoteClientContext: z.boolean(),
  autoMode: z.boolean(),
  /** Claude model id or alias; null keeps Claude Code's default. */
  model: z.string().trim().min(1).max(200).nullable(),
  /** Manual effort; null keeps the model default. Ignored while autoMode is on. */
  effort: z.enum(effortLevels).nullable(),
  /** null picks the deployment default (bypass in the container, ask elsewhere). */
  permissionMode: z.enum(permissionModes).nullable(),
};

const settingsSchema = z.strictObject(settingsShape);

/** Without defaults, so an omitted key never overwrites a stored value. */
export const settingsPatchSchema = settingsSchema.partial();

const storedSettingsSchema = z.strictObject({
  ...settingsShape,
  autoMode: settingsShape.autoMode.default(true),
  model: settingsShape.model.default(null),
  effort: settingsShape.effort.default(null),
  permissionMode: settingsShape.permissionMode.default(null),
  version: z.literal(1),
});

export type WirebotSettings = z.infer<typeof settingsSchema>;

export class WirebotSettingsStore extends JsonStore<z.infer<typeof storedSettingsSchema>> {
  public constructor(path: string, logger: Logger) {
    super(
      path,
      storedSettingsSchema,
      {
        version: 1,
        remoteClientContext: true,
        autoMode: true,
        model: null,
        effort: null,
        permissionMode: null,
      },
      logger,
      "Ignoring invalid Wirebot settings",
    );
  }

  public read(): WirebotSettings {
    const { version: _version, ...settings } = this.state;
    return settings;
  }

  public async update(input: unknown): Promise<WirebotSettings> {
    const settings = settingsSchema.parse({ ...this.read(), ...settingsPatchSchema.parse(input) });
    await this.persist({ version: 1, ...settings });
    return settings;
  }
}
