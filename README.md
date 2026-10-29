# 🤖 Wirebot Agent

A Claude agent in your messenger: talk to it from Telegram, Slack, or Discord, and it works on a real machine with a shell, files, the web, and skills.

Wirebot Agent is a port of [Wirebot](https://github.com/sadfun/wirebot) by sadfun from the OpenAI Codex app-server to the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). The messenger transport, scheduled runs, and web app are Wirebot's. The agent loop, tools, sessions, skills, and context management come from Claude Code, which the Agent SDK runs as a library.

* **Telegram, Slack (Socket Mode), and text-only Discord.** Supports files in both directions, threads, approvals, commands, and scheduled notifications. No public webhook is needed.
* **A real agent experience.** It streams progress (tool calls, the agent's to-do list, interim text). Approval prompts and the agent's clarifying questions (`AskUserQuestion`) appear as buttons. Sessions persist and can be resumed, and `/compact` and `/stop` work.
* **Scheduled runs.** Describe a recurring task in plain language and the agent manages it through a host tool.
* **Auto effort.** Each message picks an effort level (low … max) from its wording, with no extra model call.
* **Skills.** It uses Claude Code skills from the agent's config directory and the project, plus bundled skills (container runtime and read-only Slack history).
* **Web app / Telegram Mini App.** Edit the shared settings, browse skills, and manage schedules.

## Can it run on a Claude subscription?

**Technically yes. By Anthropic's terms, only for yourself.**

The Agent SDK runs the unmodified Claude Code binary, which accepts every credential Claude Code does: a Claude Console API key, Amazon Bedrock, Google Cloud, Microsoft Foundry, a gateway token, or a subscription token from `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`).

Anthropic's [terms for Claude Code and the Agent SDK](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) say:

* Subscription (Free/Pro/Max) OAuth is for **ordinary, individual use**. Developers may not route requests through Free, Pro, or Max credentials **on behalf of other users**, and may not offer claude.ai login inside their products.
* Products and services built on the Agent SDK should use **API key authentication** (Claude Console or a cloud provider).

In practice:

| Instance | Credential |
|---|---|
| A personal bot that only you talk to | `CLAUDE_CODE_OAUTH_TOKEN` from your own `claude setup-token`, or an API key |
| A bot shared by a team, a workspace (`SLACK_ALLOWED_USER_IDS=*`), or anyone else | `ANTHROPIC_API_KEY` or Bedrock / Google Cloud. **Not a subscription.** |

Wirebot Agent never asks for or stores a claude.ai login itself. There is no in-chat sign-in; the operator configures the credential in the environment. At startup it logs a warning when a subscription credential is combined with more than one allowed user. This README is not legal advice: read the linked terms, and ask Anthropic if your case is unclear.

## Quick start (Docker)

```sh
mkdir wirebot && cd wirebot
curl -fsSLO https://raw.githubusercontent.com/nocell/wirebot-agent/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/nocell/wirebot-agent/main/example.env -o .env
$EDITOR .env    # one Claude credential + at least one connector
docker compose up -d
docker compose logs -f   # wait for "Wirebot is ready"
```

The image (`ghcr.io/nocell/wirebot-agent`, amd64 and arm64) is an Ubuntu machine for the agent. It runs as a non-root user with passwordless sudo. Everything worth keeping lives in the `/data` volume:

| Path | Contents |
|---|---|
| `/data/workspace` | the agent's working directory |
| `/data/claude-home` | `CLAUDE_CONFIG_DIR`: Claude Code settings, user skills, memory, sessions |
| `/data/home`, `/usr/local`, `/home/linuxbrew` | the agent's home and installed tools |

Inside the container the container is the isolation boundary, so the default permission mode is **full access** (`bypassPermissions`). Outside the container the default is **ask** (`default`). Both can be changed in settings.

There is also an interactive installer for a fresh Linux server:

```sh
curl -fsSL https://raw.githubusercontent.com/nocell/wirebot-agent/main/install.sh | sudo sh
```

## Configuration

See [`example.env`](example.env) for every variable. The essentials:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Console API key, recommended |
| `CLAUDE_CODE_USE_BEDROCK=1` (+ AWS creds/region), `CLAUDE_CODE_USE_VERTEX=1` | Cloud providers |
| `CLAUDE_CODE_OAUTH_TOKEN` | Personal subscription token, single-user instances only (see above) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS` | Telegram connector |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ALLOWED_USER_IDS`, `SLACK_ADMIN_USER_IDS` | Slack connector ([docs/slack.md](docs/slack.md)) |
| `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USER_IDS`, `DISCORD_ADMIN_USER_IDS` | Discord connector ([docs/discord.md](docs/discord.md)) |
| `PUBLIC_URL` / `WIREBOT_TUNNEL` | Public HTTPS origin for the web app, or a TryCloudflare quick tunnel |
| `WIREBOT_SLACK_READ_TOKEN` | Optional read-only Slack token for the `slack-history` skill |
| `WIREBOT_CLAUDE_EXECUTABLE` | Optional path to a separately installed `claude` binary |

Credentials never reach the agent's tools:

* Connector tokens are bridge-only and are removed from the agent's environment.
* `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (on by default) strips Claude credentials from the environments of Bash commands, hooks, and MCP servers the agent starts.
* The optional Slack read token is handed over as a `0600` file rather than an environment variable.

## Commands

| Command | |
|---|---|
| `new` | start a fresh session (`back` returns to the previous one) |
| `stop` | interrupt the running turn |
| `compact` | summarize earlier context |
| `schedules` | list scheduled runs |
| `status` | show the credential source and model |
| `config` / `web` | open settings (admins) |
| `help` | list commands |

On Telegram these are `/new` and so on. On Slack and Discord use `/wirebot new`, or mention the bot inside a thread.

## Settings

Everyone using an instance shares these settings, edited from the chat settings menu or the web app:

* **Model**: Claude Code's default or any model your credential can use, read live from the Agent SDK.
* **Auto effort / Effort**: per-message heuristic effort, or one fixed level. See [docs/auto-mode.md](docs/auto-mode.md).
* **Permissions**: full access, accept edits, ask before risky actions, only pre-approved tools, or plan only. Approval prompts appear in the chat that started the turn. Scheduled runs never prompt; anything not pre-approved is denied.
* **Remote client context**: tells the agent that the user is remote, how files are delivered, and so on.

## How it works

* Each chat turn is one Agent SDK `query()` that resumes the conversation's Claude Code session. The agent process runs only during a turn, and turns in one conversation are serialized.
* Messenger replies are the agent's final message. Tool calls and interim text stream as transient progress.
* Host tools (`react_to_last_message`, `automation_update`) come from an in-process MCP server created for each turn, so every call is already bound to its conversation and message.
* Files: when the final reply links a workspace file (`[report](out/report.pdf)`), Wirebot uploads it as an attachment.
* Bundled skills ship as a local Claude Code plugin (`capabilities/`). Add your own under `/data/claude-home/skills`.

## Differences from upstream Wirebot

* Claude Agent SDK instead of the Codex app-server. No pinned Codex toolchain, protocol bindings, or app-server restarts.
* No in-chat login (`/login`, `/logout`, device codes): the operator configures credentials.
* No voice transcription. It relied on ChatGPT; voice messages are forwarded as audio files.
* No usage-limit page.
* The settings model is Claude's (model, effort, permission mode) instead of Codex `config.toml`.
* Auto mode routes effort locally instead of with a classifier model call.

## Development

```sh
bun install
bun run check      # tsc + biome
bun test
bun run build      # web app assets
cp example.env .env && bun run dev
```

Requires Bun ≥ 1.4. The Agent SDK installs a native Claude Code binary for your platform as an optional dependency.

On macOS, an explicit `CLAUDE_CONFIG_DIR` (the default here is `<data dir>/claude-home`) uses its own Keychain entry. For local runs, use `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, or set `CLAUDE_CONFIG_DIR=~/.claude` to reuse your own sign-in. That sign-in also carries your personal settings and hooks.

Releases: bump `version` in `package.json`, then push a `v<version>` tag. The release workflow publishes `ghcr.io/nocell/wirebot-agent:<version>` and `:latest`.

## License

MIT. Based on [Wirebot](https://github.com/sadfun/wirebot), © 2026 sadfun; see [LICENSE.md](LICENSE.md). Not affiliated with or endorsed by Anthropic or OpenAI. “Claude” is a trademark of Anthropic.
