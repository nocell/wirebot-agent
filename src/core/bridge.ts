import { type AgentAuth, missingAuthMessage } from "../agent/auth.js";
import type { AgentService } from "../agent/service.js";
import type { ScheduledRunsEngine } from "../automations/engine.js";
import type { BrowserAuth } from "../miniapp/browser-auth.js";
import { errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import {
  channelTraits,
  type InboundCommand,
  type InboundMessage,
  type MessageHandler,
  type ProviderReference,
} from "./channel.js";

const introText =
  "👋 Hi, I'm Wirebot. Send me a message and I'll hand it to Claude, then stream progress and results back into this chat.";

/**
 * The single source for the user-facing command list: /help and the Telegram
 * command menu both derive from it. /continue stays hidden on purpose.
 */
export const botCommands: readonly {
  readonly command: string;
  readonly menuDescription: string;
  readonly help: string;
}[] = [
  { command: "start", menuDescription: "Set up Wirebot", help: "show setup help" },
  { command: "new", menuDescription: "Start a new session", help: "start a fresh agent session" },
  {
    command: "back",
    menuDescription: "Return to the previous session",
    help: "return to the previous agent session",
  },
  { command: "stop", menuDescription: "Stop the running turn", help: "stop the current turn" },
  {
    command: "compact",
    menuDescription: "Compact the context",
    help: "summarize earlier context and free space",
  },
  { command: "schedules", menuDescription: "List scheduled runs", help: "list scheduled runs" },
  {
    command: "status",
    menuDescription: "Show agent status",
    help: "check the agent's credential and settings",
  },
  {
    command: "web",
    menuDescription: "Open Wirebot in a browser",
    help: "get a temporary browser sign-in link",
  },
  { command: "config", menuDescription: "Open agent settings", help: "open agent settings" },
  { command: "help", menuDescription: "Show commands", help: "show this help" },
];

/** Commands that act on one conversation rather than the whole Wirebot instance. */
export const conversationScopedCommands: ReadonlySet<string> = new Set([
  "new",
  "back",
  "stop",
  "compact",
  "schedules",
  // Internal action used by scheduled-run notification buttons.
  "continue",
]);

/** Commands that change shared instance state and require provider-admin gating. */
export const instanceAdminCommands: ReadonlySet<string> = new Set(["config", "web"]);

/** Denial for instance-admin commands; connectors reuse it where they intercept /config. */
export const instanceAdminOnlyText =
  "This command changes Wirebot for everyone using it and is limited to its admins.";

function helpText(channel: string): string {
  return [
    "Send me a message to work with Claude in this conversation.",
    "",
    ...botCommands.map((entry) => `${commandText(channel, entry.command)} — ${entry.help}`),
  ].join("\n");
}

function readyText(channel: string): string {
  return `Try something like "explain what this project does", or send ${commandText(channel, "help")} for all commands.`;
}

/** Live view of the agent's credential and model, for /start and /status. */
export interface AgentStatusSource {
  auth(): AgentAuth;
  modelSummary(): string;
}

export class WirebotBridge {
  readonly #agent: AgentService;
  readonly #browserAuth: BrowserAuth | undefined;
  readonly #publicUrl: string | undefined;
  readonly #logger: Logger;
  readonly #status: AgentStatusSource;
  readonly #scheduledRuns: ScheduledRunsEngine;

  public readonly handleMessage: MessageHandler = async (message) => {
    try {
      // Command parsing is owned by the channel; the bridge trusts message.command.
      const command = message.command;
      if (command === undefined) {
        if (this.#status.auth().kind === "none") {
          await message.responder.sendText(missingAuthMessage);
          return;
        }
        await this.runUserTurn(message);
        return;
      }
      await this.handleCommand(message, command);
    } catch (error) {
      this.#logger.error("Bridge command failed", error, {
        channel: message.address.channel,
        conversation: message.address.key,
      });
      await message.responder.sendText(`Agent error: ${errorMessage(error)}`);
    } finally {
      await this.disposeMessage(message);
    }
  };

  public constructor(
    agent: AgentService,
    publicUrl: string | undefined,
    logger: Logger,
    status: AgentStatusSource,
    scheduledRuns: ScheduledRunsEngine,
    browserAuth?: BrowserAuth,
  ) {
    this.#agent = agent;
    this.#publicUrl = publicUrl;
    this.#browserAuth = browserAuth;
    this.#logger = logger;
    this.#status = status;
    this.#scheduledRuns = scheduledRuns;
  }

  private async runUserTurn(message: InboundMessage): Promise<void> {
    if (message.address.isGuest) {
      await this.#agent.runTurn(
        message.address.key,
        message.address.channel,
        message.text,
        message.responder,
        true,
        message.attachments,
        {},
        message.syntheticText === true,
        message.requestText,
      );
      return;
    }
    const owner = messageOwner(message);
    const additionalContext = await this.#scheduledRuns.contextForReply(
      message.replyTo,
      owner,
      messageConversation(message),
    );
    await this.#agent.runTurn(
      message.address.key,
      message.address.channel,
      message.text,
      message.responder,
      false,
      message.attachments,
      {
        owner,
        ...(message.react === undefined ? {} : { reactToMessage: message.react }),
        ...(message.address.deliveryTarget === undefined
          ? {}
          : { deliveryTarget: message.address.deliveryTarget }),
        ...(additionalContext === undefined ? {} : { additionalContext }),
      },
      message.syntheticText === true,
      message.requestText,
    );
  }

  private async handleCommand(message: InboundMessage, command: InboundCommand): Promise<void> {
    if (instanceAdminCommands.has(command.name) && !message.isAdmin) {
      await message.responder.sendText(instanceAdminOnlyText);
      return;
    }
    switch (command.name) {
      case "start":
        await this.handleStart(message);
        return;
      case "help":
        await message.responder.sendText(helpText(message.address.channel));
        return;
      case "new":
        await this.#agent.resetConversation(message.address.key);
        await message.responder.sendText(
          channelTraits(message.address.channel).restartCarriesHistory && !message.address.isPrivate
            ? "Started a fresh session. Your next message will carry this conversation's earlier messages as context, without the previous session's memory. What should we work on?"
            : "Started a fresh session. What should we work on?",
        );
        return;
      case "back": {
        const threadId = await this.#agent.activatePreviousConversationThread(
          message.address.key,
          message.address.channel,
        );
        await message.responder.sendText(
          threadId === undefined
            ? "There is no previous session in this conversation."
            : "Returned to the previous session.",
        );
        return;
      }
      case "stop": {
        const stopped = await this.#agent.interrupt(message.address.key);
        await message.responder.sendText(
          stopped ? "Stopping the current turn." : "Nothing is running.",
        );
        return;
      }
      case "compact": {
        const compacted = await this.#agent.compactConversation(
          message.address.key,
          message.address.channel,
          message.responder,
          {
            owner: messageOwner(message),
            ...(message.address.deliveryTarget === undefined
              ? {}
              : { deliveryTarget: message.address.deliveryTarget }),
          },
        );
        if (!compacted) {
          await message.responder.sendText("There is no session to compact yet.");
        }
        return;
      }
      case "status":
        await message.responder.sendText(this.statusText());
        return;
      case "schedules":
        await this.handleSchedules(message);
        return;
      case "continue":
        await this.handleContinueRun(message, command.args);
        return;
      case "web":
        await this.openBrowserApp(message);
        return;
      case "config":
        if (message.address.channel !== "telegram") {
          await this.openBrowserApp(message);
          return;
        }
        if (!(await this.requirePrivateChat(message))) return;
        if (this.#publicUrl === undefined) {
          await message.responder.sendText(
            "The settings Mini App is disabled. Set PUBLIC_URL to its public HTTPS origin, or leave WIREBOT_TUNNEL=auto and restart with network access for an automatic quick tunnel.",
          );
          return;
        }
        await message.responder.sendText("Open the Mini App to edit agent settings.", {
          button: {
            label: "Open settings",
            kind: "webApp",
            url: `${this.#publicUrl}/miniapp`,
          },
        });
        return;
      default:
        await message.responder.sendText(
          `Unknown command ${commandText(message.address.channel, command.name)}.\n\n${helpText(message.address.channel)}`,
        );
    }
  }

  private async openBrowserApp(message: InboundMessage): Promise<void> {
    if (!(await this.requirePrivateChat(message))) return;
    if (this.#publicUrl === undefined || this.#browserAuth === undefined) {
      await message.responder.sendText(
        "Browser sign-in needs a public URL. Set PUBLIC_URL to your HTTPS origin, or enable WIREBOT_TUNNEL=auto and restart.",
      );
      return;
    }
    const deliveryTarget = message.address.deliveryTarget;
    if (deliveryTarget === undefined) {
      await message.responder.sendText("This messenger does not support browser sign-in yet.");
      return;
    }
    const token = await this.#browserAuth.issue({
      owner: messageOwner(message),
      conversation: messageConversation(message),
      deliveryTarget,
    });
    // Fragments are omitted from HTTP requests, including preview fetches.
    const url = `${this.#publicUrl}/app#login=${token}`;
    await message.responder.sendText(
      "Sign in to Wirebot in your browser. This private link works once and expires in 5 minutes. Your browser session lasts 12 hours.",
      {
        button: { label: "Open Wirebot", kind: "url", url },
      },
    );
  }

  private async handleSchedules(message: InboundMessage): Promise<void> {
    const automations = this.#scheduledRuns.listForConversation(
      messageOwner(message),
      messageConversation(message),
    );
    if (automations.length === 0) {
      await message.responder.sendText(
        "No scheduled runs yet. Ask something like “check the build every weekday at 9”.",
      );
      return;
    }
    await message.responder.sendText(
      automations
        .map(
          (automation) =>
            `${automation.status === "active" ? "▶️" : "⏸"} ${automation.name}\n${automation.kind} · ${automation.schedule.rrule}\nNext: ${automation.nextRunAt ?? "not scheduled"}${automation.deferralReason === null ? "" : `\nReason: ${automation.deferralReason}`}\nID: ${automation.id}`,
        )
        .join("\n\n"),
    );
  }

  private async handleContinueRun(message: InboundMessage, runId: string): Promise<void> {
    if (runId.trim().length === 0) {
      await message.responder.sendText("This scheduled-run link is incomplete.");
      return;
    }
    const result = await this.#scheduledRuns.continueRun(
      messageOwner(message),
      messageConversation(message),
      runId.trim(),
    );
    await message.responder.sendText(
      result.changed
        ? `Continuing “${result.automationName}”. Subsequent messages will use that session. Send ${commandText(message.address.channel, "back")} to return.`
        : `“${result.automationName}” is already the active session.`,
    );
  }

  private async handleStart(message: InboundMessage): Promise<void> {
    const auth = this.#status.auth();
    const readyLine =
      auth.kind === "none"
        ? missingAuthMessage
        : `✅ Connected to Claude through ${auth.description} — you're ready to go.\n\n${readyText(message.address.channel)}`;
    await message.responder.sendText(`${introText}\n\n${readyLine}`);
  }

  private async disposeMessage(message: InboundMessage): Promise<void> {
    await message.dispose?.().catch((error: unknown) => {
      this.#logger.debug("Could not release inbound message resources", {
        channel: message.address.channel,
        conversation: message.address.key,
        error: errorMessage(error),
      });
    });
  }

  private async requirePrivateChat(message: InboundMessage): Promise<boolean> {
    if (isPrivate(message)) return true;
    await message.responder.sendText("This command is available in a private bot chat only.");
    return false;
  }

  private statusText(): string {
    const auth = this.#status.auth();
    if (auth.kind === "none") return missingAuthMessage;
    return `Claude is reached through ${auth.description}.\nModel: ${this.#status.modelSummary()}`;
  }
}

function isPrivate(message: InboundMessage): boolean {
  return message.address.isPrivate && !message.address.isGuest;
}

function messageOwner(message: InboundMessage): ProviderReference {
  return {
    provider: message.address.channel,
    resource: "user",
    id: message.sender.id,
  };
}

function messageConversation(message: InboundMessage): ProviderReference {
  return {
    provider: message.address.channel,
    resource: "conversation",
    id: message.address.key,
  };
}

function commandText(channel: string, command: string): string {
  return channelTraits(channel).commandText(command);
}
