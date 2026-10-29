import { readFile, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  type CanUseTool,
  createSdkMcpServer,
  getSessionInfo,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
  type ModelInfo,
  type Options,
  type PermissionResult,
  type Query,
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  ChoiceOption,
  InboundAttachment,
  MessageResponder,
  OutboundAttachment,
  OutboundStream,
  ProgressAction,
  ProgressPlanStep,
  ProviderReference,
} from "../core/channel.js";
import type { ConversationStore } from "../core/conversation-store.js";
import type {
  EffortSetting,
  PermissionModeSetting,
  WirebotSettings,
} from "../core/settings-store.js";
import { type Deferred, deferred, KeyedSerialQueue } from "../shared/async.js";
import { externalProcessEnvironment } from "../shared/environment.js";
import { BridgeError, errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { compactTruncate } from "../shared/text.js";
import { wirebotVersion } from "../shared/version.js";
import { autoEffort } from "./auto-effort.js";
import {
  type ApplicationContext,
  connectorDisplayName,
  createRemoteClientContext,
  renderApplicationContext,
} from "./context.js";
import { resolveOutboundAttachments, unavailableAttachmentsWarning } from "./output-files.js";
import { todoPlan, toolActionLabel } from "./progress.js";

export interface AgentInvocationContext {
  readonly reactToMessage?: (reaction: string) => Promise<void>;
  readonly owner?: ProviderReference;
  readonly deliveryTarget?: ProviderReference;
  readonly additionalContext?: ApplicationContext;
  readonly automationId?: string;
}

export interface AgentToolContext extends AgentInvocationContext {
  readonly conversationKey: string;
  readonly connector: string;
  readonly threadId: string;
  readonly turnId: string;
  /** Unique per tool call, for idempotent identifiers. */
  readonly callId: string;
}

/** A host tool the agent can call, served from Wirebot's in-process MCP server. */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  execute(argumentsValue: Record<string, unknown>, context: AgentToolContext): Promise<unknown>;
}

export interface ScheduledTurnRequest {
  readonly conversationKey: string;
  readonly connector: string;
  readonly prompt: string;
  readonly thread:
    | { readonly mode: "new"; readonly developerInstructions?: string }
    | { readonly mode: "existing"; readonly threadId: string };
  readonly invocation: AgentInvocationContext;
  readonly model?: string;
  readonly reasoningEffort?: string | null;
  readonly outputSchema?: Record<string, unknown>;
}

export interface AgentTurnResult {
  readonly threadId: string;
  readonly turnId: string;
  /** Unmodified final assistant text (or structured output JSON), before delivery warnings. */
  readonly rawText: string;
  readonly attachments: readonly OutboundAttachment[];
  readonly unavailableAttachments: readonly string[];
  dispose(): Promise<void>;
}

type BackgroundLeaseDecision =
  | { readonly acquired: true; readonly release: () => void }
  | { readonly acquired: false; readonly reason: string; readonly retryAt: Date };

export interface AgentServiceOptions {
  readonly conversations: ConversationStore;
  readonly workspace: string;
  /**
   * CLAUDE_CONFIG_DIR for the agent: settings, skills, sessions, and any stored
   * login. Undefined keeps Claude Code's default (~/.claude); on macOS an explicit
   * directory also selects a different Keychain entry for the stored login.
   */
  readonly configDirectory?: string;
  readonly outboundDirectory: string;
  /** Wirebot's bundled plugin (skills), loaded into every session. */
  readonly capabilitiesDirectory?: string;
  readonly logger: Logger;
  readonly settings: () => WirebotSettings;
  /** Permission mode used when the settings leave it unset. */
  readonly defaultPermissionMode: PermissionModeSetting;
  readonly claudeExecutable?: string;
  /** Extra variables for the agent process, for example a Slack token file path. */
  readonly agentEnvironment?: Readonly<Record<string, string>>;
  /** Static deployment-environment context added to the system prompt. */
  readonly environmentContext?: ApplicationContext;
  /** Per-turn, connector-derived context (for example where a Slack turn came from). */
  readonly conversationContext?: (
    connector: string,
    invocation: AgentInvocationContext,
  ) => ApplicationContext | undefined;
}

type TurnOrigin = "user" | "scheduled";
type TurnStatus = "completed" | "interrupted" | "failed";

