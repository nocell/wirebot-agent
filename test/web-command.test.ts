import { describe, expect, mock, test } from "bun:test";
import type { AgentService } from "../src/agent/service.js";
import type { ScheduledRunsEngine } from "../src/automations/engine.js";
import { WirebotBridge } from "../src/core/bridge.js";
import type { InboundMessage, SendOptions } from "../src/core/channel.js";
import { BrowserAuth } from "../src/miniapp/browser-auth.js";
import { Logger } from "../src/shared/logger.js";

function setup(provider: string, command: string, admin = true, isPrivate = true) {
  const auth = new BrowserAuth(() => true);
  const issue = mock(auth.issue.bind(auth));
  auth.issue = issue;
  const sendText = mock(async (_text: string, _options?: SendOptions) => {});
  const bridge = new WirebotBridge(
    {} as AgentService,
    "https://wirebot.example",
    new Logger("error"),
    {
      auth: () => ({ kind: "apiKey", description: "an API key", subscription: false }),
      modelSummary: () => "default",
    },
    {} as ScheduledRunsEngine,
    auth,
  );
  const message: InboundMessage = {
    id: "msg",
    address: {
      channel: provider,
      key: `${provider}:dm`,
      isPrivate,
      isGuest: false,
      deliveryTarget: { provider, resource: "destination", id: "dm" },
    },
    sender: { id: "admin", displayName: "Admin" },
    text: `/${command}`,
    command: { name: command, args: "" },
    attachments: [],
    isAdmin: admin,
    responder: {
      sendText,
      createStream: () => {
        throw new Error("unused");
      },
      askChoice: async () => "decline",
    },
  };
  return { bridge, message, issue, sendText };
}

describe("Browser entry commands", () => {
  for (const provider of ["telegram", "slack", "discord"]) {
    test(`${provider} issues /web only for an admin in a private bot chat`, async () => {
      for (const [admin, isPrivate] of [
        [false, true],
        [true, false],
        [true, true],
      ]) {
        const s = setup(provider, "web", admin, isPrivate);
        await s.bridge.handleMessage(s.message);
        expect(s.issue.mock.calls.length).toBe(admin && isPrivate ? 1 : 0);
        if (admin && isPrivate)
          expect(s.sendText.mock.calls[0]?.[1]?.button?.url).toMatch(
            /^https:\/\/wirebot.example\/app#login=[A-Za-z0-9_-]{43}$/,
          );
      }
    });
  }
  test("bridge config fallback keeps Telegram Mini App and other connector browser links", async () => {
    for (const provider of ["telegram", "slack", "discord"]) {
      const s = setup(provider, "config");
      await s.bridge.handleMessage(s.message);
      expect(s.sendText.mock.calls[0]?.[1]?.button?.kind).toBe(
        provider === "telegram" ? "webApp" : "url",
      );
    }
  });
});
