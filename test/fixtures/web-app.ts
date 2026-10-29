import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfigSnapshot } from "../../src/agent/config.js";
import { AutomationManagementError } from "../../src/automations/engine.js";
import { settingsPatchSchema, type WirebotSettings } from "../../src/core/settings-store.js";
import { type AppPrincipal, BrowserAuth } from "../../src/miniapp/browser-auth.js";
import { MiniAppServer, type MiniAppServerOptions } from "../../src/miniapp/server.js";
import { Logger } from "../../src/shared/logger.js";

export const testPrincipal: AppPrincipal = {
  owner: { provider: "slack", resource: "user", id: "U_ADMIN" },
  conversation: { provider: "slack", resource: "conversation", id: "slack:D_ADMIN" },
  deliveryTarget: { provider: "slack", resource: "destination", id: "private-dm-target" },
};

function snapshotOf(settings: WirebotSettings): AgentConfigSnapshot {
  return {
    settings,
    models: [
      { value: "default", displayName: "Default", description: "", efforts: ["low", "high"] },
    ],
    defaultPermissionMode: "default",
    auth: { kind: "apiKey", description: "a Claude Console API key", subscription: false },
  };
}

/** Exercises the real HTTP server; only the agent/messenger services are local fakes. */
export async function startTestApp(assetDirectory?: string, includeTelegram = false) {
  let admin = true;
  const auth = new BrowserAuth(
    (owner) => admin && (owner.provider === "slack" || owner.provider === "discord"),
  );
  const assets = assetDirectory ?? (await mkdtemp(join(tmpdir(), "wirebot-browser-test-")));
  const ownedDirectory = assetDirectory === undefined ? assets : undefined;
  if (ownedDirectory !== undefined) {
    await Promise.all(
      ["index.html", "app.js", "app.css", "favicon.ico"].map((name) =>
        Bun.write(
          join(assets, name),
          name === "index.html" ? "<!doctype html><title>Wirebot</title>" : "",
        ),
      ),
    );
  }
  const scheduleScopes: unknown[][] = [];
  let settings: WirebotSettings = {
    remoteClientContext: true,
    autoMode: true,
    model: null,
    effort: null,
    permissionMode: null,
  };
  const skillsRoot = await mkdtemp(join(tmpdir(), "wirebot-skills-test-"));
  await mkdir(join(skillsRoot, "workspace-guide"));
  await Bun.write(
    join(skillsRoot, "workspace-guide", "SKILL.md"),
    "---\nname: workspace-guide\ndescription: Work with your project files.\n---\n\n# Guide\n",
  );
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    browserAuth: auth,
    assetDirectory: assets,
    ...(includeTelegram
      ? { telegramAuth: { botToken: "123456:TEST_BOT_TOKEN", allowedUserIds: new Set([42]) } }
      : {}),
    configService: {
      read: async () => snapshotOf(settings),
      update: async (patch) => {
        settings = { ...settings, ...settingsPatchSchema.parse(patch) };
        return snapshotOf(settings);
      },
    },
    skillDirectories: [{ source: "user", path: skillsRoot }],
    scheduledRuns: {
      listForOwner: (owner) => {
        scheduleScopes.push([owner]);
        return [];
      },
      createForOwner: async (...args) => {
        scheduleScopes.push(args);
        throw new AutomationManagementError("invalid", "Captured scope");
      },
      updateForOwner: async (...args) => {
        scheduleScopes.push(args);
        throw new AutomationManagementError("not_found", "Schedule not found");
      },
      deleteForOwner: async (...args) => {
        scheduleScopes.push(args);
        throw new AutomationManagementError("not_found", "Schedule not found");
      },
    },
    logger: new Logger("error"),
  } satisfies MiniAppServerOptions);
  const url = await server.start();
  return {
    server,
    url,
    auth,
    scheduleScopes,
    setAdmin: (value: boolean) => {
      admin = value;
    },
    close: async () => {
      await server.stop();
      await rm(skillsRoot, { recursive: true, force: true });
      if (ownedDirectory !== undefined) await rm(ownedDirectory, { recursive: true, force: true });
    },
  };
}
