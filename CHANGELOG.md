# Changelog

## 0.1.0

First release of the port from the Codex app-server to the Claude Agent SDK, based on Wirebot 0.4.1. See upstream [Wirebot's changelog](https://github.com/sadfun/wirebot/blob/main/CHANGELOG.md) for earlier history.

- Each chat turn is an Agent SDK `query()` that resumes the conversation's Claude Code session. Interrupts, `/compact`, and `/back` also work through the SDK.
- Progress streams tool calls, the agent's to-do list, and interim text. Approvals and `AskUserQuestion` appear as chat buttons. Answers to questions work in every permission mode.
- Host tools (reactions, scheduled-run management) come from an in-process MCP server created for each turn.
- The operator configures the credential through the environment: an API key, Bedrock, Google Cloud, Foundry, a gateway, or a personal `claude setup-token` token. Startup warns when a subscription credential is shared by several users.
- The settings are the model, Auto effort, a fixed effort, the permission mode, and remote client context. They are shared by the chat settings menus and the web app.
- Auto effort uses a local heuristic, with no extra classifier call.
- Bundled skills ship as a local Claude Code plugin. The Slack history skill reads its token from a private file, so `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` can stay on.
- Removed:
  - the pinned Codex toolchain, protocol bindings, and app-server runtime;
  - in-chat ChatGPT login;
  - ChatGPT voice transcription;
  - the usage-limit page;
  - compiled single-file binaries. The image runs from source on Bun.
