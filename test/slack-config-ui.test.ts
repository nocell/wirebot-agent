import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { AgentConfigService } from "../src/agent/config.js";
import { SlackChannel } from "../src/channels/slack/channel.js";
import { SlackConfigUi } from "../src/channels/slack/config-ui.js";
import type { SlackMessageEvent } from "../src/channels/slack/message.js";
import type {
  SlackBlock,
  SlackMessagingApi,
  SlackPostOptions,
} from "../src/channels/slack/reply.js";
import type { InboundMessage } from "../src/core/channel.js";
import { WirebotSettingsStore } from "../src/core/settings-store.js";
import { deferred } from "../src/shared/async.js";
import { Logger } from "../src/shared/logger.js";

const directories: string[] = [];
const logger = new Logger("error");
afterEach(async () => {
  mock.restore();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("Slack preserves message order across slow history while stop bypasses the turn queue", async () => {
  const apiCalls: { method: string; options: unknown }[] = [];
  spyOn(WebClient.prototype, "apiCall").mockImplementation(async (method, options) => {
    apiCalls.push({ method, options });
    return {
      ok: true,
      ts: "5.000",
      user_id: "BOT",
      team_id: "TEAM",
      user: { real_name: "User" },
    };
  });
  spyOn(SocketModeClient.prototype, "start").mockImplementation(async () => {});
  const channel = new SlackChannel(
    {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["user"]),
      allowAllWorkspaceMembers: false,
    },
    "/tmp/unused",
    logger,
  );
  const internal = channel as unknown as {
    handleMessageEvent(event: SlackMessageEvent): Promise<void>;
    withThreadContext(event: SlackMessageEvent, botUserId: string, text: string): Promise<string>;
  };
  const historyStarted = deferred<void>();
  const historyReady = deferred<void>();
  const turnReady = deferred<void>();
  const received: InboundMessage[] = [];
  spyOn(internal, "withThreadContext").mockImplementation(async (event, _bot, text) => {
    if (event.ts === "2.000") {
      historyStarted.resolve();
      await historyReady.promise;
    }
    return text === "/stop" ? text : `Historical context\n${text}`;
  });
  try {
    await channel.start(async (message) => {
      received.push(message);
      if (message.id === "2.000") await turnReady.promise;
    });
    const event: SlackMessageEvent = {
      type: "message",
      channel: "C",
      channel_type: "channel",
      thread_ts: "1.000",
      ts: "2.000",
      user: "user",
      text: "<@BOT> Request A",
    };
    const first = internal.handleMessageEvent(event);
    await historyStarted.promise;
    const second = internal.handleMessageEvent({
      ...event,
      ts: "3.000",
      text: "<@BOT> Correction B",
    });
    const unauthorized = internal.handleMessageEvent({
      ...event,
      ts: "3.500",
      user: "outsider",
    });
    await internal.handleMessageEvent({ ...event, ts: "4.000", text: "<@BOT> /stop" });
    expect(received.map((message) => message.id)).toEqual(["4.000"]);
    expect(apiCalls.filter((call) => call.method === "chat.postMessage")).toEqual([
      {
        method: "chat.postMessage",
        options: expect.objectContaining({
          channel: "C",
          thread_ts: "1.000",
          text: "Queued behind earlier work…",
        }),
      },
    ]);
    historyReady.resolve();
    while (received.length < 2) await Bun.sleep(1);
    expect(received.map((message) => message.id)).toEqual(["4.000", "2.000"]);
    turnReady.resolve();
    await Promise.all([first, second, unauthorized]);
    expect(received.map((message) => message.id)).toEqual(["4.000", "2.000", "3.000"]);
    expect(received.at(-1)?.requestText).toBe("Correction B");
  } finally {
    historyReady.resolve();
    turnReady.resolve();
    await channel.stop();
  }
});

test("Slack attachment captions cannot bypass earlier queued messages", async () => {
  spyOn(WebClient.prototype, "apiCall").mockImplementation(async () => ({
    ok: true,
    ts: "5.000",
    user_id: "BOT",
    team_id: "TEAM",
  }));
  spyOn(SocketModeClient.prototype, "start").mockImplementation(async () => {});
  const channel = new SlackChannel(
    {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["user"]),
      allowAllWorkspaceMembers: false,
    },
    "/tmp/unused",
    logger,
  );
  const internal = channel as unknown as {
    handleMessageEvent(event: SlackMessageEvent): Promise<void>;
    processMessageEvent(event: SlackMessageEvent): Promise<void>;
  };
  const turnStarted = deferred<void>();
  const turnReady = deferred<void>();
  const processed: string[] = [];
  spyOn(internal, "processMessageEvent").mockImplementation(async (event) => {
    processed.push(event.ts);
    if (event.ts === "1.000") {
      turnStarted.resolve();
      await turnReady.promise;
    }
  });
  try {
    await channel.start(async () => {});
    const event: SlackMessageEvent = {
      type: "message",
      channel: "D",
      channel_type: "im",
      ts: "1.000",
      user: "user",
      text: "Request A",
    };
    const first = internal.handleMessageEvent(event);
    await turnStarted.promise;
    const second = internal.handleMessageEvent({ ...event, ts: "2.000", text: "Request B" });
    const third = internal.handleMessageEvent({
      ...event,
      ts: "3.000",
      text: "new",
      files: [{ id: "F", name: "replacement.txt" }],
    });
    await internal.handleMessageEvent({ ...event, ts: "4.000", text: "/stop" });
    expect(processed).toEqual(["1.000", "4.000"]);
    turnReady.resolve();
    await Promise.all([first, second, third]);
    expect(processed).toEqual(["1.000", "4.000", "2.000", "3.000"]);
  } finally {
    turnReady.resolve();
    await channel.stop();
  }
});

