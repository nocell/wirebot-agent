import { chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectAgentAuth } from "./agent/auth.js";
import { AgentConfigService, modelSummary } from "./agent/config.js";
import { createContainerEnvironmentContext } from "./agent/context.js";
import { AgentService } from "./agent/service.js";
import { ScheduledRunsEngine } from "./automations/engine.js";
import { AutomationStore } from "./automations/store.js";
import { DiscordChannel } from "./channels/discord/channel.js";
import { slackAgentContext } from "./channels/slack/agent-context.js";
import { SlackChannel } from "./channels/slack/channel.js";
import { TelegramChannel } from "./channels/telegram/channel.js";
import { type AppConfig, loadAppConfig } from "./config/env.js";
import { WirebotBridge } from "./core/bridge.js";
import type { MessagingChannel } from "./core/channel.js";
import { ConversationStore } from "./core/conversation-store.js";
import { WirebotSettingsStore } from "./core/settings-store.js";
import { BrowserAuth } from "./miniapp/browser-auth.js";
import { MiniAppServer } from "./miniapp/server.js";
import { QuickTunnel } from "./miniapp/tunnel.js";
import { deferred } from "./shared/async.js";
import { errorMessage } from "./shared/errors.js";
import { atomicWriteFile, ensureDirectory } from "./shared/fs.js";
import { Logger } from "./shared/logger.js";
import { wirebotVersion } from "./shared/version.js";

interface Stoppable {
  stop(): Promise<void>;
}

export async function runWirebot(): Promise<void> {
  const config = loadAppConfig();
  const logger = new Logger(config.logLevel, { service: "wirebot" });
  const shutdown = shutdownSignal(logger);
  const configDirectory =
    process.env.CLAUDE_CONFIG_DIR ?? join(config.dataDirectory, "claude-home");
  const outboundDirectory = join(config.dataDirectory, "outbound");
  const capabilitiesDirectory =
    process.env.WIREBOT_CAPABILITIES_DIR ??
    fileURLToPath(new URL("../capabilities", import.meta.url));
  const statePath = join(config.dataDirectory, "conversations.json");
  const settingsPath = join(config.dataDirectory, "settings.json");
  const automationsPath = join(config.dataDirectory, "automations.json");
  const resources: Stoppable[] = [];
  // SDK helpers in this process (session lookups) read the same config directory.
  process.env.CLAUDE_CONFIG_DIR = configDirectory;

  try {
    await Promise.all([
      ensureDirectory(config.dataDirectory),
      ensureDirectory(config.workspace),
      ensureDirectory(configDirectory),
      ensureDirectory(outboundDirectory),
    ]);
    const agentEnvironment: Record<string, string> = {
      WIREBOT_CAPABILITIES_DIR: resolve(capabilitiesDirectory),
      ...(config.slackReadToken === undefined
        ? {}
        : { WIREBOT_SLACK_TOKEN_FILE: await writeSlackReadToken(config) }),
    };

    const auth = () => detectAgentAuth(process.env, configDirectory);
    const initialAuth = auth();
    if (initialAuth.kind === "none") {
      logger.warn(
        "No Claude credential found. Set ANTHROPIC_API_KEY, or Amazon Bedrock / Google Cloud variables, and restart; messages are answered with setup instructions until then.",
      );
    } else if (initialAuth.subscription && sharedInstance(config)) {
      logger.warn(
        "The agent runs on a personal Claude subscription while several people can use this bot. Anthropic's terms do not allow serving other people through a Free/Pro/Max login; use an API key or a cloud provider for shared instances.",
      );
    }

    const conversations = new ConversationStore(
      statePath,
      logger.child({ component: "conversation-store" }),
    );
    const settings = new WirebotSettingsStore(
      settingsPath,
      logger.child({ component: "settings-store" }),
    );
    const automations = new AutomationStore(
      automationsPath,
      logger.child({ component: "automation-store" }),
    );
    await Promise.all([conversations.load(), settings.load(), automations.load()]);
    const defaultPermissionMode = config.container ? "bypassPermissions" : "default";
    const agent = new AgentService({
      conversations,
      workspace: config.workspace,
      configDirectory,
      outboundDirectory,
      capabilitiesDirectory: resolve(capabilitiesDirectory),
      logger: logger.child({ component: "agent" }),
      settings: () => settings.read(),
      defaultPermissionMode,
      ...(config.claudeExecutable === undefined
        ? {}
        : { claudeExecutable: config.claudeExecutable }),
      agentEnvironment,
      ...(config.container ? { environmentContext: createContainerEnvironmentContext() } : {}),
      ...(config.slackReadToken === undefined ? {} : { conversationContext: slackAgentContext }),
    });
    const configService = new AgentConfigService(
      settings,
      async () => await agent.supportedModels(),
      defaultPermissionMode,
      auth,
    );

    const authChannels = new Map<string, MessagingChannel>();
    const browserAuth = new BrowserAuth(
      (owner) => authChannels.get(owner.provider)?.isAuthorizedAdmin?.(owner) ?? false,
    );
    // The same HTTP application serves browsers and the Telegram Mini App.
    const miniApp = new MiniAppServer({
      host: config.host,
      port: config.port,
      browserAuth,
      ...(config.telegram === undefined ? {} : { telegramAuth: config.telegram }),
      configService,
      skillDirectories: [
        { source: "user", path: join(configDirectory, "skills") },
        { source: "bundled", path: join(resolve(capabilitiesDirectory), "skills") },
      ],
      logger: logger.child({ component: "miniapp" }),
      ...(config.assetsDirectory === undefined ? {} : { assetDirectory: config.assetsDirectory }),
    });
    resources.push(miniApp);
    await miniApp.start();

    let publicUrl = config.publicUrl;
    if (publicUrl === undefined && config.tunnelMode === "auto") {
      try {
        const tunnel = new QuickTunnel({
          host: config.host,
          port: config.port,
          logger: logger.child({ component: "tunnel" }),
        });
        publicUrl = await tunnel.start();
        resources.push(tunnel);
        logger.info("The Wirebot web app is exposed through a TryCloudflare quick tunnel", {
          url: publicUrl,
        });
      } catch (error) {
        logger.warn(
          "The quick tunnel failed to start and no PUBLIC_URL is set; browser sign-in links are unavailable. Set PUBLIC_URL, install cloudflared, or check outbound network access to Cloudflare.",
          { error: errorMessage(error) },
        );
      }
    }

    const telegram =
      config.telegram === undefined
        ? undefined
        : new TelegramChannel(
            config.telegram.botToken,
            config.telegramApiBase,
            config.telegram.allowedUserIds,
            config.telegramPollTimeout,
            join(config.workspace, ".wirebot", "attachments"),
            logger.child({ component: "telegram" }),
            publicUrl === undefined ? undefined : `${publicUrl}/miniapp`,
          );
    const slack =
      config.slack === undefined
        ? undefined
        : new SlackChannel(
            config.slack,
            join(config.workspace, ".wirebot", "attachments"),
            logger.child({ component: "slack" }),
            configService,
          );
    const discord =
      config.discord === undefined
        ? undefined
        : new DiscordChannel(
            config.discord,
            logger.child({ component: "discord" }),
            publicUrl === undefined ? configService : undefined,
          );
    const channels = [telegram, slack, discord].filter(
      (channel): channel is NonNullable<typeof channel> => channel !== undefined,
    );
    for (const channel of channels) authChannels.set(channel.name, channel);
    const scheduledRuns = new ScheduledRunsEngine({
      store: automations,
      agent,
      channels,
      workspace: config.workspace,
      logger: logger.child({ component: "scheduled-runs" }),
    });
    miniApp.setScheduledRuns(scheduledRuns);
    const bridge = new WirebotBridge(
      agent,
      publicUrl,
      logger.child({ component: "bridge" }),
      { auth, modelSummary: () => modelSummary(settings.read()) },
      scheduledRuns,
      browserAuth,
    );
    for (const channel of channels) {
      resources.push(channel);
      await channel.start(bridge.handleMessage);
    }
    resources.push(scheduledRuns);
    await scheduledRuns.start();

    logger.info("Wirebot is ready", {
      version: wirebotVersion,
      auth: initialAuth.kind,
      workspace: config.workspace,
      webApp: publicUrl === undefined ? `${config.host}:${config.port}/app` : `${publicUrl}/app`,
      telegram: telegram === undefined ? "disabled" : "enabled",
      slack: slack === undefined ? "disabled" : "enabled",
      discord: discord === undefined ? "disabled" : "enabled",
    });

    await shutdown.promise;
  } catch (error) {
    logger.error("Wirebot failed", error);
    throw error;
  } finally {
    shutdown.dispose();
    await stopAll(resources, logger);
  }
}

