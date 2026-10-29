/**
 * Client routing for the web app and Mini App: one route store, browser
 * paths (`/app/<tab>/<detail>`) or Telegram query parameters, and navigation
 * that runs behind the unsaved-changes guard.
 */
import type { MouseEvent } from "react";
import { useSyncExternalStore } from "react";
import { navigateWithUnsavedGuard, telegramReady } from "./telegram.js";

export type AppTab = "settings" | "skills" | "schedules";
export type SettingsPage = "model" | "access" | "remote";

export interface Route {
  readonly tab: AppTab;
  /** A Settings page, a skill name, or a schedule id (`new` for the editor). */
  readonly detail?: string | undefined;
}

const tabs: readonly AppTab[] = ["settings", "skills", "schedules"];
export const settingsPages: readonly SettingsPage[] = ["model", "access", "remote"];

export function isSettingsPage(value: string | undefined): value is SettingsPage {
  return (settingsPages as readonly string[]).includes(value ?? "");
}

function isTab(value: string | undefined): value is AppTab {
  return (tabs as readonly string[]).includes(value ?? "");
}

export function parseRoute(location: Location = window.location): Route {
  let tab: string | undefined;
  let detail: string | undefined;
  if (telegramReady) {
    const params = new URLSearchParams(location.search);
    tab = params.get("tab") ?? undefined;
    detail = params.get("detail") ?? undefined;
  } else {
    const [, segment, rest] = location.pathname.split("/").filter((part) => part.length > 0);
    tab = segment;
    if (rest !== undefined) {
      try {
        detail = decodeURIComponent(rest);
      } catch {
        detail = undefined;
      }
    }
  }
  if (!isTab(tab)) return { tab: "settings" };
  if (tab === "settings" && !isSettingsPage(detail)) return { tab };
  return detail === undefined || detail.length === 0 ? { tab } : { tab, detail };
}

export function routeHref(route: Route): string {
  if (telegramReady) {
    const params = new URLSearchParams({ tab: route.tab });
    if (route.detail !== undefined) params.set("detail", route.detail);
    return `/miniapp?${params.toString()}${window.location.hash}`;
  }
  const detail = route.detail === undefined ? "" : `/${encodeURIComponent(route.detail)}`;
  return `/app/${route.tab}${detail}`;
}

export function routeEquals(left: Route, right: Route): boolean {
  return left.tab === right.tab && (left.detail ?? "") === (right.detail ?? "");
}

let current: Route = parseRoute();
const listeners = new Set<() => void>();

function commit(route: Route, replace: boolean): void {
  const href = routeHref(route);
  if (replace) window.history.replaceState(null, "", href);
  else window.history.pushState(null, "", href);
  current = route;
  for (const listener of listeners) listener();
}

interface NavigateOptions {
  readonly replace?: boolean;
  /** Skip the unsaved-changes guard, for example right after a successful save. */
  readonly force?: boolean;
}

/** Moves to a route, asking about unsaved drafts first. */
export function navigate(route: Route, options?: NavigateOptions): void {
  if (routeEquals(route, current)) return;
  const go = (): void => {
    commit(route, options?.replace === true);
    if (options?.replace !== true) window.scrollTo(0, 0);
  };
  if (options?.force === true) go();
  else navigateWithUnsavedGuard(go);
}

// Browser back/forward stays behind the same guard as in-app links.
window.addEventListener("popstate", () => {
  const next = parseRoute();
  if (routeEquals(next, current)) return;
  // Restore the current page while the unsaved-changes guard asks the user.
  window.history.replaceState(null, "", routeHref(current));
  navigateWithUnsavedGuard(() => commit(next, true));
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => current);
}

/** Anchor props for an in-app link: a real href plus guarded client navigation. */
export function routeLink(route: Route): {
  readonly href: string;
  readonly onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
} {
  return {
    href: routeHref(route),
    onClick: (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      event.preventDefault();
      navigate(route);
    },
  };
}