function buttons(blocks: readonly SlackBlock[] | undefined) {
  return blocks?.flatMap((block) => (block.type === "actions" ? block.elements : [])) ?? [];
}
function text(blocks: readonly SlackBlock[] | undefined) {
  return (
    blocks?.flatMap((block) => (block.type === "section" ? [block.text.text] : [])).join("\n") ?? ""
  );
}

const models = [
  { value: "default", displayName: "Default", description: "Recommended" },
  {
    value: "opus",
    displayName: "Opus",
    description: "Most capable",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] as const,
  },
  {
    value: "haiku",
    displayName: "Haiku",
    description: "Fastest",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"] as const,
  },
].map((model) => ({
  ...model,
  ...("supportedEffortLevels" in model
    ? { supportedEffortLevels: [...model.supportedEffortLevels] }
    : {}),
}));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "wirebot-slack-config-"));
  directories.push(directory);
  const settings = new WirebotSettingsStore(join(directory, "settings.json"), logger);
  const service = new AgentConfigService(
    settings,
    async () => models,
    "bypassPermissions",
    () => ({
      kind: "apiKey",
      description: "a Claude Console API key",
      subscription: false,
    }),
  );
  const update = mock(async (input: unknown) => await service.update(input));
  const config = { read: async () => await service.read(), update };
  const messages: SlackPostOptions[] = [];
  const api = {
    postMessage: async (message: SlackPostOptions) => {
      messages.push(message);
      return "1.000";
    },
    updateMessage: async (message: SlackPostOptions) => {
      messages.push(message);
    },
  } as unknown as SlackMessagingApi;
  const ui = new SlackConfigUi(api, config, logger);
  const latest = () => messages.at(-1)?.blocks;
  return { settings, config, ui, update, latest };
}

test("Slack Auto buttons persist the shared setting and refresh the menu in place", async () => {
  const f = await fixture();
  await f.ui.open("D_ADMIN");
  expect(buttons(f.latest()).map((button) => button.value)).toContain("pick:auto_mode");
  expect(text(f.latest())).toContain("*Auto effort*: On");
  expect(text(f.latest())).toContain("*Effort*: Auto");
  await f.ui.handleAction("pick:auto_mode", "D_ADMIN", "1.000");
  expect(buttons(f.latest()).map((button) => button.text.text)).toEqual(["✓ On", "Off", "← Back"]);
  await f.ui.handleAction("set:auto_mode:false", "D_ADMIN", "1.000");
  expect(f.settings.read().autoMode).toBe(false);
  expect(text(f.latest())).toContain("*Effort*: default");
  await f.ui.handleAction("set:auto_mode:true", "D_ADMIN", "1.000");
  expect(f.settings.read().autoMode).toBe(true);
  for (const block of f.latest() ?? [])
    if (block.type === "actions") expect(block.elements.length).toBeLessThanOrEqual(5);
});

