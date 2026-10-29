import { resolve } from "node:path";
import { z } from "zod";
import type { LogLevel } from "../shared/logger.js";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(20).optional(),
  TELEGRAM_ALLOWED_USER_IDS: z.string().min(1).optional(),
  TELEGRAM_API_BASE: z.url().default("https://api.telegram.org"),
  TELEGRAM_POLL_TIMEOUT: z.coerce.number().int().min(1).max(50).default(30),
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-").optional(),
  SLACK_APP_TOKEN: z.string().startsWith("xapp-").optional(),
  SLACK_ALLOWED_USER_IDS: z.string().min(1).optional(),
  SLACK_ADMIN_USER_IDS: z.string().min(1).optional(),
  DISCORD_BOT_TOKEN: z.string().min(20).optional(),
  DISCORD_ALLOWED_USER_IDS: z.string().min(1).optional(),
  DISCORD_ADMIN_USER_IDS: z.string().min(1).optional(),
  PUBLIC_URL: z
    .url()
    .refine((value) => new URL(value).protocol === "https:", "PUBLIC_URL must use HTTPS")
    .optional(),
  WIREBOT_TUNNEL: z.enum(["auto", "off"]).default("auto"),
  WIREBOT_CONTAINER: z.enum(["0", "1"]).default("0"),
  WIREBOT_DATA_DIR: z.string().min(1).default(".wirebot"),
  WIREBOT_ASSETS_DIR: z.string().min(1).optional(),
  WIREBOT_WORKSPACE: z.string().min(1).default(".wirebot/workspace"),
  /** Path to the Claude Code binary; defaults to the one bundled with the Agent SDK. */
  WIREBOT_CLAUDE_EXECUTABLE: z.string().min(1).optional(),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /**
   * Optional Slack token the agent may use to read Slack history on request.
   * Bridge-only as a variable: the bridge hands it to the agent as a file
   * (see agent/slack-token.ts) so the subprocess credential scrub stays on.
   * It may be the bot token itself or a separate read-only app's token.
   */
  WIREBOT_SLACK_READ_TOKEN: z.string().startsWith("xox").optional(),
});

/**
 * Bridge-owned variables (credentials and channel wiring) that must never
 * reach agent/npm/cloudflared subprocess environments. Kept next to the
 * schema so a new secret variable is scrubbed in the same edit that adds it;
 * `externalProcessEnvironment` in shared/environment.ts consumes this set.
 */
export const bridgeOnlyEnvironmentKeys: ReadonlySet<keyof z.infer<typeof envSchema>> = new Set([
  "DISCORD_ADMIN_USER_IDS",
  "DISCORD_ALLOWED_USER_IDS",
  "DISCORD_BOT_TOKEN",
  "PUBLIC_URL",
  "SLACK_ADMIN_USER_IDS",
  "SLACK_ALLOWED_USER_IDS",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_IDS",
  "TELEGRAM_API_BASE",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_POLL_TIMEOUT",
  "WIREBOT_SLACK_READ_TOKEN",
] as const);

export interface SlackConfig {
  readonly botToken: string;
  readonly appToken: string;
  /** Empty when {@link allowAllWorkspaceMembers} is on. */
  readonly allowedUserIds: ReadonlySet<string>;
  /** `SLACK_ALLOWED_USER_IDS=*`: every regular member of the workspace. */
  readonly allowAllWorkspaceMembers: boolean;
  /** When set, instance-wide commands (config, restart…) are limited to these users. */
  readonly adminUserIds: ReadonlySet<string> | undefined;
}

export interface TelegramConfig {
  readonly botToken: string;
  readonly allowedUserIds: ReadonlySet<number>;
}

export interface DiscordConfig {
  readonly botToken: string;
  readonly allowedUserIds: ReadonlySet<string>;
  /** When set, instance-wide commands (config, restart…) are limited to these users. */
  readonly adminUserIds: ReadonlySet<string> | undefined;
}

export interface AppConfig {
  readonly telegram: TelegramConfig | undefined;
  readonly telegramApiBase: string;
  readonly telegramPollTimeout: number;
  readonly slack: SlackConfig | undefined;
  readonly discord: DiscordConfig | undefined;
  readonly publicUrl: string | undefined;
  readonly tunnelMode: "auto" | "off";
  readonly container: boolean;
  readonly dataDirectory: string;
  readonly assetsDirectory: string | undefined;
  readonly workspace: string;
  readonly claudeExecutable: string | undefined;
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  /** Token the agent may use to read Slack history, from WIREBOT_SLACK_READ_TOKEN. */
  readonly slackReadToken: string | undefined;
}

