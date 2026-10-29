import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAgentAuth } from "../src/agent/auth.js";
import { autoEffort } from "../src/agent/auto-effort.js";
import { AgentConfigService } from "../src/agent/config.js";
import { renderApplicationContext } from "../src/agent/context.js";
import { todoPlan, toolActionLabel } from "../src/agent/progress.js";
import { WirebotSettingsStore } from "../src/core/settings-store.js";
import { Logger } from "../src/shared/logger.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "wirebot-agent-"));
  directories.push(directory);
  return directory;
}

describe("detectAgentAuth", () => {
  test("follows Claude Code's credential precedence", async () => {
    const empty = await temporaryDirectory();
    expect(detectAgentAuth({}, empty).kind).toBe("none");
    expect(detectAgentAuth({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, empty)).toMatchObject({
      kind: "subscriptionToken",
      subscription: true,
    });
    expect(
      detectAgentAuth({ CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" }, empty),
    ).toMatchObject({ kind: "apiKey", subscription: false });
    expect(
      detectAgentAuth({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_USE_BEDROCK: "1" }, empty).kind,
    ).toBe("bedrock");
    expect(detectAgentAuth({ ANTHROPIC_API_KEY: "" }, empty).kind).toBe("none");
  });

  test("recognizes a login stored in the config directory", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, ".credentials.json"), "{}");
    expect(detectAgentAuth({}, directory)).toMatchObject({
      kind: "storedLogin",
      subscription: true,
    });
  });
});

describe("autoEffort", () => {
  test("maps the request to an effort the model supports", () => {
    expect(autoEffort("hi", false, undefined)).toBe("low");
    expect(autoEffort("How does the queue work?", false, undefined)).toBe("medium");
    expect(autoEffort("Add a settings page to the app", false, undefined)).toBe("high");
    expect(autoEffort("Investigate the root cause of the crash", false, undefined)).toBe("max");
    expect(autoEffort("Investigate the root cause", false, ["low", "medium", "high"])).toBe("high");
    expect(autoEffort("hi", false, [])).toBeUndefined();
  });
});

describe("progress", () => {
  test("labels tool calls and turns TodoWrite into a plan", () => {
    expect(toolActionLabel("Bash", { command: "bun test" }).label).toBe("Running   bun test");
    expect(toolActionLabel("Edit", { file_path: "/w/src/app.ts" }).label).toBe("Editing   app.ts");
    expect(toolActionLabel("mcp__github__create_issue", {}).label).toBe(
      "Calling   github.create_issue",
    );
    expect(toolActionLabel("Bash", { command: "a\n  b" }).label).toBe("Running   a b");
    expect(
      todoPlan("TodoWrite", {
        todos: [
          { content: "Read", status: "completed" },
          { content: "Fix", status: "in_progress" },
          { content: "Test", status: "pending" },
        ],
      }),
    ).toEqual([
      { step: "Read", status: "completed" },
      { step: "Fix", status: "inProgress" },
      { step: "Test", status: "pending" },
    ]);
    expect(todoPlan("Bash", {})).toBeUndefined();
  });
});

test("application context renders as named blocks", () => {
  expect(
    renderApplicationContext({
      a: { kind: "application", value: "first" },
      b: { kind: "application", value: "second" },
    }),
  ).toBe('<context name="a">\nfirst\n</context>\n\n<context name="b">\nsecond\n</context>');
});

describe("AgentConfigService", () => {
  async function service() {
    const directory = await temporaryDirectory();
    const settings = new WirebotSettingsStore(
      join(directory, "settings.json"),
      new Logger("error"),
    );
    await settings.load();
    const config = new AgentConfigService(
      settings,
      async () => [
        { value: "default", displayName: "Default", description: "" },
        {
          value: "opus",
          displayName: "Opus",
          description: "",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          value: "haiku",
          displayName: "Haiku",
          description: "",
          supportsEffort: false,
        },
      ],
      "default",
      () => ({ kind: "apiKey", description: "an API key", subscription: false }),
    );
    return { settings, config };
  }

  test("a partial update keeps every other stored setting", async () => {
    const { settings, config } = await service();
    await config.update({ model: "opus", permissionMode: "acceptEdits" });
    await config.update({ remoteClientContext: false });
    expect(settings.read()).toEqual({
      remoteClientContext: false,
      autoMode: true,
      model: "opus",
      effort: null,
      permissionMode: "acceptEdits",
    });
  });

  test("a manual effort turns Auto off and an incompatible model clears it", async () => {
    const { settings, config } = await service();
    await config.update({ model: "opus" });
    await config.update({ effort: "max" });
    expect(settings.read()).toMatchObject({ autoMode: false, effort: "max" });
    await config.update({ model: "haiku" });
    expect(settings.read()).toMatchObject({ model: "haiku", effort: null });
    const snapshot = await config.read();
    expect(snapshot.models.find((model) => model.value === "haiku")?.efforts).toEqual([]);
  });

  test("rejects unknown settings", async () => {
    const { config } = await service();
    await expect(config.update({ sandbox_mode: "read-only" })).rejects.toThrow();
    await expect(config.update({ effort: "ultra" })).rejects.toThrow();
  });
});
