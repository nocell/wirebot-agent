import {
  type AgentConfigAccess,
  type AgentConfigSnapshot,
  permissionModeLabels,
} from "../agent/config.js";
import { effortLevels, permissionModes } from "../core/settings-store.js";
import { errorMessage } from "../shared/errors.js";

export type { AgentConfigAccess } from "../agent/config.js";

export type ChannelConfigSnapshot = AgentConfigSnapshot;

export const configFieldKeys = ["model", "auto_mode", "effort", "permission_mode"] as const;

export type ConfigFieldKey = (typeof configFieldKeys)[number];

export const fieldLabels: Readonly<Record<ConfigFieldKey, string>> = {
  model: "Model",
  auto_mode: "Auto effort",
  effort: "Effort",
  permission_mode: "Permissions",
};

export const fieldNotes: Partial<Record<ConfigFieldKey, string>> = {
  auto_mode:
    "Pick an effort for every message from its wording: simple questions Low/Medium, tasks High/Extra high, deep research and debugging Max. Your selected model stays the same.",
  effort: "Choosing a manual effort turns Auto effort off.",
  permission_mode:
    "In the Docker container the container itself is the isolation boundary, so full access is the default. Approval prompts arrive in the chat that started the turn; scheduled runs never prompt.",
};

export const defaultOptionValue = "__default__";

export interface FieldOption {
  readonly value: string | null;
  readonly label: string;
}

export function fieldKey(candidate: string | undefined): ConfigFieldKey | undefined {
  return configFieldKeys.find((key) => key === candidate);
}

export function displayValue(snapshot: ChannelConfigSnapshot, field: ConfigFieldKey): string {
  const { settings } = snapshot;
  switch (field) {
    case "auto_mode":
      return settings.autoMode ? "On" : "Off";
    case "model":
      return (
        snapshot.models.find((model) => model.value === (settings.model ?? "default"))
          ?.displayName ??
        settings.model ??
        "Default"
      );
    case "effort":
      return settings.autoMode ? "Auto" : (settings.effort ?? "default");
    case "permission_mode":
      return permissionModeLabels[settings.permissionMode ?? snapshot.defaultPermissionMode];
  }
}

export function fieldOptions(
  snapshot: ChannelConfigSnapshot,
  field: ConfigFieldKey,
): FieldOption[] {
  switch (field) {
    case "auto_mode":
      return [
        { value: "true", label: "On" },
        { value: "false", label: "Off" },
      ];
    case "model":
      return snapshot.models.map((candidate) => ({
        value: candidate.value === "default" ? null : candidate.value,
        label: candidate.displayName,
      }));
    case "effort": {
      const model = snapshot.models.find(
        (candidate) => candidate.value === (snapshot.settings.model ?? "default"),
      );
      return [
        ...(model?.efforts ?? effortLevels).map((effort) => ({ value: effort, label: effort })),
        { value: null, label: "default (model default)" },
      ];
    }
    case "permission_mode":
      return [
        ...permissionModes.map((mode) => ({ value: mode, label: permissionModeLabels[mode] })),
        {
          value: null,
          label: `default (${permissionModeLabels[snapshot.defaultPermissionMode]})`,
        },
      ];
  }
}

export interface ConfigFieldLine {
  readonly key: ConfigFieldKey;
  readonly label: string;
  readonly value: string;
}

/** Channel-neutral overview screen; connectors add their own markup. */
export interface ConfigOverviewModel {
  readonly title: string;
  readonly status?: string;
  readonly fields: readonly ConfigFieldLine[];
  readonly warnings: readonly string[];
  readonly footer: string;
}

export function overviewModel(
  snapshot: ChannelConfigSnapshot,
  status?: string,
): ConfigOverviewModel {
  return {
    title: "Agent settings",
    ...(status === undefined ? {} : { status }),
    fields: configFieldKeys.map((key) => ({
      key,
      label: fieldLabels[key],
      value: displayValue(snapshot, key),
    })),
    warnings:
      snapshot.auth.kind === "none" ? ["⚠️ The agent has no Claude credential configured."] : [],
    footer: "Everyone using this Wirebot shares these settings.",
  };
}

export interface ConfigPickerOption {
  /** Display label; the currently selected option carries a "✓ " prefix. */
  readonly label: string;
  /** Value for `applyConfigValue`: `defaultOptionValue` or URI-encoded. */
  readonly encodedValue: string;
}

/** Channel-neutral picker screen for one field; connectors add a Back control. */
export interface ConfigPickerModel {
  readonly field: ConfigFieldKey;
  readonly label: string;
  readonly currentValue: string;
  readonly note?: string;
  readonly options: readonly ConfigPickerOption[];
}

export function pickerModel(
  snapshot: ChannelConfigSnapshot,
  field: ConfigFieldKey,
): ConfigPickerModel {
  const note = fieldNotes[field];
  const { settings } = snapshot;
  const current =
    field === "auto_mode"
      ? String(settings.autoMode)
      : field === "model"
        ? settings.model
        : field === "effort"
          ? settings.autoMode
            ? undefined
            : settings.effort
          : settings.permissionMode;
  return {
    field,
    label: fieldLabels[field],
    currentValue: displayValue(snapshot, field),
    ...(note === undefined ? {} : { note }),
    options: fieldOptions(snapshot, field).map((option) => ({
      label: `${option.value === current ? "✓ " : ""}${option.label}`,
      encodedValue: option.value === null ? defaultOptionValue : encodeURIComponent(option.value),
    })),
  };
}

/** Apply a picker selection through the agent settings and describe the outcome. */
export async function applyConfigValue(
  config: AgentConfigAccess,
  field: ConfigFieldKey,
  encoded: string,
): Promise<string> {
  const value = encoded === defaultOptionValue ? null : decodeURIComponent(encoded);
  try {
    switch (field) {
      case "auto_mode":
        if (value !== "true" && value !== "false") throw new Error("Invalid Auto effort value");
        await config.update({ autoMode: value === "true" });
        return `✅ Auto effort ${value === "true" ? "enabled" : "disabled"}.`;
      case "model":
        await config.update({ model: value });
        return "✅ Model updated.";
      case "effort": {
        const before = await config.read();
        await config.update({ effort: value, autoMode: false });
        return before.settings.autoMode
          ? "✅ Effort updated. Auto effort disabled."
          : "✅ Effort updated.";
      }
      case "permission_mode":
        await config.update({ permissionMode: value });
        return "✅ Permissions updated.";
    }
  } catch (error) {
    return `⚠️ ${errorMessage(error)}`;
  }
}