export function loadAppConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(environment);
  const telegram = telegramConfigFromParsed(parsed);
  const slack = slackConfigFromParsed(parsed);
  const discord = discordConfigFromParsed(parsed);
  if (telegram === undefined && slack === undefined && discord === undefined) {
    throw new Error(
      "Configure at least one connector: Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USER_IDS), Slack (SLACK_BOT_TOKEN + SLACK_APP_TOKEN + SLACK_ALLOWED_USER_IDS), or Discord (DISCORD_BOT_TOKEN + DISCORD_ALLOWED_USER_IDS)",
    );
  }

  return {
    telegram,
    telegramApiBase: parsed.TELEGRAM_API_BASE.replace(/\/$/, ""),
    telegramPollTimeout: parsed.TELEGRAM_POLL_TIMEOUT,
    slack,
    discord,
    publicUrl: parsed.PUBLIC_URL?.replace(/\/$/, ""),
    tunnelMode: parsed.WIREBOT_TUNNEL,
    container: parsed.WIREBOT_CONTAINER === "1",
    dataDirectory: resolve(parsed.WIREBOT_DATA_DIR),
    assetsDirectory:
      parsed.WIREBOT_ASSETS_DIR === undefined ? undefined : resolve(parsed.WIREBOT_ASSETS_DIR),
    workspace: resolve(parsed.WIREBOT_WORKSPACE),
    claudeExecutable:
      parsed.WIREBOT_CLAUDE_EXECUTABLE === undefined
        ? undefined
        : resolve(parsed.WIREBOT_CLAUDE_EXECUTABLE),
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    slackReadToken: parsed.WIREBOT_SLACK_READ_TOKEN,
  };
}

function telegramConfigFromParsed(parsed: z.infer<typeof envSchema>): TelegramConfig | undefined {
  const fields = [parsed.TELEGRAM_BOT_TOKEN, parsed.TELEGRAM_ALLOWED_USER_IDS];
  if (fields.every((field) => field === undefined)) return undefined;
  if (fields.some((field) => field === undefined)) {
    throw new Error(
      "The Telegram connector needs TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_IDS set together",
    );
  }
  const allowedUserIds = new Set(
    (parsed.TELEGRAM_ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((part) => z.coerce.number().int().positive().safe().parse(part.trim())),
  );
  return { botToken: parsed.TELEGRAM_BOT_TOKEN ?? "", allowedUserIds };
}

function slackConfigFromParsed(parsed: z.infer<typeof envSchema>): SlackConfig | undefined {
  const fields = [parsed.SLACK_BOT_TOKEN, parsed.SLACK_APP_TOKEN, parsed.SLACK_ALLOWED_USER_IDS];
  if (fields.every((field) => field === undefined)) {
    if (parsed.SLACK_ADMIN_USER_IDS !== undefined) {
      throw new Error("SLACK_ADMIN_USER_IDS requires the Slack connector to be configured");
    }
    return undefined;
  }
  if (fields.some((field) => field === undefined)) {
    throw new Error(
      "The Slack connector needs SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_ALLOWED_USER_IDS set together",
    );
  }
  const adminUserIds =
    parsed.SLACK_ADMIN_USER_IDS === undefined
      ? undefined
      : parseSlackUserIds(parsed.SLACK_ADMIN_USER_IDS);
  if ((parsed.SLACK_ALLOWED_USER_IDS ?? "").trim() === "*") {
    return {
      botToken: parsed.SLACK_BOT_TOKEN ?? "",
      appToken: parsed.SLACK_APP_TOKEN ?? "",
      allowedUserIds: new Set(),
      allowAllWorkspaceMembers: true,
      adminUserIds,
    };
  }
  return {
    botToken: parsed.SLACK_BOT_TOKEN ?? "",
    appToken: parsed.SLACK_APP_TOKEN ?? "",
    allowedUserIds: parseSlackUserIds(parsed.SLACK_ALLOWED_USER_IDS ?? ""),
    allowAllWorkspaceMembers: false,
    adminUserIds,
  };
}

function parseSlackUserIds(raw: string): ReadonlySet<string> {
  return new Set(
    raw.split(",").map((part) =>
      z
        .string()
        .regex(
          /^[UW][A-Z0-9]{2,}$/u,
          "Slack user IDs look like U0123ABCDEF, or * for every workspace member",
        )
        .parse(part.trim().toUpperCase()),
    ),
  );
}

function discordConfigFromParsed(parsed: z.infer<typeof envSchema>): DiscordConfig | undefined {
  const fields = [parsed.DISCORD_BOT_TOKEN, parsed.DISCORD_ALLOWED_USER_IDS];
  if (fields.every((field) => field === undefined)) {
    if (parsed.DISCORD_ADMIN_USER_IDS !== undefined) {
      throw new Error("DISCORD_ADMIN_USER_IDS requires the Discord connector to be configured");
    }
    return undefined;
  }
  if (fields.some((field) => field === undefined)) {
    throw new Error(
      "The Discord connector needs DISCORD_BOT_TOKEN and DISCORD_ALLOWED_USER_IDS set together",
    );
  }
  return {
    botToken: parsed.DISCORD_BOT_TOKEN ?? "",
    allowedUserIds: parseDiscordUserIds(parsed.DISCORD_ALLOWED_USER_IDS ?? ""),
    adminUserIds:
      parsed.DISCORD_ADMIN_USER_IDS === undefined
        ? undefined
        : parseDiscordUserIds(parsed.DISCORD_ADMIN_USER_IDS),
  };
}

function parseDiscordUserIds(raw: string): ReadonlySet<string> {
  return new Set(
    raw.split(",").map((part) =>
      z
        .string()
        .regex(
          /^\d{15,20}$/u,
          "Discord user IDs are numeric snowflakes, such as 123456789012345678",
        )
        .parse(part.trim()),
    ),
  );
}
