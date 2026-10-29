# Slack connector

Wirebot can bridge Claude into Slack alongside Telegram. The connector uses
[Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode), so it
needs no public URL, webhook endpoint, or reverse proxy — the bridge dials out
to Slack exactly like the Telegram long-polling connection.

What works in Slack:

- Direct messages with the bot: send a message, watch live progress, get the
  final answer, exchange file attachments.
- Channels and group DMs: mention the bot (`@Wirebot fix the build`) and it
  answers in a thread. Every message addressed to the bot needs a mention —
  including follow-ups in the same thread — so human discussion around it
  stays untouched. Each thread is its own agent conversation with persistent
  context. On every mention inside an existing thread, the bot reads all
  earlier thread messages, including intervening human discussion.
- Approvals and questions: when the agent needs permission for an action (only
  outside full-access mode) or asks a clarifying question, it arrives as Slack
  buttons in the conversation that started the turn.
- Scheduled runs: results are delivered to the channel or thread that created
  them, with a Continue button.
- Commands: `/wirebot new`, `/wirebot status`, and friends (Slack reserves plain
  `/new`-style messages for its own slash commands, so Wirebot registers a single
  `/wirebot` command with subcommands).

When the agent creates a report, archive, image, or another deliverable, Wirebot can
upload it into the same Slack DM or thread. The connector-aware system context
instructs the agent to link the workspace-local deliverable in its final answer;
Wirebot validates and snapshots that file before uploading it with Slack's
`files:write` permission. Local links used only as code references are not
uploaded.

The full web app works without Telegram. In a bot DM, `/wirebot config` or
`/wirebot web` gives admins a one-use browser sign-in link (valid for 5 minutes).
There is no chat sign-in: the operator configures the Claude credential in
Wirebot's environment (see the README).

## 1. Create the Slack app

1. Open <https://api.slack.com/apps> and click **Create New App**.
2. Choose **From a manifest**, pick your workspace, and paste the manifest
   below (YAML tab). Rename the app if you like — the name is what you will
   @mention.
3. Click **Create**.

