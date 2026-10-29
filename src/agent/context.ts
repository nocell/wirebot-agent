import { channelTraits } from "../core/channel.js";

interface ApplicationContextEntry {
  readonly value: string;
  readonly kind: "application";
}

/** Named blocks of host-provided context; later spreads override earlier keys. */
export type ApplicationContext = Readonly<Record<string, ApplicationContextEntry>>;

/** Render context blocks as tagged text, for the system prompt or a user message. */
export function renderApplicationContext(context: ApplicationContext): string {
  return Object.entries(context)
    .map(([name, entry]) => `<context name="${name}">\n${entry.value}\n</context>`)
    .join("\n\n");
}

export function createRemoteClientContext(connector: string): ApplicationContext {
  const connectorName = connectorDisplayName(connector);
  const fileDelivery = !channelTraits(connector).supportsFileDelivery
    ? `File delivery:
- This ${connectorName} connector is text-only: it cannot receive or send native file attachments.
- Keep deliverables useful inline whenever practical. If work must be saved locally, name the workspace-relative path in plain text and explain that the user needs another access path; do not promise an upload or format the path as a downloadable link.`
    : `File delivery:
- ${connectorName} can receive files as native attachments through Wirebot.
- When the user asks for a report, archive, image, or another local deliverable, save it inside the workspace and include a Markdown link to its workspace-relative path in the final response, for example \`[Download report](artifacts/report.pdf)\`. Wirebot resolves that link and uploads the file; do not use a file:// URL.
- Link only files deliberately intended for the user. Never attach secrets, credentials, environment files, authentication data, or unrelated workspace files.`;
  return {
    "wirebot.remote-client": {
      kind: "application",
      value: `This session is operated through Wirebot, a remote messaging bridge. The user reads and replies through ${connectorName} and is not present at the machine where you and your commands run. Only your final message of each turn is delivered as the reply; intermediate text is shown as transient progress.

\`react_to_last_message\` (emoji or :shortcode:): Reactions are part of the conversation. Use them at your discretion when a brief nonverbal response feels appropriate. A reaction can accompany a reply or serve as the entire response. Don't announce or explain it unless the user asks. It's also fine not to react.

Host-local UI is not visible or accessible to the user:
- Do not open browsers, GUI applications, editors, file managers, or OAuth pages as a way of handing work to the user.
- Never ask the user to visit localhost, 127.0.0.1, a file:// URL, or another host-local address. Those addresses refer to your host, not the user's device.
- You may run and access local services yourself for development and testing. Only present a URL to the user when it is reachable from their device.
- For authentication, prefer a device-code flow or a publicly reachable HTTPS flow and send the URL and code through chat. If only a local callback exists, explain the constraint and offer a remote-safe alternative such as a device flow, tunnel, or SSH port forwarding.
- Do not assume the user can see the host screen, clipboard, notifications, or spawned windows.

${fileDelivery}

When referencing code or files in replies:
- Except for deliberate attachment links described above, never format a local filesystem path as a Markdown link target; the user cannot open it. This includes workspace paths and home-relative paths.
- Refer to code with a repository-relative path and line number as inline code, for example \`src/app/main.ts:42\`.
- When you know the repository's public remote (for example on GitHub) and the relevant branch or commit, prefer a full https URL to the file and line so the reference is clickable in chat.

All normal filesystem, shell, network, permission, and project behavior remains unchanged. Wirebot changes only how the user communicates with you.`,
    },
  };
}

/** Identifies the official Wirebot container; detailed guidance lives in its bundled skill. */
export function createContainerEnvironmentContext(): ApplicationContext {
  return {
    "wirebot.environment": {
      kind: "application",
      value:
        "This session runs inside Wirebot's Ubuntu container, a dedicated machine for this user with passwordless sudo and the standard Wirebot toolset.",
    },
  };
}

export function connectorDisplayName(connector: string): string {
  const words = connector
    .trim()
    .split(/[-_\s]+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) return "a remote messaging connector";
  return words
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}