test("Slack model and effort buttons follow the model catalog", async () => {
  const f = await fixture();
  await f.ui.handleAction("set:model:opus", "D_ADMIN", "1.000");
  await f.ui.handleAction("pick:effort", "D_ADMIN", "1.000");
  expect(buttons(f.latest()).map((button) => button.text.text)).toContain("max");
  await f.ui.handleAction("set:effort:max", "D_ADMIN", "1.000");
  expect(f.settings.read()).toMatchObject({ autoMode: false, effort: "max", model: "opus" });
  expect(text(f.latest())).toContain("Auto effort disabled");
  await f.ui.handleAction("set:model:haiku", "D_ADMIN", "1.000");
  expect(f.settings.read()).toMatchObject({ model: "haiku", effort: null });
  await f.ui.handleAction("pick:effort", "D_ADMIN", "1.000");
  expect(buttons(f.latest()).map((button) => button.value)).not.toContain("set:effort:max");
});

test("rejected Slack config writes leave Auto enabled", async () => {
  const f = await fixture();
  f.update.mockImplementation(async () => {
    throw new Error("The setting was rejected");
  });
  await f.ui.handleAction("set:effort:low", "D_ADMIN", "1.000");
  expect(f.settings.read().autoMode).toBe(true);
  expect(text(f.latest())).toContain("The setting was rejected");
});

test("Slack config commands open native buttons while web commands remain available and admin-only", async () => {
  const f = await fixture();
  const apiCalls: { method: string; options: unknown }[] = [];
  spyOn(WebClient.prototype, "apiCall").mockImplementation(async (method, options) => {
    apiCalls.push({ method, options });
    return { ok: true, user_id: "BOT", team_id: "TEAM", ts: "1.000" };
  });
  spyOn(SocketModeClient.prototype, "start").mockImplementation(async () => {});
  const channel = new SlackChannel(
    {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["admin", "member"]),
      adminUserIds: new Set(["admin"]),
      allowAllWorkspaceMembers: false,
    },
    "/tmp/unused",
    logger,
    f.config,
  );
  const forwarded = mock(async (_message: InboundMessage) => {});
  const sendText = mock(async (_text: string) => {});
  const inbound: InboundMessage = {
    id: "1.000",
    address: { channel: "slack", key: "slack:D_ADMIN:main", isPrivate: true, isGuest: false },
    sender: { id: "admin", displayName: "Admin" },
    text: "/config",
    command: { name: "config", args: "" },
    attachments: [],
    isAdmin: true,
    responder: {
      sendText,
      createStream: () => {
        throw new Error("unused");
      },
      askChoice: async () => "decline",
    },
  };
  const internal = channel as unknown as {
    dispatch(message: InboundMessage, channelId: string, userId: string): Promise<void>;
  };
  try {
    await channel.start(forwarded);
    await internal.dispatch(inbound, "D_ADMIN", "admin");
    const posted = apiCalls.find((call) => call.method === "chat.postMessage")?.options as
      | SlackPostOptions
      | undefined;
    expect(buttons(posted?.blocks).map((button) => button.value)).toContain("pick:auto_mode");
    expect(forwarded).not.toHaveBeenCalled();
    await internal.dispatch({ ...inbound, command: { name: "web", args: "" } }, "D_ADMIN", "admin");
    expect(forwarded).toHaveBeenCalledTimes(1);
    const count = apiCalls.length;
    await internal.dispatch({ ...inbound, isAdmin: false }, "D_ADMIN", "member");
    await internal.dispatch(
      { ...inbound, address: { ...inbound.address, isPrivate: false } },
      "CHANNEL",
      "admin",
    );
    expect(apiCalls).toHaveLength(count);
    expect(sendText).toHaveBeenCalledTimes(2);
  } finally {
    await channel.stop();
  }
});
