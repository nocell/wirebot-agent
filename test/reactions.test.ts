import { describe, expect, test } from "bun:test";
import { Collection } from "discord.js";
import {
  reactToDiscordMessage,
  reactToSlackMessage,
  reactToTelegramMessage,
  slackReaction,
  unicodeReaction,
} from "../src/channels/reactions.js";

describe("Message reactions", () => {
  test("converts shortcodes, presentation variants, and skin tones without changing the emoji", () => {
    for (const name of [":thumbsup:", ":+1:"]) expect(unicodeReaction(name)).toBe("👍");
    expect(unicodeReaction(":heart:")).toBe("❤️");
    expect(unicodeReaction(":thumbsup::skin-tone-4:")).toBe("👍🏽");
    expect(slackReaction("👍🏽")).toBe("+1::skin-tone-4");
    expect(slackReaction("❤️")).toBe("heart");
    expect(slackReaction("❤")).toBe("heart");
    expect(slackReaction(":party_blob:")).toBe("party_blob");
    expect(unicodeReaction("👨‍💻")).toBe("👨‍💻");
    for (const invalid of ["", "hello", ":unknown_reaction:", "👍👍", "hi 👍", "::"]) {
      expect(() => unicodeReaction(invalid)).toThrow();
    }
  });

  test("uses provider APIs, handles duplicates, and preserves provider failures", async () => {
    const telegram: unknown[][] = [];
    const api = {
      setMessageReaction: async (...args: unknown[]) => {
        telegram.push(args);
        return true;
      },
    };
    await reactToTelegramMessage(api, -123, 42, ":heart:");
    expect(telegram[0]).toEqual([-123, 42, [{ type: "emoji", emoji: "❤" }]]);
    await reactToTelegramMessage(api, -123, 43, ":custom_emoji_123456789:");
    expect(telegram[1]).toEqual([
      -123,
      43,
      [{ type: "custom_emoji", custom_emoji_id: "123456789" }],
    ]);
    await reactToTelegramMessage(api, -123, 44, ":100:");
    expect(telegram[2]).toEqual([-123, 44, [{ type: "emoji", emoji: "💯" }]]);

    const slack: unknown[] = [];
    const web = {
      reactions: {
        add: async (args: unknown) => {
          slack.push(args);
          return {};
        },
      },
    };
    await reactToSlackMessage(web, "C123", "100.123456", "👍🏽");
    expect(slack[0]).toEqual({ channel: "C123", timestamp: "100.123456", name: "+1::skin-tone-4" });
    web.reactions.add = async () => {
      throw { data: { error: "already_reacted" } };
    };
    await reactToSlackMessage(web, "C123", "100.123456", ":thumbsup:");
    const denied = new Error("missing_scope");
    web.reactions.add = async () => {
      throw denied;
    };
    await expect(reactToSlackMessage(web, "C123", "100.123456", "👍")).rejects.toBe(denied);
    api.setMessageReaction = async () => {
      throw new Error("REACTION_INVALID");
    };
    await expect(reactToTelegramMessage(api, -123, 42, "👍")).rejects.toThrow("REACTION_INVALID");

    const discord: string[] = [];
    const message = {
      react: async (emoji: string) => {
        discord.push(emoji);
      },
      guild: {
        emojis: {
          fetch: async () =>
            new Collection([
              ["123456789012345678", { name: "party_blob", id: "123456789012345678" }],
            ]),
        },
      },
    };
    await reactToDiscordMessage(message, ":thumbsup:");
    await reactToDiscordMessage(message, ":party_blob:");
    await reactToDiscordMessage(message, "<a:party_blob:123456789012345678>");
    expect(discord).toEqual(["👍", "123456789012345678", "<a:party_blob:123456789012345678>"]);
    await expect(reactToDiscordMessage(message, ":missing:")).rejects.toThrow("No unique Discord");
  });
});