```yaml
display_information:
  name: Wirebot
  description: An AI agent in your Slack
  background_color: "#1a1d21"
features:
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Wirebot
    always_online: true
  slash_commands:
    - command: /wirebot
      description: Control Wirebot (new, stop, status, help…)
      usage_hint: "new | back | stop | compact | schedules | status | help"
      should_escape: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - reactions:write
      - im:history
      - channels:history
      - groups:history
      - mpim:history
      - files:read
      - files:write
      - users:read
      - commands
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

## 2. Collect the two tokens

For an existing installation, add `reactions:write` and reinstall the app to enable reactions.

- **App-level token** (`xapp-…`): in the app's **Basic Information** page,
  scroll to **App-Level Tokens**, click **Generate Token and Scopes**, name it
  (for example `wirebot-socket`), add the `connections:write` scope, and
  generate. Copy the `xapp-…` value — this is `SLACK_APP_TOKEN`.
- **Bot token** (`xoxb-…`): open **Install App** (or **OAuth & Permissions**),
  click **Install to Workspace**, and approve. Copy the **Bot User OAuth
  Token** — this is `SLACK_BOT_TOKEN`.

## 3. Decide who is allowed

Wirebot answers only authorized users. Two modes:

- **Allowlist**: comma-separated member IDs. In Slack, open a profile →
  **⋯ (More)** → **Copy member ID**; it looks like `U0123ABCDEF`.
- **Whole workspace**: `SLACK_ALLOWED_USER_IDS=*` authorizes every regular
  member of the workspace the app is installed in. Bots, deactivated
  accounts, single/multi-channel guests, and Slack Connect participants from
  other workspaces are still rejected (membership is verified through
  `users.info` and cached for ten minutes, so deactivating someone in Slack
  locks them out without a restart).

Everyone shares one Wirebot: the same Claude credential, the same workspace
directory on the host, and the same conversation state per channel/thread.
Open it to the whole workspace only if that is acceptable. An instance that
several people can use must authenticate with an API key or a cloud provider:
Anthropic's terms allow a personal Claude subscription only for your own use.

Optionally, `SLACK_ADMIN_USER_IDS` (comma-separated member IDs) restricts
instance-wide commands — `/wirebot config` and browser sign-in with `web` — to
the listed users. Unset, every authorized user may run them. In a bot DM,
`/wirebot config` always opens Slack menu buttons: **Model**, **Auto effort**,
**Effort**, and **Permissions**. Auto has **On/Off** buttons; a manual effort
selection switches Auto off. Model and effort choices follow the model catalog
reported for the configured credential. Changes save immediately and apply to
the next turn.

Use `/wirebot web` for the browser app through a private sign-in link. Set
`PUBLIC_URL` to an HTTPS origin or use the automatic quick tunnel. Browser sessions
last 12 hours and retain the Slack user identity for schedule ownership.

## 4. Configure Wirebot

Add the three variables to the `.env` used by the Docker deployment or source checkout:

```dotenv
SLACK_BOT_TOKEN=xoxb-…
SLACK_APP_TOKEN=xapp-…
SLACK_ALLOWED_USER_IDS=U0123ABCDEF,U0456GHIJKL
```

All three must be set together; leaving them all unset keeps the connector
disabled. Telegram is optional when Slack is configured — with only the Slack
variables set, Wirebot runs Slack-only with the same web app. Restart Wirebot and check the log for
`Slack bot connected through Socket Mode`.

## 5. Talk to it

- **Direct message**: open the app under **Apps** in the Slack sidebar and
  send a message. If Slack says the app cannot receive messages, enable the
  Messages Tab: app settings → **App Home** → check *Allow users to send Slash
  commands and messages from the messages tab* (the manifest above enables it,
  but workspaces occasionally need a re-toggle), then reload Slack.
- **Channel**: invite the bot (`/invite @Wirebot`), then mention it:
  `@Wirebot what does this repo do?`. The reply opens a thread; address it
  there with a mention each time (`@Wirebot and now check the tests`) — the
  thread's agent conversation continues across mentions.
- **Commands**: `/wirebot help` anywhere, or prefix a command in a mention:
  `@Wirebot /new`. In the bot DM, plain `/new` will not reach Wirebot — Slack
  intercepts everything that starts with `/` — so use `/wirebot new`.
  Conversation-scoped commands (`new`, `back`, `stop`, `compact`, `schedules`,
  `continue`) only work as `/wirebot …` in the bot DM; in a channel each thread
  is its own conversation, so run them inside the thread as a mention
  (`@Wirebot /stop`).
- **Restart**: `@Wirebot new` inside a thread (or plain `new` in the bot DM)
  starts a fresh agent session. Channel threads still provide their full Slack
  discussion as context on the next mention. In DMs, messages before `new`
  are excluded. `@Wirebot /new` and `/wirebot new` behave the same way.
- **Status**: `/wirebot status` shows which Claude credential the agent uses and
  the current model and effort. Without a credential, every message is answered
  with setup instructions for the operator.

## Let the agent read Slack history (optional)

By default the agent never sees a Slack token: Wirebot keeps `SLACK_BOT_TOKEN`
and `SLACK_APP_TOKEN` out of its environment, and only the bridge itself reads a
thread when the bot is first mentioned there or after `new`. To let the agent
read Slack on request — "summarize this thread", a pasted message link, "what
did #ops discuss this week" — set `WIREBOT_SLACK_READ_TOKEN`:

- Either the same `xoxb-` bot token, or the bot token of a second Slack app
  that has only read scopes. A separate app is safer: the agent can then
  neither post as the bot nor open its Socket Mode connection.
- Read scopes: `channels:history`, `groups:history`, `im:history`,
  `mpim:history`, `channels:read`, `groups:read`, `mpim:read`, `im:read`,
  `users:read`. Reinstall the app after adding scopes.

The variable itself stays with the bridge. On start, Wirebot writes the token to
a private file (`<data dir>/secrets/slack-read-token`, mode `0600`) and gives
the agent its path in `WIREBOT_SLACK_TOKEN_FILE`. That keeps the subprocess
credential scrub (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, on by default), which
strips credentials from the environment of the agent's shell commands, from
removing it. The agent can still read the file, so treat the token as available
to it.

Slack turns then carry the channel, thread and requesting user as context, and
the bundled `slack-history` skill
(`$WIREBOT_CAPABILITIES_DIR/skills/slack-history`) reads through a helper that
only calls read methods. The token reads what the bot is a member of — invite it
where it should read. Bot tokens cannot use Slack search.

Anyone allowed to talk to Wirebot can ask the agent to read any conversation the
token can reach, including private channels the bot is in and other people's
DMs with the bot. The skill tells the agent not to read other people's DMs, but
that is guidance, not enforcement; with `SLACK_ALLOWED_USER_IDS=*` prefer a
separate read-only app and invite it only where reading is appropriate.

## Notes and limits

- **Authorization**: messages, commands, and button clicks from users outside
  `SLACK_ALLOWED_USER_IDS` are ignored (and logged). Scheduled runs re-check
  the owner against the allowlist before every unattended execution.
- **Context after a process restart**: the active agent session is persisted
  and continues; Slack thread context is refreshed on every mention. A DM `new`
  reset remains effective across restarts.
- **Attachments**: inbound files are downloaded through Slack's private file
  URLs with the bot token (never sent to third-party hosts); generated files
  are uploaded back with `files.uploadV2`. Slack voice clips are passed to the
  agent as audio files; Wirebot does not transcribe them.
- **Formatting**: the agent's Markdown is converted to Slack mrkdwn (headings
  become bold lines, `**bold**` becomes `*bold*`, links become
  `<url|label>`); code blocks pass through untouched.
- **Rate limits**: live progress is streamed by editing a single message at
  most every 1.5 seconds, which stays inside Slack's `chat.update` budget.
