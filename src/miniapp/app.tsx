/** The signed-in application shell shared by the browser app and the Mini App. */
import type { ReactElement } from "react";
import { AppDataProvider, useAppData } from "./data.js";
import { Rail, useDesktop } from "./layout.js";
import { WirebotLogo } from "./logo.js";
import { useRoute } from "./route.js";
import { SchedulesTab } from "./schedules.js";
import { SettingsTab, settingsRailPages } from "./settings.js";
import { SkillsTab } from "./skills.js";
import { Notice } from "./ui.js";

export function SettingsApp({
  provider,
  onSignOut,
}: {
  readonly provider: string;
  readonly onSignOut: () => Promise<void>;
}): ReactElement {
  return (
    <AppDataProvider provider={provider} onSignOut={onSignOut}>
      <Shell />
    </AppDataProvider>
  );
}

function Shell(): ReactElement {
  const route = useRoute();
  const desktop = useDesktop();
  const data = useAppData();
  const content =
    route.tab === "settings" ? (
      <SettingsTab />
    ) : route.tab === "skills" ? (
      <SkillsTab />
    ) : (
      <SchedulesTab />
    );
  if (!desktop) return content;
  const activeSchedules = data.schedules?.filter((schedule) => schedule.status === "active").length;
  return (
    <div className="desk">
      <Rail
        route={route}
        settingsPages={data.snapshot === undefined ? [] : settingsRailPages(data.snapshot)}
        skillsCount={data.skills?.length}
        schedulesSummary={activeSchedules === undefined ? undefined : `${activeSchedules} active`}
        footer={
          route.tab === "skills" ? (
            <div className="rail-note">New skills apply from the next message.</div>
          ) : undefined
        }
        version={data.snapshot?.wirebotVersion}
        signOutBusy={data.signOutBusy}
        onSignOut={data.signOut}
      />
      <div className="deskContent">
        {data.signOutError === undefined ? undefined : (
          <div className="deskNotice">
            <Notice tone="error">{data.signOutError}</Notice>
          </div>
        )}
        {content}
      </div>
    </div>
  );
}

export function SignIn({ error }: { readonly error: string | undefined }): ReactElement {
  return (
    <main className="signIn">
      <div className="signIn-card">
        <WirebotLogo className="signIn-logo" />
        <h1>Sign in to Wirebot</h1>
        <p>Manage agent settings, skills, and schedules through your bot.</p>
        <p>
          Send <code>/wirebot web</code> in a direct message to your Slack or Discord bot, or{" "}
          <code>/web</code> in Telegram. Open the private link it replies with.
        </p>
        <p className="signIn-note">
          Admin access only. Links work once and expire after 5 minutes.
        </p>
        {error && (
          <p className="signIn-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