interface TurnRequest {
  readonly origin: TurnOrigin;
  readonly conversationKey: string;
  readonly connector: string;
  readonly stream: OutboundStream;
  readonly responder: MessageResponder | undefined;
  readonly invocation: AgentInvocationContext;
  readonly prompt: string;
  readonly attachments: readonly InboundAttachment[];
  readonly resume: string | undefined;
  readonly persist: boolean;
  readonly model: string | null;
  readonly effort: EffortSetting | undefined;
  readonly instructions?: string;
  readonly outputSchema?: Record<string, unknown>;
  readonly compaction?: boolean;
  /** Called once the agent reports the session id the turn runs in. */
  readonly onSession?: (sessionId: string) => Promise<void>;
}

interface FinalizedTurn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly status: TurnStatus;
  readonly error: string | undefined;
  readonly finalText: string;
  readonly structuredOutput: unknown;
  readonly attachments: readonly OutboundAttachment[];
  readonly unavailableAttachments: readonly string[];
  dispose(): Promise<void>;
}

interface ActiveTurn {
  readonly turnId: string;
  readonly conversationKey: string;
  readonly origin: TurnOrigin;
  readonly invocation: AgentInvocationContext;
  readonly stop: () => Promise<void>;
}

const modelCatalogTtlMs = 10 * 60 * 1_000;
const shadowedCanUseToolWarning = "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED";
const interruptGraceMs = 15_000;

const fallbackModels: readonly ModelInfo[] = [
  { value: "default", displayName: "Default", description: "Claude Code's default model" },
  { value: "opus", displayName: "Opus", description: "Most capable for complex work" },
  { value: "sonnet", displayName: "Sonnet", description: "Fast and capable for everyday work" },
  { value: "haiku", displayName: "Haiku", description: "Fastest for simple tasks" },
];

/**
 * Runs Wirebot conversations on the Claude Agent SDK.
 *
 * Every chat turn is one `query()` against the conversation's persisted Claude
 * Code session (`resume`), so the agent process lives only while a turn runs.
 * Turns for the same conversation are serialized; host tools (reactions,
 * scheduled runs) are served per turn from an in-process MCP server whose
 * handlers already know which conversation and message they belong to.
 */
export class AgentService {
  static readonly #backgroundQuietPeriodMs = 30_000;
  readonly #queue = new KeyedSerialQueue();
  readonly #tools = new Map<string, AgentTool>();
  readonly #turns = new Map<string, ActiveTurn>();
  readonly #foregroundWaiting = new Map<string, number>();
  readonly #lastForegroundAt = new Map<string, number>();
  readonly #options: AgentServiceOptions;
  readonly #logger: Logger;
  #models: { readonly at: number; readonly models: readonly ModelInfo[] } | undefined;
  #pauseGate: Deferred<void> | undefined;
  #idleGate: Deferred<void> | undefined;
  #interruptingScheduledTurns = false;
  #runningJobs = 0;

  public constructor(options: AgentServiceOptions) {
    this.#options = options;
    this.#logger = options.logger;
    silenceShadowedCanUseToolWarning();
  }

  public pause(): void {
    this.#pauseGate ??= deferred<void>();
  }

  /** True while a turn, scheduled run, or queued message is in flight. */
  public get busy(): boolean {
    return this.#runningJobs > 0 || this.#foregroundWaiting.size > 0;
  }

