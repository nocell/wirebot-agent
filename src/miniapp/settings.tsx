/**
 * The Settings tab: a summary home on phones, and one page per topic (Model,
 * Access, Remote session). Every control saves on change; the settings are
 * shared by everyone using this Wirebot and apply from the next message.
 */
import { LogOut } from "lucide-react";
import { type ReactElement, useState } from "react";
import type {
  EffortSetting,
  PermissionModeSetting,
  WirebotSettings,
} from "../core/settings-store.js";
import { type LoadedSnapshot, requestSnapshot } from "./api.js";
import { useAppData } from "./data.js";
import {
  ContentHeader,
  type RailSettingsPage,
  Screen,
  ScreenBody,
  SubpageHeader,
  TabBar,
  useDesktop,
  useSubpageBack,
} from "./layout.js";
import { WirebotLogo } from "./logo.js";
import { isSettingsPage, type Route, routeLink, type SettingsPage, useRoute } from "./route.js";
import { messageOf } from "./shared.js";
import { notifyHaptic, telegramReady } from "./telegram.js";
import {
  Field,
  Group,
  Hint,
  LoadingState,
  Notice,
  Row,
  RowLink,
  SectionLabel,
  Segmented,
  ToggleRow,
} from "./ui.js";

const settingsRoute: Route = { tab: "settings" };

const pageTitles: Readonly<Record<SettingsPage, string>> = {
  model: "Model",
  access: "Access",
  remote: "Remote session",
};

// The client bundle stays free of server modules, so these mirror agent/config.ts.
const permissionModeLabels: Readonly<Record<PermissionModeSetting, string>> = {
  bypassPermissions: "Full access — never ask",
  acceptEdits: "Accept file edits, ask for commands",
  default: "Ask before risky actions",
  dontAsk: "Only pre-approved tools, never ask",
  plan: "Plan only — no changes",
};
const permissionModes = Object.keys(permissionModeLabels) as readonly PermissionModeSetting[];

const effortLabels: Readonly<Record<EffortSetting, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function SettingsTab(): ReactElement {
  const route = useRoute();
  const desktop = useDesktop();
  const data = useAppData();
  const page = isSettingsPage(route.detail) ? route.detail : undefined;
  if (data.snapshot === undefined) {
    const loading = (
      <LoadingState
        header={
          data.snapshotError === undefined ? "Loading agent settings" : "Couldn’t open settings"
        }
        description="Reading the settings and the model catalog…"
        error={data.snapshotError}
        onRetry={data.reloadSnapshot}
      />
    );
    if (desktop) return loading;
    return (
      <Screen>
        {loading}
        <TabBar route={route} />
      </Screen>
    );
  }
  if (desktop) return <SettingsPageView page={page ?? "model"} desktop />;
  if (page === undefined) return <SettingsHome snapshot={data.snapshot} route={route} />;
  return <SettingsPageView page={page} desktop={false} />;
}

/** Labels and current values for the desktop rail and the phone home list. */
export function settingsRailPages(snapshot: LoadedSnapshot): readonly RailSettingsPage[] {
  const { settings } = snapshot;
  const effort = settings.autoMode
    ? "Auto"
    : settings.effort === null
      ? undefined
      : effortLabels[settings.effort];
  return [
    {
      page: "model",
      label: "Model",
      value: [modelName(snapshot), effort].filter((part) => part !== undefined).join(" · "),
    },
    { page: "access", label: "Access", value: permissionModeLabels[permissionMode(snapshot)] },
    { page: "remote", label: "Remote session", value: settings.remoteClientContext ? "On" : "Off" },
  ];
}

