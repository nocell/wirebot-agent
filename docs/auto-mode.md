# Auto effort

Auto effort picks a reasoning effort for every foreground user message, so a
greeting does not cost as much thinking as a debugging session. It is on by
default and shared by everyone using the Wirebot instance; turn it off with the
**Auto effort** setting (`/wirebot config`, the Telegram Mini App, or the web app).
Choosing a manual effort switches Auto off.

## How a message is classified

Classification is local: Wirebot matches the wording of the latest request
(in Slack channels, the current mention, not the earlier thread messages) with
fixed English and Russian patterns. It makes no extra model call, so Auto adds
no latency and no cost. The rules, checked in this order:

| Request looks like | Task | Effort |
| --- | --- | --- |
| debugging, investigating, root cause, bug research | bug research | `max` |
| deep, in-depth or comprehensive research | research | `max` |
| architecture, migration, refactoring, multi-step work | complex | `xhigh` |
| short greeting, translation, trivial fact (no attachments, under 300 chars) | simple | `low` |
| short question or explanation (no attachments, under 500 chars) | question | `medium` |
| anything else, including requests with attachments | task | `high` |

The rules are in `src/agent/auto-effort.ts`. They are intentionally
conservative: anything they do not recognize gets `high`.

## Model support

The chosen effort is clamped to what the selected model accepts, using the
model catalog Claude Code reports for the configured credential (cached for ten
minutes). If the model supports only lower levels, Auto uses the highest
supported level not above the requested one. If the model takes no effort
parameter, Auto sends none. When the catalog cannot be read, the requested
level is sent as is.

The selected model never changes; Auto only sets the per-turn `effort` passed
to the Agent SDK.

## Scheduled runs and compaction

Scheduled runs do not use Auto. They use the effort stored on the schedule;
without one, the manual effort setting while Auto is off, otherwise the model
default. `/wirebot compact` runs
without an effort override.