/** True when more than one person may talk to the agent through this instance. */
function sharedInstance(config: AppConfig): boolean {
  const users =
    (config.telegram?.allowedUserIds.size ?? 0) +
    (config.slack === undefined
      ? 0
      : config.slack.allowAllWorkspaceMembers
        ? 2
        : config.slack.allowedUserIds.size) +
    (config.discord?.allowedUserIds.size ?? 0);
  return users > 1;
}

/**
 * Hand the Slack read token to the agent as a private file: the subprocess
 * credential scrub would strip it from the environment of the agent's tools.
 */
async function writeSlackReadToken(config: AppConfig): Promise<string> {
  const directory = join(config.dataDirectory, "secrets");
  const path = join(directory, "slack-read-token");
  await ensureDirectory(directory);
  await chmod(directory, 0o700);
  await atomicWriteFile(path, `${config.slackReadToken ?? ""}\n`);
  await chmod(path, 0o600);
  return path;
}

function shutdownSignal(logger: Logger): {
  readonly promise: Promise<void>;
  readonly dispose: () => void;
} {
  const shutdown = deferred<void>();
  const handle = (signal: NodeJS.Signals): void => {
    dispose();
    logger.info("Shutting down", { signal });
    shutdown.resolve();
  };
  const dispose = (): void => {
    process.off("SIGINT", handle);
    process.off("SIGTERM", handle);
  };
  process.once("SIGINT", handle);
  process.once("SIGTERM", handle);
  return { promise: shutdown.promise, dispose };
}

async function stopAll(resources: readonly Stoppable[], logger: Logger): Promise<void> {
  for (const resource of resources.toReversed()) {
    try {
      await resource.stop();
    } catch (error) {
      logger.error("Shutdown step failed", error);
    }
  }
}
