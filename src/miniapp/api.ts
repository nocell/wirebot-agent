/**
 * Typed client for the Mini App HTTP API. Every request authenticates with
 * signed Telegram init data or a browser session and surfaces server-reported validation issues as
 * ConfigApiError.
 */
import type { AgentConfigSnapshot } from "../agent/config.js";
import type { SkillResource } from "../agent/skill-browser.js";
import type { ManagedSchedule } from "../automations/engine.js";
import type { WirebotSettings } from "../core/settings-store.js";
import type { AvailableSkill, ConfigValidationIssue } from "./server.js";
import { telegramReady, webApp } from "./telegram.js";

export type { AvailableSkill } from "./server.js";

/** The `/api/config` wire shape; the client trusts the server's typed JSON as-is. */
export type LoadedSnapshot = AgentConfigSnapshot & {
  readonly wirebotVersion?: string | undefined;
};

export class ConfigApiError extends Error {
  public readonly status: number;
  public readonly issues: readonly ConfigValidationIssue[] | undefined;

  public constructor(
    message: string,
    issues: readonly ConfigValidationIssue[] | undefined,
    status = 0,
  ) {
    super(message);
    this.name = "ConfigApiError";
    this.issues = issues;
    this.status = status;
  }
}

async function requestJson(path: string, init: RequestInit): Promise<unknown> {
  const hasBody = init.body !== undefined;
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(telegramReady
        ? { Authorization: `tma ${webApp?.initData}` }
        : { "X-Wirebot-Request": "1" }),
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const failure = value as {
      readonly error?: string;
      readonly code?: string;
      readonly issues?: readonly ConfigValidationIssue[];
    };
    if (
      !telegramReady &&
      (response.status === 401 || failure.code === "MINIAPP_FORBIDDEN") &&
      !path.startsWith("/api/auth/")
    ) {
      window.dispatchEvent(new Event("wirebot:session-expired"));
    }
    throw new ConfigApiError(
      failure.error ?? `Request failed (${response.status}).`,
      failure.issues,
      response.status,
    );
  }
  return value;
}

export async function requestSnapshot(
  method: "GET" | "PUT",
  body?: Readonly<Partial<WirebotSettings>>,
): Promise<LoadedSnapshot> {
  const value = await requestJson("/api/config", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return value as LoadedSnapshot;
}

export async function requestSkills(): Promise<readonly AvailableSkill[]> {
  const value = await requestJson("/api/skills", { method: "GET" });
  return (value as { readonly skills: readonly AvailableSkill[] }).skills;
}

export async function requestSchedules(): Promise<readonly ManagedSchedule[]> {
  const value = await requestJson("/api/schedules", { method: "GET" });
  return (value as { readonly schedules: readonly ManagedSchedule[] }).schedules;
}

export async function requestCreateSchedule(
  input: Readonly<{
    name: string;
    prompt: string;
    rrule: string;
    time_zone: string;
    notification_policy: ManagedSchedule["notification_policy"];
    idempotency_key: string;
  }>,
): Promise<ManagedSchedule> {
  const value = await requestJson("/api/schedules", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return (value as { readonly schedule: ManagedSchedule }).schedule;
}

export async function requestUpdateSchedule(
  id: string,
  input: Readonly<{
    expected_revision: number;
    name?: string;
    prompt?: string;
    rrule?: string;
    time_zone?: string;
    status?: ManagedSchedule["status"];
    notification_policy?: ManagedSchedule["notification_policy"];
  }>,
): Promise<ManagedSchedule> {
  const value = await requestJson(`/api/schedules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return (value as { readonly schedule: ManagedSchedule }).schedule;
}

export async function requestDeleteSchedule(id: string): Promise<void> {
  await requestJson(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function requestSkillResource(skill: string, path: string): Promise<SkillResource> {
  const query = new URLSearchParams({ skill, path });
  const value = await requestJson(`/api/skills/resource?${query.toString()}`, { method: "GET" });
  return value as SkillResource;
}

export async function requestSession(): Promise<{ readonly provider: string }> {
  return (await requestJson("/api/auth/session", { method: "GET" })) as {
    readonly provider: string;
  };
}

export async function exchangeLogin(token: string): Promise<void> {
  await requestJson("/api/auth/exchange", { method: "POST", body: JSON.stringify({ token }) });
}

export async function logoutBrowser(): Promise<void> {
  await requestJson("/api/auth/logout", { method: "POST" });
}
