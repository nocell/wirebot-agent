import type { ApplicationContext } from "../../agent/context.js";
import type { AgentInvocationContext } from "../../agent/service.js";
import { parseSlackDeliveryTarget } from "./references.js";

/**
 * Tell the agent which Slack conversation a turn came from, so the bundled
 * `slack-history` skill can resolve "this thread" or "this channel". Only
 * used when the operator set WIREBOT_SLACK_READ_TOKEN.
 */
export function slackAgentContext(
  connector: string,
  invocation: AgentInvocationContext,
): ApplicationContext | undefined {
  if (connector !== "slack" || invocation.deliveryTarget === undefined) return undefined;
  let target: ReturnType<typeof parseSlackDeliveryTarget>;
  try {
    target = parseSlackDeliveryTarget(invocation.deliveryTarget);
  } catch {
    return undefined;
  }
  const requester =
    invocation.owner?.provider === "slack" && invocation.owner.resource === "user"
      ? invocation.owner.id
      : undefined;
  const kind =
    target.channelType === "im"
      ? "a direct message with the bot"
      : target.channelType === "mpim"
        ? "a group direct message"
        : target.channelType === "group"
          ? "a private channel"
          : "a public channel";
  const lines = [
    "Slack read access: the file named by the environment variable WIREBOT_SLACK_TOKEN_FILE holds a Slack token, and the built-in `slack-history` skill reads Slack with it.",
    `This turn came from ${kind}: channel \`${target.channel}\`${
      target.threadTs === undefined ? "" : `, thread \`${target.threadTs}\``
    }.`,
    ...(requester === undefined ? [] : [`The requesting Slack user is \`${requester}\`.`]),
    "Use the skill when the user refers to this thread or channel, pastes a Slack link, or asks about Slack discussions. Read only what the request needs, never post or change anything with the token, never print it, and do not read another person's direct messages with the bot.",
  ];
  return {
    "wirebot.slack-location": { kind: "application", value: lines.join("\n") },
  };
}