  public async waitForIdle(): Promise<void> {
    if (this.#runningJobs === 0) return;
    this.#idleGate ??= deferred<void>();
    await this.#idleGate.promise;
  }

  public resume(): void {
    const gate = this.#pauseGate;
    if (gate === undefined) return;
    this.#pauseGate = undefined;
    gate.resolve();
  }

  public registerTool(agentTool: AgentTool): void {
    if (this.#tools.has(agentTool.name) || agentTool.name === "react_to_last_message") {
      throw new Error(`Agent tool ${agentTool.name} is already registered`);
    }
    this.#tools.set(agentTool.name, agentTool);
  }

  /** Models the signed-in credential can use, cached briefly; a static list when unavailable. */
  public async supportedModels(): Promise<readonly ModelInfo[]> {
    const cached = this.#models;
    if (cached !== undefined && Date.now() - cached.at < modelCatalogTtlMs) return cached.models;
    const idle = deferred<void>();
    // An input stream that never yields keeps the process in streaming-input
    // mode, where control requests such as supportedModels() are available.
    const noInput: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await idle.promise;
          return { done: true, value: undefined };
        },
      }),
    };
    const probe = query({ prompt: noInput, options: this.baseOptions(new AbortController()) });
    try {
      const models = await probe.supportedModels();
      this.#models = { at: Date.now(), models };
      return models;
    } catch (error) {
      this.#logger.warn("Could not read the Claude model catalog; using built-in aliases", {
        error: errorMessage(error),
      });
      return fallbackModels;
    } finally {
      idle.resolve();
      probe.close();
    }
  }

  public tryAcquireBackground(conversationKey: string): BackgroundLeaseDecision {
    const now = Date.now();
    const retryAt = new Date(now + AgentService.#backgroundQuietPeriodMs);
    if ((this.#foregroundWaiting.get(conversationKey) ?? 0) > 0) {
      return { acquired: false, reason: "A user message is waiting.", retryAt };
    }
    const lastForegroundAt = this.#lastForegroundAt.get(conversationKey);
    if (
      lastForegroundAt !== undefined &&
      now - lastForegroundAt < AgentService.#backgroundQuietPeriodMs
    ) {
      return {
        acquired: false,
        reason: "The conversation was used recently.",
        retryAt: new Date(lastForegroundAt + AgentService.#backgroundQuietPeriodMs),
      };
    }
    const lease = this.#queue.tryAcquire(conversationKey);
    if (lease === undefined) {
      return { acquired: false, reason: "The conversation is busy.", retryAt };
    }
    return { acquired: true, release: lease.release };
  }

  public async runTurn(
    conversationKey: string,
    connector: string,
    text: string,
    responder: MessageResponder,
    ephemeral = false,
    attachments: readonly InboundAttachment[] = [],
    invocation: AgentInvocationContext = {},
    _syntheticText = false,
    requestText?: string,
  ): Promise<void> {
    const stream = responder.createStream();
    this.incrementForegroundWaiting(conversationKey);
    let dequeued = false;
    try {
      const startsQueued = this.#queue.isBusy(conversationKey);
      if (startsQueued) {
        await stream.start({ summary: "Queued behind earlier work…", actions: [], plan: [] });
      }
      await this.#queue.run(conversationKey, async () => {
        dequeued = true;
        this.decrementForegroundWaiting(conversationKey);
        await this.enterJob();
        try {
          if (startsQueued) stream.setProgress({ summary: "Thinking…", actions: [], plan: [] });
          else await stream.start();
          const settings = this.#options.settings();
          const model = settings.model;
          const effort = settings.autoMode
            ? autoEffort(
                requestText ?? text,
                attachments.length > 0,
                await this.supportedEfforts(model),
              )
            : (settings.effort ?? undefined);
          const resume = ephemeral ? undefined : await this.storedSession(conversationKey);
          const finalized = await this.executeTurn({
            origin: "user",
            conversationKey,
            connector,
            stream,
            responder,
            invocation,
            prompt: text,
            attachments,
            resume,
            persist: !ephemeral,
            model,
            effort,
            onSession: async (sessionId) => {
              if (!ephemeral && sessionId !== resume) {
                await this.#options.conversations.set(conversationKey, sessionId);
              }
            },
          });
          if (finalized.status === "failed") {
            this.#logger.warn("Agent turn failed", {
              conversationKey,
              turnId: finalized.turnId,
              error: finalized.error,
            });
          }
        } catch (error) {
          this.#logger.error("Agent turn failed", error, { conversationKey });
          await stream.fail(errorMessage(error)).catch(() => undefined);
        } finally {
          this.#lastForegroundAt.set(conversationKey, Date.now());
          this.leaveJob();
        }
      });
    } finally {
      if (!dequeued) this.decrementForegroundWaiting(conversationKey);
    }
  }

  public async runScheduledTurn(request: ScheduledTurnRequest): Promise<AgentTurnResult> {
    await this.enterJob();
    try {
      const settings = this.#options.settings();
      const model = request.model ?? settings.model;
      const effort =
        parseEffort(request.reasoningEffort) ??
        (settings.autoMode ? undefined : (settings.effort ?? undefined));
      const finalized = await this.executeTurn({
        origin: "scheduled",
        conversationKey: request.conversationKey,
        connector: request.connector,
        stream: silentStream,
        responder: undefined,
        invocation: request.invocation,
        prompt: request.prompt,
        attachments: [],
        resume: request.thread.mode === "existing" ? request.thread.threadId : undefined,
        persist: true,
        model,
        effort,
        ...(request.thread.mode === "new" && request.thread.developerInstructions !== undefined
          ? { instructions: request.thread.developerInstructions }
          : {}),
        ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
      });
      if (finalized.status === "failed") {
        await finalized.dispose();
        throw new BridgeError(finalized.error ?? "Agent turn failed", "AGENT_TURN_FAILED");
      }
      if (finalized.status === "interrupted") {
        await finalized.dispose();
        throw new BridgeError("Scheduled agent turn was interrupted", "AGENT_TURN_INTERRUPTED");
      }
      return {
        threadId: finalized.sessionId,
        turnId: finalized.turnId,
        rawText:
          finalized.structuredOutput === undefined
            ? finalized.finalText
            : JSON.stringify(finalized.structuredOutput),
        attachments: finalized.attachments,
        unavailableAttachments: finalized.unavailableAttachments,
        dispose: finalized.dispose,
      };
    } finally {
      this.leaveJob();
    }
  }

  public async resetConversation(conversationKey: string): Promise<void> {
    await this.interrupt(conversationKey);
    await this.#options.conversations.delete(conversationKey);
  }

  public async compactConversation(
    conversationKey: string,
    connector: string,
    responder: MessageResponder,
    invocation: AgentInvocationContext = {},
  ): Promise<boolean> {
    const stored = this.#options.conversations.get(conversationKey);
    if (stored === undefined) return false;
    if (this.conversationBusy(conversationKey)) throw conversationBusyError();
    const lease = this.#queue.tryAcquire(conversationKey);
    if (lease === undefined) throw conversationBusyError();
    try {
      await this.enterJob();
      const stream = responder.createStream();
      try {
        await stream.start({ summary: "Compacting context…", actions: [], plan: [] });
        const finalized = await this.executeTurn({
          origin: "user",
          conversationKey,
          connector,
          stream,
          responder,
          invocation,
          prompt: "/compact",
          attachments: [],
          resume: stored,
          persist: true,
          model: this.#options.settings().model,
          effort: undefined,
          compaction: true,
          onSession: async (sessionId) => {
            if (sessionId !== stored) {
              await this.#options.conversations.set(conversationKey, sessionId);
            }
          },
        });
        if (finalized.status === "failed") {
          this.#logger.warn("Context compaction failed", {
            conversationKey,
            error: finalized.error,
          });
        }
      } catch (error) {
        this.#logger.error("Context compaction failed", error, { conversationKey });
        await stream.fail(errorMessage(error)).catch(() => undefined);
      } finally {
        this.#lastForegroundAt.set(conversationKey, Date.now());
        this.leaveJob();
      }
      return true;
    } finally {
      lease.release();
    }
  }

  public async activateConversationThread(
    conversationKey: string,
    _connector: string,
    threadId: string,
  ): Promise<boolean> {
    if (this.conversationBusy(conversationKey)) throw conversationBusyError();
    const lease = this.#queue.tryAcquire(conversationKey);
    if (lease === undefined) throw conversationBusyError();
    try {
      if ((await this.sessionExists(threadId)) === false) {
        throw new BridgeError(
          `Agent session ${threadId} no longer exists`,
          "AGENT_SESSION_NOT_FOUND",
        );
      }
      return await this.#options.conversations.switchTo(conversationKey, threadId);
    } finally {
      lease.release();
    }
  }

  public async activatePreviousConversationThread(
    conversationKey: string,
    connector: string,
  ): Promise<string | undefined> {
    const previous = this.#options.conversations.previous(conversationKey);
    if (previous === undefined) return undefined;
    await this.activateConversationThread(conversationKey, connector, previous);
    return previous;
  }

  public async interrupt(conversationKey: string): Promise<boolean> {
    const turns = [...this.#turns.values()].filter(
      (turn) => turn.conversationKey === conversationKey,
    );
    await Promise.all(turns.map(async (turn) => await turn.stop()));
    return turns.length > 0;
  }

  public async interruptScheduledTurns(): Promise<void> {
    this.#interruptingScheduledTurns = true;
    await Promise.all(
      [...this.#turns.values()]
        .filter((turn) => turn.invocation.automationId !== undefined)
        .map(async (turn) => await turn.stop()),
    );
  }

  private async executeTurn(request: TurnRequest): Promise<FinalizedTurn> {
    const turnId = crypto.randomUUID();
    const abort = new AbortController();
    const finished = deferred<void>();
    let sessionId = request.resume;
    let agent: Query | undefined;
    let stopped = false;
    let stopTimer: NodeJS.Timeout | undefined;

    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      stopTimer = setTimeout(() => abort.abort(), interruptGraceMs);
      stopTimer.unref();
      try {
        await agent?.interrupt();
      } catch (error) {
        this.#logger.debug("Agent interrupt failed; aborting the turn", {
          error: errorMessage(error),
        });
        abort.abort();
      }
    };
    this.#turns.set(turnId, {
      turnId,
      conversationKey: request.conversationKey,
      origin: request.origin,
      invocation: request.invocation,
      stop,
    });
    if (this.#interruptingScheduledTurns && request.invocation.automationId !== undefined) {
      stopped = true;
    }

    const actions: ProgressAction[] = [];
    let plan: readonly ProgressPlanStep[] = [];
    let streamingText = "";
    let lastAssistantText = "";
    let compacted = false;
    let result: SDKResultMessage | undefined;
    const publish = (): void => {
      request.stream.setProgress({
        ...(request.compaction === true ? { summary: "Compacting context…" } : {}),
        ...(streamingText.trim().length === 0 ? {} : { message: streamingText }),
        actions,
        plan,
      });
    };

    try {
      if (stopped) {
        return await this.finalize(request, turnId, sessionId ?? "", "interrupted", undefined, "");
      }
      const content = await this.userContent(request);
      async function* input(): AsyncGenerator<SDKUserMessage> {
        yield {
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
          ...(request.origin === "user" && request.compaction !== true
            ? { origin: { kind: "human" } as const }
            : {}),
        };
        await finished.promise;
      }
      agent = query({ prompt: input(), options: this.turnOptions(request, abort, turnId) });
      // A stop that arrived while the turn was being prepared had nothing to interrupt yet.
      if (stopped) void agent.interrupt().catch(() => abort.abort());
      for await (const message of agent) {
        if (message.type === "result") {
          result = message;
          finished.resolve();
          continue;
        }
        const reported = sessionOf(message);
        if (reported !== undefined && reported !== sessionId) {
          sessionId = reported;
          await request.onSession?.(reported);
        }
        if (message.type === "system" && message.subtype === "compact_boundary") {
          compacted = true;
        } else if (message.type === "stream_event" && message.parent_tool_use_id === null) {
          const event = message.event;
          if (event.type === "content_block_start" && event.content_block.type === "text") {
            streamingText = "";
          } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            streamingText += event.delta.text;
            publish();
          }
        } else if (message.type === "assistant" && message.parent_tool_use_id === null) {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim().length > 0) {
              lastAssistantText = block.text;
            } else if (block.type === "tool_use") {
              const todos = todoPlan(block.name, block.input);
              if (todos === undefined) actions.push(toolActionLabel(block.name, block.input));
              else plan = todos;
              streamingText = "";
              publish();
            }
          }
        } else if (message.type === "rate_limit_event") {
          const info = message.rate_limit_info;
          if (info.status !== "allowed") {
            this.#logger.warn("Claude usage limit reached or near", {
              status: info.status,
              limit: info.rateLimitType,
              resetsAt: info.resetsAt,
            });
          }
        }
      }
    } catch (error) {
      if (!stopped) {
        finished.resolve();
        return await this.finalize(
          request,
          turnId,
          sessionId ?? "",
          "failed",
          errorMessage(error),
          "",
        );
      }
    } finally {
      finished.resolve();
      if (stopTimer !== undefined) clearTimeout(stopTimer);
      this.#turns.delete(turnId);
    }

    if (stopped && (result === undefined || result.subtype !== "success")) {
      return await this.finalize(
        request,
        turnId,
        sessionId ?? "",
        "interrupted",
        undefined,
        lastAssistantText,
      );
    }
    if (result === undefined) {
      return await this.finalize(
        request,
        turnId,
        sessionId ?? "",
        "failed",
        "The agent ended without a result",
        "",
      );
    }
    if (result.subtype !== "success" || result.is_error) {
      const reason =
        result.subtype === "success"
          ? result.result
          : result.errors.length > 0
            ? result.errors.join("\n")
            : failureReason(result.subtype);
      return await this.finalize(request, turnId, sessionId ?? "", "failed", reason, "");
    }
    const finalText =
      result.result.trim().length > 0
        ? result.result
        : compacted || request.compaction === true
          ? "Context compacted."
          : lastAssistantText;
    return await this.finalize(
      request,
      turnId,
      sessionId ?? result.session_id,
      "completed",
      undefined,
      finalText,
      result.structured_output,
    );
  }

  private async finalize(
    request: TurnRequest,
    turnId: string,
    sessionId: string,
    status: TurnStatus,
    error: string | undefined,
    finalText: string,
    structuredOutput?: unknown,
  ): Promise<FinalizedTurn> {
    if (status === "failed") {
      const message = error ?? "Agent turn failed";
      if (request.origin !== "scheduled") await request.stream.fail(message);
      return {
        sessionId,
        turnId,
        status,
        error: message,
        finalText: "",
        structuredOutput: undefined,
        attachments: [],
        unavailableAttachments: [],
        dispose: async () => undefined,
      };
    }
    const stagingDirectory = join(this.#options.outboundDirectory, crypto.randomUUID());
    const resolution = await resolveOutboundAttachments(
      this.#options.workspace,
      stagingDirectory,
      finalText,
    );
    let disposed = false;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    };
    if (request.origin !== "scheduled") {
      const text =
        status === "interrupted" && finalText.length === 0
          ? "Stopped."
          : unavailableAttachmentsWarning(finalText, resolution.unavailable);
      await request.stream.complete(text, resolution.attachments);
      await dispose();
    }
    return {
      sessionId,
      turnId,
      status,
      error,
      finalText,
      structuredOutput,
      attachments: resolution.attachments,
      unavailableAttachments: resolution.unavailable,
      dispose,
    };
  }

  private baseOptions(abort: AbortController): Options {
    const options = this.#options;
    return {
      abortController: abort,
      cwd: options.workspace,
      settingSources: ["user", "project", "local"],
      env: {
        ...externalProcessEnvironment(),
        // Keep Claude credentials out of Bash commands, hooks, and MCP subprocesses.
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ?? "1",
        DISABLE_AUTOUPDATER: "1",
        ...options.agentEnvironment,
        ...(options.configDirectory === undefined
          ? {}
          : { CLAUDE_CONFIG_DIR: options.configDirectory }),
      },
      ...(options.claudeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: options.claudeExecutable }),
      ...(options.capabilitiesDirectory === undefined
        ? {}
        : { plugins: [{ type: "local", path: options.capabilitiesDirectory }] }),
      stderr: (data) => this.#logger.debug("Claude Code stderr", { data: data.trimEnd() }),
    };
  }

  private turnOptions(request: TurnRequest, abort: AbortController, turnId: string): Options {
    const permissionMode =
      request.origin === "scheduled"
        ? scheduledPermissionMode(this.permissionMode())
        : this.permissionMode();
    const systemContext = renderApplicationContext({
      ...(this.#options.settings().remoteClientContext
        ? createRemoteClientContext(request.connector)
        : {}),
      ...(this.#options.environmentContext ?? {}),
    });
    const append = [systemContext, request.instructions]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join("\n\n");
    return {
      ...this.baseOptions(abort),
      ...(request.resume === undefined ? {} : { resume: request.resume }),
      persistSession: request.persist,
      ...(request.model === null || request.model === "default" ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      permissionMode,
      ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      // Also needed under full access: without a prompt handler Claude Code
      // withholds AskUserQuestion. Questions themselves are answered by a hook,
      // which runs in every mode, while full access never consults canUseTool.
      canUseTool: this.permissionHandler(request),
      hooks: { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [this.questionHook(request)] }] },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(append.length === 0 ? {} : { append }),
      },
      mcpServers: { wirebot: this.hostToolServer(request, turnId) },
      allowedTools: ["mcp__wirebot__*"],
      includePartialMessages: true,
      ...(request.outputSchema === undefined
        ? {}
        : { outputFormat: { type: "json_schema", schema: request.outputSchema } }),
    };
  }

  private permissionMode(): PermissionModeSetting {
    return this.#options.settings().permissionMode ?? this.#options.defaultPermissionMode;
  }

  /** AskUserQuestion is answered with buttons in the chat that started the turn. */
  private questionHook(request: TurnRequest): HookCallback {
    return async (input, _toolUseId, { signal }) => {
      if (input.hook_event_name !== "PreToolUse" || !isRecord(input.tool_input)) return {};
      const answered =
        request.responder === undefined
          ? ({ behavior: "deny", message: "Nobody is attending this unattended run." } as const)
          : await askQuestions(request.responder, input.tool_input, signal);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          ...(answered.behavior === "allow"
            ? { permissionDecision: "allow", updatedInput: answered.updatedInput }
            : { permissionDecision: "deny", permissionDecisionReason: answered.message }),
        },
      };
    };
  }

  /** Approvals go to the chat that started the turn. */
  private permissionHandler(request: TurnRequest): CanUseTool {
    return async (toolName, input, { signal, suggestions, title }): Promise<PermissionResult> => {
      const responder = request.responder;
      if (responder === undefined) {
        return { behavior: "deny", message: "Nobody is attending this unattended run." };
      }
      const prompt = `${title ?? `Claude wants to use ${toolName}`}\n\n${describeToolInput(toolName, input)}`;
      const choices: ChoiceOption[] = [
        { id: "once", label: "Allow once" },
        ...(suggestions !== undefined && suggestions.length > 0
          ? [{ id: "session", label: "Allow for session" }]
          : []),
        { id: "decline", label: "Deny" },
      ];
      const answer = await responder.askChoice(prompt, choices, signal);
      if (answer === "once") return { behavior: "allow", updatedInput: input };
      if (answer === "session") {
        return {
          behavior: "allow",
          updatedInput: input,
          ...(suggestions === undefined ? {} : { updatedPermissions: suggestions }),
        };
      }
      return { behavior: "deny", message: "The user denied this action." };
    };
  }

  private hostToolServer(request: TurnRequest, turnId: string): McpSdkServerConfigWithInstance {
    const context = (callId: string): AgentToolContext => ({
      ...request.invocation,
      conversationKey: request.conversationKey,
      connector: request.connector,
      threadId: this.#options.conversations.get(request.conversationKey) ?? request.resume ?? "",
      turnId,
      callId,
    });
    const react = request.invocation.reactToMessage;
    return createSdkMcpServer({
      name: "wirebot",
      version: wirebotVersion,
      tools: [
        ...(request.origin === "user" && react !== undefined
          ? [
              tool(
                "react_to_last_message",
                "React to this turn's message with an emoji or :shortcode:.",
                { reaction: z.string().trim().min(1).max(128) },
                async ({ reaction }) => {
                  await react(reaction);
                  return { content: [{ type: "text" as const, text: "Reacted." }] };
                },
              ),
            ]
          : []),
        ...[...this.#tools.values()].map((agentTool) =>
          tool(agentTool.name, agentTool.description, agentTool.inputSchema, async (args) => {
            try {
              const value = await agentTool.execute(args, context(crypto.randomUUID()));
              return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
            } catch (error) {
              this.#logger.warn("Agent tool call failed", {
                tool: agentTool.name,
                turnId,
                error: errorMessage(error),
              });
              return {
                content: [{ type: "text" as const, text: errorMessage(error) }],
                isError: true,
              };
            }
          }),
        ),
      ],
    });
  }

  private async userContent(request: TurnRequest): Promise<SDKUserMessage["message"]["content"]> {
    if (request.compaction === true) return request.prompt;
    const turnContext = renderApplicationContext({
      ...(this.#options.conversationContext?.(request.connector, request.invocation) ?? {}),
      ...(request.invocation.additionalContext ?? {}),
    });
    const images = await Promise.all(
      request.attachments.map(async (attachment) =>
        attachment.kind === "image" ? await imageBlock(attachment.path) : undefined,
      ),
    );
    // Images the model cannot take inline are offered as workspace files instead.
    const files = request.attachments.filter((_attachment, index) => images[index] === undefined);
    const fileContext = files
      .map((file) => `- ${file.description}: ${JSON.stringify(file.path)}`)
      .join("\n");
    const text = [
      turnContext,
      fileContext.length === 0
        ? request.prompt
        : `${request.prompt}\n\n${connectorDisplayName(request.connector)} files available in the local workspace:\n${fileContext}`,
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
    return [
      { type: "text", text },
      ...images.filter((image): image is NonNullable<typeof image> => image !== undefined),
    ];
  }

  private async storedSession(conversationKey: string): Promise<string | undefined> {
    const stored = this.#options.conversations.get(conversationKey);
    if (stored === undefined) return undefined;
    if ((await this.sessionExists(stored)) !== false) return stored;
    this.#logger.warn("Stored agent session is gone; starting a new session", {
      conversationKey,
    });
    await this.#options.conversations.delete(conversationKey);
    return undefined;
  }

  /** False only when the session is definitely missing; undefined when the lookup failed. */
  private async sessionExists(sessionId: string): Promise<boolean | undefined> {
    try {
      return (await getSessionInfo(sessionId, { dir: this.#options.workspace })) !== undefined;
    } catch (error) {
      this.#logger.debug("Could not look up an agent session", { error: errorMessage(error) });
      return undefined;
    }
  }

  private async supportedEfforts(
    model: string | null,
  ): Promise<readonly EffortSetting[] | undefined> {
    const models = await this.supportedModels();
    const selected =
      models.find((candidate) => candidate.value === (model ?? "default")) ??
      models.find((candidate) => candidate.resolvedModel === model);
    if (selected === undefined || selected.supportsEffort === undefined) return undefined;
    return selected.supportsEffort ? (selected.supportedEffortLevels ?? undefined) : [];
  }

  private conversationBusy(conversationKey: string): boolean {
    return (
      (this.#foregroundWaiting.get(conversationKey) ?? 0) > 0 ||
      [...this.#turns.values()].some((turn) => turn.conversationKey === conversationKey)
    );
  }

  private incrementForegroundWaiting(conversationKey: string): void {
    this.#foregroundWaiting.set(
      conversationKey,
      (this.#foregroundWaiting.get(conversationKey) ?? 0) + 1,
    );
  }

  private decrementForegroundWaiting(conversationKey: string): void {
    const waiting = (this.#foregroundWaiting.get(conversationKey) ?? 1) - 1;
    if (waiting <= 0) this.#foregroundWaiting.delete(conversationKey);
    else this.#foregroundWaiting.set(conversationKey, waiting);
  }

  private async enterJob(): Promise<void> {
    while (this.#pauseGate !== undefined) await this.#pauseGate.promise;
    this.#runningJobs += 1;
  }

  private leaveJob(): void {
    this.#runningJobs -= 1;
    if (this.#runningJobs !== 0) return;
    const gate = this.#idleGate;
    this.#idleGate = undefined;
    gate?.resolve();
  }
}

export const silentStream: OutboundStream = {
  start: async () => undefined,
  setProgress: () => undefined,
  appendFinal: () => undefined,
  complete: async () => undefined,
  fail: async () => undefined,
};

/**
 * Full-access turns pass canUseTool only to keep AskUserQuestion enabled, so
 * the SDK's per-query warning that the callback is shadowed is expected noise.
 */
let shadowedWarningSilenced = false;
function silenceShadowedCanUseToolWarning(): void {
  if (shadowedWarningSilenced) return;
  shadowedWarningSilenced = true;
  const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const options = rest[0];
    if (isRecord(options) && options.code === shadowedCanUseToolWarning) return;
    emit(warning, ...rest);
  }) as typeof process.emitWarning;
}

function conversationBusyError(): BridgeError {
  return new BridgeError(
    "The conversation is busy. Stop or wait for the current turn first.",
    "CONVERSATION_BUSY",
  );
}

/** Unattended runs cannot answer prompts: anything not pre-approved is denied. */
function scheduledPermissionMode(mode: PermissionModeSetting): PermissionModeSetting {
  return mode === "bypassPermissions" ? mode : "dontAsk";
}

function parseEffort(value: string | null | undefined): EffortSetting | undefined {
  const parsed = z.enum(["low", "medium", "high", "xhigh", "max"]).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function sessionOf(message: SDKMessage): string | undefined {
  return "session_id" in message && typeof message.session_id === "string" && message.session_id
    ? message.session_id
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failureReason(subtype: Exclude<SDKResultMessage["subtype"], "success">): string {
  switch (subtype) {
    case "error_max_turns":
      return "The agent hit its turn limit.";
    case "error_max_budget_usd":
      return "The agent hit its budget limit.";
    case "error_max_structured_output_retries":
      return "The agent could not produce the requested structured output.";
    default:
      return "The agent stopped with an error.";
  }
}

function describeToolInput(toolName: string, input: Record<string, unknown>): string {
  const command = input.command;
  if (toolName === "Bash" && typeof command === "string") return `\`\`\`\n${command}\n\`\`\``;
  const path = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof path === "string") return `File: ${path}`;
  return `Arguments:\n${compactTruncate(JSON.stringify(input, null, 2), 1_500)}`;
}

const questionSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
        multiSelect: z.boolean().optional(),
      }),
    )
    .min(1),
});

type QuestionAnswer =
  | { readonly behavior: "allow"; readonly updatedInput: Record<string, unknown> }
  | { readonly behavior: "deny"; readonly message: string };

async function askQuestions(
  responder: MessageResponder,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<QuestionAnswer> {
  const parsed = questionSchema.safeParse(input);
  if (!parsed.success) return { behavior: "deny", message: "Unsupported question format." };
  const answers: Record<string, string> = {};
  for (const question of parsed.data.questions) {
    const options: ChoiceOption[] = question.options.map((option, index) => ({
      id: String(index),
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    }));
    const answer = await responder.askChoice(question.question, options, signal);
    const selected = question.options[Number(answer)];
    if (selected === undefined) {
      return { behavior: "deny", message: "The user dismissed the question." };
    }
    answers[question.question] = selected.label;
  }
  return { behavior: "allow", updatedInput: { ...input, answers } };
}

const imageMediaTypes: Readonly<
  Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp">
> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

async function imageBlock(path: string): Promise<
  | {
      readonly type: "image";
      readonly source: {
        readonly type: "base64";
        readonly media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
        readonly data: string;
      };
    }
  | undefined
> {
  const mediaType = imageMediaTypes[extname(path).toLowerCase()];
  if (mediaType === undefined) return undefined;
  try {
    const data = (await readFile(path)).toString("base64");
    return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  } catch {
    return undefined;
  }
}
