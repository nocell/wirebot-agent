import { existsSync } from "node:fs";
import { join } from "node:path";

export type AgentAuthKind =
  | "bedrock"
  | "vertex"
  | "foundry"
  | "authToken"
  | "apiKey"
  | "subscriptionToken"
  | "storedLogin"
  | "none";

export interface AgentAuth {
  readonly kind: AgentAuthKind;
  /** Short human description for status messages; never contains the credential. */
  readonly description: string;
  /** Usage is billed to a personal Claude subscription (Pro/Max/Team/Enterprise seat). */
  readonly subscription: boolean;
}

/**
 * Which credential the Claude Code process will pick, in its documented
 * precedence order. Wirebot never stores or forwards a claude.ai login itself:
 * the operator provides the credential through the environment or by signing
 * in to the unmodified Claude Code binary under the same config directory.
 */
export function detectAgentAuth(
  environment: NodeJS.ProcessEnv,
  configDirectory: string,
): AgentAuth {
  const set = (key: string): boolean => (environment[key] ?? "").length > 0;
  if (set("CLAUDE_CODE_USE_BEDROCK") || set("CLAUDE_CODE_USE_MANTLE")) {
    return { kind: "bedrock", description: "Amazon Bedrock", subscription: false };
  }
  if (set("CLAUDE_CODE_USE_VERTEX")) {
    return { kind: "vertex", description: "Google Cloud Agent Platform", subscription: false };
  }
  if (set("CLAUDE_CODE_USE_FOUNDRY")) {
    return { kind: "foundry", description: "Microsoft Foundry", subscription: false };
  }
  if (set("ANTHROPIC_AUTH_TOKEN")) {
    return { kind: "authToken", description: "a gateway bearer token", subscription: false };
  }
  if (set("ANTHROPIC_API_KEY")) {
    return { kind: "apiKey", description: "a Claude Console API key", subscription: false };
  }
  if (set("CLAUDE_CODE_OAUTH_TOKEN")) {
    return {
      kind: "subscriptionToken",
      description: "a Claude subscription token (claude setup-token)",
      subscription: true,
    };
  }
  if (existsSync(join(configDirectory, ".credentials.json"))) {
    return {
      kind: "storedLogin",
      description: "the Claude account signed in to Claude Code",
      subscription: true,
    };
  }
  return { kind: "none", description: "no credential", subscription: false };
}

export const missingAuthMessage =
  "The agent has no Claude credential yet. The operator sets ANTHROPIC_API_KEY (or Amazon Bedrock / Google Cloud variables) in Wirebot's environment and restarts it. On a personal single-user instance, a token from `claude setup-token` in CLAUDE_CODE_OAUTH_TOKEN also works.";