function SettingsHome({
  snapshot,
  route,
}: {
  readonly snapshot: LoadedSnapshot;
  readonly route: Route;
}): ReactElement {
  const data = useAppData();
  const rows = settingsRailPages(snapshot).filter((entry) => entry.page !== "remote");
  return (
    <Screen>
      <header className="brandHeader">
        <WirebotLogo className="brandHeader-logo" />
      </header>
      <ScreenBody className="stack">
        <section className="section">
          <SectionLabel>Agent</SectionLabel>
          <Group>
            {rows.map((entry) => (
              <RowLink
                key={entry.page}
                label={entry.label}
                value={entry.value}
                chevron
                {...routeLink({ tab: "settings", detail: entry.page })}
              />
            ))}
          </Group>
          <Hint>Changes save immediately and apply from the next message.</Hint>
        </section>
        <section className="section">
          <Group>
            <RemoteContextToggle />
          </Group>
        </section>
        <div className="versionLine">
          <span>
            {snapshot.wirebotVersion === undefined
              ? "Wirebot"
              : `Wirebot ${snapshot.wirebotVersion}`}
          </span>
          {telegramReady ? undefined : (
            <button
              type="button"
              className="linkButton"
              disabled={data.signOutBusy}
              onClick={data.signOut}
            >
              <LogOut aria-hidden="true" />
              Sign out
            </button>
          )}
        </div>
        {data.signOutError === undefined ? undefined : (
          <Notice tone="error">{data.signOutError}</Notice>
        )}
      </ScreenBody>
      <TabBar route={route} />
    </Screen>
  );
}

function SettingsPageView({
  page,
  desktop,
}: {
  readonly page: SettingsPage;
  readonly desktop: boolean;
}): ReactElement {
  useSubpageBack(settingsRoute);
  const body =
    page === "model" ? <ModelPage /> : page === "access" ? <AccessPage /> : <RemotePage />;
  if (desktop) {
    return (
      <>
        <ContentHeader crumbs={["Settings", pageTitles[page]]} />
        <main className="paneBody">
          <div className="form">{body}</div>
        </main>
      </>
    );
  }
  return (
    <Screen className="screen-subpage">
      <SubpageHeader back={{ label: "Settings", route: settingsRoute }} title={pageTitles[page]} />
      <ScreenBody className="form">{body}</ScreenBody>
    </Screen>
  );
}

interface SettingSaver {
  readonly snapshot: LoadedSnapshot;
  /** Name of the setting being saved, if any. */
  readonly pending: keyof WirebotSettings | undefined;
  readonly error: string | undefined;
  readonly save: (patch: Partial<WirebotSettings>) => void;
}

/** Saves a patch right away and replaces the shared snapshot with the server's answer. */
function useSettingSaver(): SettingSaver {
  const data = useAppData();
  const [pending, setPending] = useState<keyof WirebotSettings>();
  const [error, setError] = useState<string>();
  const snapshot = data.snapshot;
  if (snapshot === undefined) throw new Error("Settings pages need a loaded snapshot");
  const save = (patch: Partial<WirebotSettings>): void => {
    if (pending !== undefined) return;
    setPending(Object.keys(patch)[0] as keyof WirebotSettings);
    setError(undefined);
    void requestSnapshot("PUT", patch)
      .then((loaded) => {
        data.setSnapshot(loaded);
        notifyHaptic("success");
      })
      .catch((saveError: unknown) => {
        setError(messageOf(saveError));
        notifyHaptic("error");
      })
      .finally(() => setPending(undefined));
  };
  return { snapshot, pending, error, save };
}

function ModelPage(): ReactElement {
  const { snapshot, pending, error, save } = useSettingSaver();
  const { settings } = snapshot;
  const selected = settings.model ?? "default";
  const model = snapshot.models.find((candidate) => candidate.value === selected);
  const options = snapshot.models.some((candidate) => candidate.value === selected)
    ? snapshot.models
    : [
        ...snapshot.models,
        { value: selected, displayName: selected, description: "", efforts: [] },
      ];
  const efforts = model?.efforts ?? [];
  return (
    <>
      {error === undefined ? undefined : <Notice tone="error">{error}</Notice>}
      <Field
        label="Model"
        htmlFor="setting-model"
        hint={model?.description || "Claude Code's model id or alias."}
      >
        <select
          id="setting-model"
          className="control control-select"
          value={selected}
          disabled={pending !== undefined}
          onChange={(event) => {
            const value = event.currentTarget.value;
            save({ model: value === "default" ? null : value });
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.displayName}
            </option>
          ))}
        </select>
      </Field>
      <Group>
        <ToggleRow
          id="setting-autoMode"
          label="Auto effort"
          detail="Pick an effort for every message from its wording: Low/Medium for simple questions, High/Extra high for tasks, Max for deep research and debugging."
          checked={settings.autoMode}
          busy={pending === "autoMode"}
          disabled={pending !== undefined}
          onChange={(autoMode) => save({ autoMode })}
        />
      </Group>
      <Field
        label="Effort"
        as="span"
        hint={
          settings.autoMode
            ? "Auto effort is on. Choosing an effort turns it off."
            : "How much Claude thinks before answering. Default uses the model's own setting."
        }
      >
        {efforts.length === 0 ? (
          <div className="control control-static">Not configurable for this model</div>
        ) : (
          <Segmented
            aria-label="Effort"
            options={[
              { value: "default", label: "Default" },
              ...efforts.map((effort) => ({ value: effort, label: effortLabels[effort] })),
            ]}
            value={settings.autoMode ? "" : (settings.effort ?? "default")}
            disabled={pending !== undefined}
            onChange={(value) =>
              save({
                effort: value === "default" ? null : (value as EffortSetting),
                autoMode: false,
              })
            }
          />
        )}
      </Field>
    </>
  );
}

