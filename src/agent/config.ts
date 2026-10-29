import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  type EffortSetting,
  effortLevels,
  type PermissionModeSetting,
  settingsPatchSchema,
  type WirebotSettings,
  type WirebotSettingsStore,
} from "../core/settings-store.js";
import type { AgentAuth } from "./auth.js";

export interface ModelOption {
  /** Value saved in settings; "default" keeps Claude Code's default model. */
  readonly value: string;
  readonly displayName: string;
  readonly description: string;
  /** Effort levels the model accepts; empty when it does not take an effort. */
  readonly efforts: readonly EffortSetting[];
}

export interface AgentConfigSnapshot {
  readonly settings: WirebotSettings;
  readonly models: readonly ModelOption[];
  /** Permission mode in effect while `settings.permissionMode` is null. */
  readonly defaultPermissionMode: PermissionModeSetting;
  readonly auth: AgentAuth;
}

/** Narrow port the chat and web settings UIs use; easy to fake in tests. */
export interface AgentConfigAccess {
  read(): Promise<AgentConfigSnapshot>;
  update(input: unknown): Promise<AgentConfigSnapshot>;
}

export const permissionModeLabels: Readonly<Record<PermissionModeSetting, string>> = {
  bypassPermissions: "Full access — never ask",
  acceptEdits: "Accept file edits, ask for commands",
  default: "Ask before risky actions",
  dontAsk: "Only pre-approved tools, never ask",
  plan: "Plan only — no changes",
};

/** Agent settings shared by everyone using this Wirebot instance. */
export class AgentConfigService implements AgentConfigAccess {
  readonly #settings: WirebotSettingsStore;
  readonly #models: () => Promise<readonly ModelInfo[]>;
  readonly #defaultPermissionMode: PermissionModeSetting;
  readonly #auth: () => AgentAuth;

  public constructor(
    settings: WirebotSettingsStore,
    models: () => Promise<readonly ModelInfo[]>,
    defaultPermissionMode: PermissionModeSetting,
    auth: () => AgentAuth,
  ) {
    this.#settings = settings;
    this.#models = models;
    this.#defaultPermissionMode = defaultPermissionMode;
    this.#auth = auth;
  }

  public async read(): Promise<AgentConfigSnapshot> {
    return {
      settings: this.#settings.read(),
      models: (await this.#models()).map(modelOption),
      defaultPermissionMode: this.#defaultPermissionMode,
      auth: this.#auth(),
    };
  }

  /** A manual effort turns Auto effort off; choosing a model drops an effort it cannot take. */
  public async update(input: unknown): Promise<AgentConfigSnapshot> {
    const patch = settingsPatchSchema.parse(input);
    const next: Record<string, unknown> = { ...patch };
    if (patch.effort !== undefined && patch.effort !== null && patch.autoMode === undefined) {
      next.autoMode = false;
    }
    if (patch.model !== undefined) {
      const effort = patch.effort ?? this.#settings.read().effort;
      const model = (await this.#models()).find(
        (candidate) => candidate.value === (patch.model ?? "default"),
      );
      if (effort !== null && model !== undefined && !modelOption(model).efforts.includes(effort)) {
        next.effort = null;
      }
    }
    await this.#settings.update(next);
    return await this.read();
  }
}

/** Display text for the effective model and effort, for status messages. */
export function modelSummary(settings: WirebotSettings): string {
  const model = settings.model ?? "default";
  const effort = settings.autoMode ? "Auto effort" : (settings.effort ?? "default effort");
  return `${model} · ${effort}`;
}

function modelOption(model: ModelInfo): ModelOption {
  return {
    value: model.value,
    displayName: model.displayName,
    description: model.description,
    efforts:
      model.supportsEffort === false
        ? []
        : (model.supportedEffortLevels ?? (model.supportsEffort === true ? effortLevels : [])),
  };
}