function AccessPage(): ReactElement {
  const { snapshot, pending, error, save } = useSettingSaver();
  const { auth } = snapshot;
  return (
    <>
      {error === undefined ? undefined : <Notice tone="error">{error}</Notice>}
      <Field
        label="Permissions"
        htmlFor="setting-permissionMode"
        hint="Approval prompts appear in the chat that started the turn. Scheduled runs never prompt: anything not pre-approved is denied."
      >
        <select
          id="setting-permissionMode"
          className="control control-select"
          value={snapshot.settings.permissionMode ?? ""}
          disabled={pending !== undefined}
          onChange={(event) => {
            const value = event.currentTarget.value;
            save({ permissionMode: value === "" ? null : (value as PermissionModeSetting) });
          }}
        >
          <option value="">Default — {permissionModeLabels[snapshot.defaultPermissionMode]}</option>
          {permissionModes.map((mode) => (
            <option key={mode} value={mode}>
              {permissionModeLabels[mode]}
            </option>
          ))}
        </select>
      </Field>
      <section className="section">
        <SectionLabel>Claude credential</SectionLabel>
        <Group>
          <Row
            label={auth.kind === "none" ? "Not configured" : "Connected"}
            detail={
              auth.kind === "none"
                ? "Set ANTHROPIC_API_KEY or cloud provider variables in Wirebot's environment and restart."
                : `Through ${auth.description}.`
            }
          />
        </Group>
        <Hint>The credential is set by whoever runs Wirebot; it can’t be changed here.</Hint>
        {auth.subscription ? (
          <Notice tone="warning">
            A personal Claude subscription is meant for a single-user instance. Use an API key or a
            cloud provider when other people talk to this bot.
          </Notice>
        ) : undefined}
      </section>
    </>
  );
}

function RemotePage(): ReactElement {
  return (
    <>
      <Group>
        <RemoteContextToggle />
      </Group>
      <Hint>
        Enabled by default. Wirebot tells Claude which messenger each turn comes from and that the
        user is not at the machine where it runs.
      </Hint>
    </>
  );
}

function RemoteContextToggle(): ReactElement {
  const data = useAppData();
  const [pending, setPending] = useState<boolean>();
  const [error, setError] = useState<string>();
  const current = data.snapshot?.settings.remoteClientContext ?? true;
  const change = (next: boolean): void => {
    if (pending !== undefined) return;
    setPending(next);
    setError(undefined);
    void requestSnapshot("PUT", { remoteClientContext: next })
      .then((loaded) => {
        data.setSnapshot(loaded);
        notifyHaptic("success");
      })
      .catch((changeError: unknown) => {
        setError(messageOf(changeError));
        notifyHaptic("error");
      })
      .finally(() => setPending(undefined));
  };
  return (
    <ToggleRow
      id="setting-remoteClientContext"
      label="Remote session context"
      detail={error ?? "Claude avoids host-local UI and localhost handoffs."}
      checked={pending ?? current}
      busy={pending !== undefined}
      onChange={change}
    />
  );
}

function modelName(snapshot: LoadedSnapshot): string {
  const selected = snapshot.settings.model ?? "default";
  return snapshot.models.find((candidate) => candidate.value === selected)?.displayName ?? selected;
}

function permissionMode(snapshot: LoadedSnapshot): PermissionModeSetting {
  return snapshot.settings.permissionMode ?? snapshot.defaultPermissionMode;
}
