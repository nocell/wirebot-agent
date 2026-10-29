/**
 * The Schedules tab: rows with a pause switch, plus the editor for creating
 * and updating schedules (delete lives in the editor). Desktop shows the list
 * beside the open editor; phones stack them as list and sub-page.
 */
import { CalendarClock, Plus } from "lucide-react";
import { type ReactElement, useCallback, useState } from "react";
import type { ManagedSchedule } from "../automations/engine.js";
import { requestCreateSchedule, requestDeleteSchedule, requestUpdateSchedule } from "./api.js";
import { cn } from "./cn.js";
import { useAppData } from "./data.js";
import { ConfirmDialog, ExpandableTextarea } from "./dialogs.js";
import {
  BottomBar,
  ContentHeader,
  ListColHeader,
  PageTitle,
  Screen,
  ScreenBody,
  SplitView,
  SubpageHeader,
  TabBar,
  useDesktop,
} from "./layout.js";
import { navigate, type Route, routeLink, useRoute } from "./route.js";
import { isDefined, messageOf } from "./shared.js";
import {
  confirmDiscardChanges,
  notifyHaptic,
  useTelegramBackButton,
  useUnsavedChanges,
} from "./telegram.js";
import {
  Button,
  Field,
  Group,
  Hint,
  LoadingState,
  Notice,
  Placeholder,
  Rule,
  Switch,
} from "./ui.js";

type ScheduleCadence = "custom" | "daily" | "hourly" | "minutely" | "weekdays" | "weekly";

interface ScheduleDraft {
  readonly name: string;
  readonly prompt: string;
  readonly cadence: ScheduleCadence;
  readonly interval: string;
  readonly time: string;
  readonly days: readonly string[];
  readonly customRrule: string;
  readonly timeZone: string;
  readonly notificationPolicy: ManagedSchedule["notification_policy"];
}

interface PageNotice {
  readonly tone: "success" | "warning" | "error";
  readonly text: string;
}

const weekdayOptions = [
  ["MO", "Mon"],
  ["TU", "Tue"],
  ["WE", "Wed"],
  ["TH", "Thu"],
  ["FR", "Fri"],
  ["SA", "Sat"],
  ["SU", "Sun"],
] as const;

const schedulesRoute: Route = { tab: "schedules" };

export function SchedulesTab(): ReactElement {
  const route = useRoute();
  const desktop = useDesktop();
  const data = useAppData();
  const [notice, setNotice] = useState<PageNotice>();
  const [busyId, setBusyId] = useState<string>();
  const schedules = data.schedules;
  const detail = route.detail;

  const toggleStatus = async (schedule: ManagedSchedule): Promise<void> => {
    if (busyId !== undefined) return;
    const status = schedule.status === "active" ? "paused" : "active";
    setBusyId(schedule.id);
    try {
      const updated = await requestUpdateSchedule(schedule.id, {
        expected_revision: schedule.revision,
        status,
      });
      data.updateSchedules((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      notifyHaptic("success");
      setNotice({
        tone: "success",
        text: status === "active" ? `“${schedule.name}” resumed.` : `“${schedule.name}” paused.`,
      });
    } catch (error) {
      setNotice({ tone: "error", text: messageOf(error) });
      notifyHaptic("error");
    } finally {
      setBusyId(undefined);
    }
  };
  const onSaved = (schedule: ManagedSchedule, created: boolean): void => {
    data.updateSchedules((current) =>
      current.some((item) => item.id === schedule.id)
        ? current.map((item) => (item.id === schedule.id ? schedule : item))
        : [...current, schedule],
    );
    setNotice({
      tone: "success",
      text: created ? `“${schedule.name}” scheduled.` : `“${schedule.name}” updated.`,
    });
    navigate(desktop ? { tab: "schedules", detail: schedule.id } : schedulesRoute, {
      replace: true,
      force: true,
    });
  };
  const onDeleted = (schedule: ManagedSchedule): void => {
    data.updateSchedules((current) => current.filter((item) => item.id !== schedule.id));
    setNotice({ tone: "success", text: `“${schedule.name}” deleted.` });
    navigate(schedulesRoute, { replace: true, force: true });
  };

  if (schedules === undefined) {
    const loading = (
      <LoadingState
        header={data.schedulesError === undefined ? "Loading schedules" : "Couldn’t load schedules"}
        description="Reading your current scheduled runs…"
        error={data.schedulesError}
        onRetry={data.reloadSchedules}
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

  const ordered = [...schedules].sort(compareSchedules);
  const activeCount = ordered.filter((schedule) => schedule.status === "active").length;
  const summary = `${activeCount} active · ${ordered.length - activeCount} paused`;
  const editing =
    detail === undefined || detail === "new"
      ? undefined
      : ordered.find((schedule) => schedule.id === detail);
  const noticeLine =
    notice === undefined ? undefined : <Notice tone={notice.tone}>{notice.text}</Notice>;
  const newLink = (
    <a className="pill" {...routeLink({ tab: "schedules", detail: "new" })}>
      <Plus aria-hidden="true" />
      New
    </a>
  );

  if (desktop) {
    return (
      <SplitView
        wide
        list={
          <>
            <ListColHeader>
              <span className="listCol-summary">{summary}</span>
              {newLink}
            </ListColHeader>
            <div className="listCol-body">
              {noticeLine}
              {ordered.length === 0 ? (
                <Hint>
                  Nothing scheduled yet. Create a recurring task and Wirebot will run it even when
                  the chat is quiet.
                </Hint>
              ) : (
                ordered.map((schedule) => (
                  <ScheduleItem
                    key={schedule.id}
                    schedule={schedule}
                    selected={detail === schedule.id}
                    busy={busyId === schedule.id}
                    compact
                    onToggle={() => void toggleStatus(schedule)}
                  />
                ))
              )}
            </div>
          </>
        }
      >
        {detail === "new" ? (
          <ScheduleEditor
            key="new"
            schedule={undefined}
            desktop
            onSaved={onSaved}
            onDeleted={onDeleted}
          />
        ) : editing !== undefined ? (
          <ScheduleEditor
            key={editing.id}
            schedule={editing}
            desktop
            onSaved={onSaved}
            onDeleted={onDeleted}
          />
        ) : detail !== undefined ? (
          <div className="paneBody">
            <Placeholder header="Schedule not found" description="It may have been deleted." />
          </div>
        ) : (
          <div className="paneBody">
            <Placeholder
              header={ordered.length === 0 ? "Nothing scheduled yet" : "Select a schedule"}
              description={
                ordered.length === 0
                  ? "Create a recurring task and Wirebot will run it even when the chat is quiet."
                  : "Open a schedule from the list to edit it, or create a new one."
              }
              action={
                <a
                  className="btn btn-primary btn-m"
                  {...routeLink({ tab: "schedules", detail: "new" })}
                >
                  Create a schedule
                </a>
              }
            >
              <CalendarClock className="placeholder-icon" aria-hidden="true" />
            </Placeholder>
          </div>
        )}
      </SplitView>
    );
  }

  if (detail === "new" || editing !== undefined) {
    return (
      <ScheduleEditor
        key={editing?.id ?? "new"}
        schedule={editing}
        desktop={false}
        onSaved={onSaved}
        onDeleted={onDeleted}
      />
    );
  }
  if (detail !== undefined) {
    return (
      <Screen className="screen-subpage">
        <SubpageHeader back={{ label: "Schedules", route: schedulesRoute }} title="Schedule" />
        <div className="paneBody">
          <Placeholder header="Schedule not found" description="It may have been deleted." />
        </div>
      </Screen>
    );
  }
  return (
    <Screen>
      <PageTitle title="Schedules" subtitle={summary} action={newLink} />
      <ScreenBody className="stack-sm">
        {noticeLine}
        {ordered.length === 0 ? (
          <div className="emptyState">
            <Placeholder
              header="Nothing scheduled yet"
              description="Create a recurring task and Wirebot will run it even when the chat is quiet."
              action={
                <a
                  className="btn btn-primary btn-m"
                  {...routeLink({ tab: "schedules", detail: "new" })}
                >
                  Create a schedule
                </a>
              }
            >
              <CalendarClock className="placeholder-icon" aria-hidden="true" />
            </Placeholder>
          </div>
        ) : (
          <>
            <Group>
              {ordered.map((schedule) => (
                <ScheduleItem
                  key={schedule.id}
                  schedule={schedule}
                  selected={false}
                  busy={busyId === schedule.id}
                  onToggle={() => void toggleStatus(schedule)}
                />
              ))}
            </Group>
            <Hint>
              Tap a schedule to edit it. Switch it off to pause without losing the schedule.
            </Hint>
          </>
        )}
      </ScreenBody>
      <TabBar route={route} />
    </Screen>
  );
}

interface ScheduleItemProps {
  readonly schedule: ManagedSchedule;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly compact?: boolean;
  readonly onToggle: () => void;
}

function ScheduleItem({
  schedule,
  selected,
  busy,
  compact,
  onToggle,
}: ScheduleItemProps): ReactElement {
  const active = schedule.status === "active";
  const next =
    schedule.status === "paused"
      ? "Paused"
      : schedule.next_run_at === null
        ? "No future run"
        : `Next ${formatScheduleDate(schedule.next_run_at, schedule.time_zone)}`;
  return (
    <div
      className={cn("row row-schedule", compact && "schedItem", selected && "schedItem-selected")}
      aria-current={selected ? "page" : undefined}
    >
      <a className="row-copy" {...routeLink({ tab: "schedules", detail: schedule.id })}>
        <span className={cn("row-label", !active && "text-muted")}>{schedule.name}</span>
        <span className="row-detail">{`${humanizeRrule(schedule.rrule)} · ${next}`}</span>
        {schedule.deferral_reason === null ? undefined : (
          <span className="row-detail text-warning">Waiting: {schedule.deferral_reason}</span>
        )}
      </a>
      <Switch
        size={compact ? "s" : "m"}
        checked={active}
        disabled={busy}
        aria-label={`${schedule.name}: ${active ? "active" : "paused"}`}
        onCheckedChange={onToggle}
      />
    </div>
  );
}

interface ScheduleEditorProps {
  readonly schedule: ManagedSchedule | undefined;
  readonly desktop: boolean;
  readonly onSaved: (schedule: ManagedSchedule, created: boolean) => void;
  readonly onDeleted: (schedule: ManagedSchedule) => void;
}

function ScheduleEditor(props: ScheduleEditorProps): ReactElement {
  const [initialDraft] = useState<ScheduleDraft>(() => scheduleDraft(props.schedule));
  const [draft, setDraft] = useState<ScheduleDraft>(initialDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [idempotencyKey] = useState(scheduleAttemptId);
  const existing = props.schedule;
  const dirty = !scheduleDraftsEqual(draft, initialDraft);
  useUnsavedChanges(dirty);

  const cancel = useCallback((): void => {
    if (saving) return;
    if (!dirty) {
      navigate(schedulesRoute);
      return;
    }
    void confirmDiscardChanges("Discard this schedule draft?").then((confirmed) => {
      if (confirmed) navigate(schedulesRoute, { force: true });
    });
  }, [dirty, saving]);
  useTelegramBackButton(saving || deleting ? undefined : cancel);

  const setValue = <Key extends keyof ScheduleDraft>(key: Key, value: ScheduleDraft[Key]): void => {
    setError(undefined);
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const submit = async (): Promise<void> => {
    if (saving) return;
    const validationError = validateScheduleDraft(draft);
    if (validationError !== undefined) {
      setError(validationError);
      notifyHaptic("warning");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const values = {
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        rrule: rruleFromDraft(draft),
        time_zone: draft.timeZone.trim(),
        notification_policy: draft.notificationPolicy,
      };
      const schedule =
        existing === undefined
          ? await requestCreateSchedule({ ...values, idempotency_key: idempotencyKey })
          : await requestUpdateSchedule(existing.id, {
              ...values,
              expected_revision: existing.revision,
            });
      notifyHaptic("success");
      props.onSaved(schedule, existing === undefined);
    } catch (saveError) {
      setError(messageOf(saveError));
      notifyHaptic("error");
    } finally {
      setSaving(false);
    }
  };
  const remove = async (): Promise<void> => {
    if (existing === undefined || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(undefined);
    try {
      await requestDeleteSchedule(existing.id);
      notifyHaptic("success");
      setDeleting(false);
      props.onDeleted(existing);
    } catch (removeError) {
      setDeleteError(messageOf(removeError));
      notifyHaptic("error");
    } finally {
      setDeleteBusy(false);
    }
  };

  const title = existing === undefined ? "New schedule" : "Edit schedule";
  const saveLabel = existing === undefined ? "Create schedule" : "Save changes";
  const showInterval = ["daily", "hourly", "minutely", "weekly"].includes(draft.cadence);
  const showTime = ["daily", "hourly", "weekdays", "weekly"].includes(draft.cadence);
  const timeZoneInput = (
    <input
      id="schedule-time-zone"
      className="control"
      value={draft.timeZone}
      maxLength={128}
      autoComplete="off"
      spellCheck={false}
      placeholder="Europe/Warsaw"
      aria-label="Time zone"
      disabled={saving}
      onChange={(event) => setValue("timeZone", event.currentTarget.value)}
    />
  );
  const timeInput =
    draft.cadence === "hourly" ? (
      <input
        id="schedule-time"
        className="control"
        type="number"
        inputMode="numeric"
        min={0}
        max={59}
        value={draft.time.slice(3)}
        aria-label="Minute of the hour"
        disabled={saving}
        onChange={(event) => setValue("time", `00:${event.currentTarget.value.padStart(2, "0")}`)}
      />
    ) : (
      <input
        id="schedule-time"
        className="control"
        type="time"
        value={draft.time}
        aria-label="Time"
        disabled={saving}
        onChange={(event) => setValue("time", event.currentTarget.value)}
      />
    );
  const timeLabel = draft.cadence === "hourly" ? "At minute" : "Time";
  const summary = scheduleSummary(draft);
  const deleteDialog =
    deleting && existing !== undefined ? (
      <ConfirmDialog
        title={`Delete “${existing.name}”?`}
        description="This permanently removes the schedule and its retained run history. It cannot be undone."
        error={deleteError}
        busy={deleteBusy}
        confirmLabel="Delete schedule"
        onCancel={() => {
          if (!deleteBusy) setDeleting(false);
        }}
        onConfirm={() => void remove()}
      />
    ) : undefined;

  const fields = (
    <>
      {error === undefined ? undefined : <Notice tone="error">{error}</Notice>}
      <Field label="Name" htmlFor="schedule-name">
        <input
          id="schedule-name"
          className="control"
          value={draft.name}
          maxLength={200}
          autoComplete="off"
          placeholder="Daily project check"
          disabled={saving}
          onChange={(event) => setValue("name", event.currentTarget.value)}
        />
      </Field>
      <Field
        label="Instructions"
        htmlFor="schedule-prompt"
        hint={
          existing?.kind === "heartbeat"
            ? "The full prompt Claude receives on every run. This heartbeat continues its original session."
            : "The full prompt Claude receives on every run. Each run starts a fresh session."
        }
      >
        <ExpandableTextarea
          id="schedule-prompt"
          className="control-prompt"
          label="schedule instructions"
          value={draft.prompt}
          maxLength={20_000}
          rows={props.desktop ? 5 : 4}
          placeholder="Check the repository for failed CI runs and summarize anything actionable."
          disabled={saving}
          onValueChange={(value) => setValue("prompt", value)}
        />
      </Field>
      <Rule />
      <Field label="Repeats" htmlFor="schedule-cadence">
        <select
          id="schedule-cadence"
          className="control control-select"
          value={draft.cadence}
          disabled={saving}
          onChange={(event) => setValue("cadence", event.currentTarget.value as ScheduleCadence)}
        >
          <option value="minutely">Every few minutes</option>
          <option value="hourly">Hourly</option>
          <option value="daily">Daily</option>
          <option value="weekdays">Weekdays</option>
          <option value="weekly">Weekly</option>
          <option value="custom">Custom RRULE</option>
        </select>
      </Field>
      {showInterval ? (
        <Field label="Every" htmlFor="schedule-interval">
          <div className="intervalControl">
            <input
              id="schedule-interval"
              className="control"
              type="number"
              inputMode="numeric"
              min={1}
              max={1_000}
              value={draft.interval}
              disabled={saving}
              onChange={(event) => setValue("interval", event.currentTarget.value)}
            />
            <span className="intervalControl-unit">
              {cadenceUnit(draft.cadence, Number(draft.interval))}
            </span>
          </div>
        </Field>
      ) : undefined}
      {showTime ? (
        props.desktop ? (
          <Field label={timeLabel} htmlFor="schedule-time" hint={summary}>
            <div className="timeRow">
              {timeInput}
              {timeZoneInput}
            </div>
          </Field>
        ) : (
          <>
            <div className="fieldRow">
              <Field label={timeLabel} htmlFor="schedule-time">
                {timeInput}
              </Field>
              <Field label="Time zone" htmlFor="schedule-time-zone">
                {timeZoneInput}
              </Field>
            </div>
            <Hint className="form-inlineHint">{summary}</Hint>
          </>
        )
      ) : (
        <Field label="Time zone" htmlFor="schedule-time-zone" hint={summary}>
          {timeZoneInput}
        </Field>
      )}
      {draft.cadence === "weekly" ? (
        <Field label="Days" as="span" hint="Choose one or more days.">
          <fieldset className="weekdays">
            <legend className="srOnly">Days of the week</legend>
            {weekdayOptions.map(([value, label]) => {
              const selected = draft.days.includes(value);
              return (
                <button
                  key={value}
                  type="button"
                  className={cn("weekday", selected && "weekday-selected")}
                  aria-pressed={selected}
                  aria-label={label}
                  disabled={saving}
                  onClick={() =>
                    setValue(
                      "days",
                      selected ? draft.days.filter((day) => day !== value) : [...draft.days, value],
                    )
                  }
                >
                  {label.slice(0, 2)}
                </button>
              );
            })}
          </fieldset>
        </Field>
      ) : undefined}
      {draft.cadence === "custom" ? (
        <Field
          label="RRULE"
          htmlFor="schedule-rrule"
          hint="One bounded RRULE line; DTSTART is managed by Wirebot."
        >
          <ExpandableTextarea
            id="schedule-rrule"
            className="control-mono"
            label="custom RRULE"
            value={draft.customRrule}
            rows={3}
            maxLength={4_096}
            spellCheck={false}
            disabled={saving}
            onValueChange={(value) => setValue("customRrule", value)}
          />
        </Field>
      ) : undefined}
      <Rule />
      <Field
        label="Notify me"
        htmlFor="schedule-notifications"
        hint="Runs still happen when notifications are off."
      >
        <select
          id="schedule-notifications"
          className="control control-select"
          value={draft.notificationPolicy}
          disabled={saving}
          onChange={(event) =>
            setValue(
              "notificationPolicy",
              event.currentTarget.value as ManagedSchedule["notification_policy"],
            )
          }
        >
          <option value="always">After every run</option>
          <option value="on-result">Only when there is something to report</option>
          <option value="never">Never</option>
        </select>
      </Field>
    </>
  );

  if (props.desktop) {
    return (
      <>
        <ContentHeader
          crumbs={
            existing === undefined ? ["Schedules", "New schedule"] : ["Editing", existing.name]
          }
        >
          {existing === undefined ? undefined : (
            <Button
              variant="secondary"
              size="s"
              className="btn-dangerText"
              disabled={saving}
              onClick={() => {
                setDeleteError(undefined);
                setDeleting(true);
              }}
            >
              Delete
            </Button>
          )}
          <Button
            size="s"
            loading={saving}
            disabled={existing !== undefined && !dirty}
            onClick={() => void submit()}
          >
            {existing === undefined ? "Create" : "Save"}
          </Button>
        </ContentHeader>
        <main className="paneBody">
          <div className="form form-narrow">{fields}</div>
        </main>
        {deleteDialog}
      </>
    );
  }
  return (
    <Screen className="screen-subpage">
      <SubpageHeader back={{ label: "Schedules", route: schedulesRoute }} title={title} />
      <ScreenBody className="form screenBody-withBar">
        {fields}
        {existing === undefined ? undefined : (
          <Button
            variant="secondary"
            size="l"
            stretched
            className="btn-dangerText deleteButton"
            disabled={saving}
            onClick={() => {
              setDeleteError(undefined);
              setDeleting(true);
            }}
          >
            Delete schedule
          </Button>
        )}
      </ScreenBody>
      <BottomBar>
        <Button
          size="l"
          stretched
          loading={saving}
          disabled={existing !== undefined && !dirty}
          onClick={() => void submit()}
        >
          {saveLabel}
        </Button>
      </BottomBar>
      {deleteDialog}
    </Screen>
  );
}

function compareSchedules(left: ManagedSchedule, right: ManagedSchedule): number {
  if (left.status !== right.status) return left.status === "active" ? -1 : 1;
  const leftNext = left.next_run_at ?? "9999";
  const rightNext = right.next_run_at ?? "9999";
  const nextOrder = leftNext.localeCompare(rightNext);
  return nextOrder === 0 ? left.name.localeCompare(right.name) : nextOrder;
}

function scheduleDraft(schedule: ManagedSchedule | undefined): ScheduleDraft {
  const now = new Date();
  const defaultTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const defaultTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (schedule === undefined) {
    return {
      name: "",
      prompt: "",
      cadence: "daily",
      interval: "1",
      time: defaultTime,
      days: ["MO"],
      customRrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      timeZone: defaultTimeZone,
      notificationPolicy: "always",
    };
  }

  const fields = parseRruleFields(schedule.rrule);
  const frequency = fields?.get("FREQ");
  const interval = fields?.get("INTERVAL") ?? "1";
  const hour = fields?.get("BYHOUR") ?? "0";
  const minute = fields?.get("BYMINUTE") ?? "0";
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  const days = fields?.get("BYDAY")?.split(",") ?? ["MO"];
  let cadence: ScheduleCadence = "custom";
  if (fields !== undefined && hasOnlyFields(fields, ["FREQ", "INTERVAL"])) {
    if (frequency === "MINUTELY") cadence = "minutely";
  }
  if (
    fields !== undefined &&
    frequency === "HOURLY" &&
    fields.has("BYMINUTE") &&
    hasOnlyFields(fields, ["FREQ", "INTERVAL", "BYMINUTE"]) &&
    isSingleInteger(minute, 0, 59)
  ) {
    cadence = "hourly";
  }
  if (
    fields !== undefined &&
    frequency === "DAILY" &&
    fields.has("BYHOUR") &&
    fields.has("BYMINUTE") &&
    hasOnlyFields(fields, ["FREQ", "INTERVAL", "BYHOUR", "BYMINUTE"]) &&
    isClockFields(hour, minute)
  ) {
    cadence = "daily";
  }
  if (
    fields !== undefined &&
    frequency === "WEEKLY" &&
    fields.has("BYDAY") &&
    fields.has("BYHOUR") &&
    fields.has("BYMINUTE") &&
    hasOnlyFields(fields, ["FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE"]) &&
    isClockFields(hour, minute) &&
    days.every((day) => weekdayOptions.some(([value]) => value === day))
  ) {
    cadence = sameWeekdays(days, ["MO", "TU", "WE", "TH", "FR"]) ? "weekdays" : "weekly";
  }
  return {
    name: schedule.name,
    prompt: schedule.prompt,
    cadence,
    interval,
    time: isClockFields(hour, minute) ? time : defaultTime,
    days,
    customRrule: schedule.rrule,
    timeZone: schedule.time_zone,
    notificationPolicy: schedule.notification_policy,
  };
}

function scheduleDraftsEqual(left: ScheduleDraft, right: ScheduleDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateScheduleDraft(draft: ScheduleDraft): string | undefined {
  if (draft.name.trim().length === 0) return "Add a schedule name.";
  if (draft.prompt.trim().length === 0) return "Add instructions for Claude.";
  if (draft.timeZone.trim().length === 0) return "Add an IANA time zone, such as Europe/Warsaw.";
  if (["daily", "hourly", "minutely", "weekly"].includes(draft.cadence)) {
    const interval = Number(draft.interval);
    if (!Number.isInteger(interval) || interval < 1 || interval > 1_000) {
      return "The repeat interval must be a whole number from 1 to 1000.";
    }
  }
  if (["daily", "hourly", "weekdays", "weekly"].includes(draft.cadence)) {
    const [hour, minute] = draft.time.split(":").map(Number);
    if (
      !Number.isInteger(hour) ||
      !Number.isInteger(minute) ||
      hour === undefined ||
      minute === undefined ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      return draft.cadence === "hourly" ? "Choose a minute from 0 to 59." : "Choose a valid time.";
    }
  }
  if (draft.cadence === "weekly" && draft.days.length === 0) {
    return "Choose at least one day.";
  }
  if (draft.cadence === "custom" && draft.customRrule.trim().length === 0) {
    return "Add a custom RRULE.";
  }
  return undefined;
}

function rruleFromDraft(draft: ScheduleDraft): string {
  if (draft.cadence === "custom") return draft.customRrule.trim();
  const interval = Number(draft.interval);
  const intervalField = interval === 1 ? "" : `;INTERVAL=${interval}`;
  const [hour = "0", minute = "0"] = draft.time.split(":");
  switch (draft.cadence) {
    case "minutely":
      return `FREQ=MINUTELY${intervalField}`;
    case "hourly":
      return `FREQ=HOURLY${intervalField};BYMINUTE=${Number(minute)}`;
    case "daily":
      return `FREQ=DAILY${intervalField};BYHOUR=${Number(hour)};BYMINUTE=${Number(minute)}`;
    case "weekdays":
      return `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=${Number(hour)};BYMINUTE=${Number(minute)}`;
    case "weekly":
      return `FREQ=WEEKLY${intervalField};BYDAY=${orderedWeekdays(draft.days).join(",")};BYHOUR=${Number(hour)};BYMINUTE=${Number(minute)}`;
  }
}

/** "Runs weekdays at 09:00, following daylight-saving changes in Europe/Warsaw." */
function scheduleSummary(draft: ScheduleDraft): string {
  const timeZone = draft.timeZone.trim();
  const zone = timeZone.length === 0 ? "the selected time zone" : timeZone;
  if (draft.cadence === "custom") {
    const rule = draft.customRrule.trim();
    const described = rule.length === 0 ? undefined : humanizeRrule(rule);
    return described === undefined || described === rule
      ? `Runs on the custom rule, following daylight-saving changes in ${zone}.`
      : `Runs ${lowerFirst(described)}, following daylight-saving changes in ${zone}.`;
  }
  if (validateScheduleDraft({ ...draft, name: "x", prompt: "x", timeZone: "UTC" }) !== undefined) {
    return `Times use ${zone}, including daylight-saving changes.`;
  }
  return `Runs ${lowerFirst(humanizeRrule(rruleFromDraft(draft)))}, following daylight-saving changes in ${zone}.`;
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toLowerCase()}${value.slice(1)}`;
}

function humanizeRrule(rule: string): string {
  const fields = parseRruleFields(rule);
  if (fields === undefined) return rule;
  const interval = Number(fields.get("INTERVAL") ?? "1");
  const frequency = fields.get("FREQ");
  const minute = fields.get("BYMINUTE");
  const hour = fields.get("BYHOUR");
  if (!Number.isInteger(interval) || interval < 1) return rule;
  if (frequency === "MINUTELY") {
    return interval === 1 ? "Every minute" : `Every ${interval} minutes`;
  }
  if (frequency === "HOURLY" && minute !== undefined) {
    const suffix = `at :${minute.padStart(2, "0")}`;
    return interval === 1 ? `Every hour ${suffix}` : `Every ${interval} hours ${suffix}`;
  }
  const formattedTime =
    hour !== undefined && minute !== undefined
      ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`
      : undefined;
  if (frequency === "DAILY" && formattedTime !== undefined) {
    return interval === 1
      ? `Daily at ${formattedTime}`
      : `Every ${interval} days at ${formattedTime}`;
  }
  if (frequency === "WEEKLY" && formattedTime !== undefined) {
    const days = fields.get("BYDAY")?.split(",") ?? [];
    if (sameWeekdays(days, ["MO", "TU", "WE", "TH", "FR"])) {
      return `Weekdays at ${formattedTime}`;
    }
    const labels = orderedWeekdays(days)
      .map((day) => weekdayOptions.find(([value]) => value === day)?.[1])
      .filter(isDefined);
    if (labels.length > 0) {
      const prefix =
        interval === 1 ? labels.join(", ") : `Every ${interval} weeks · ${labels.join(", ")}`;
      return `${prefix} at ${formattedTime}`;
    }
  }
  return rule;
}

function parseRruleFields(rule: string): ReadonlyMap<string, string> | undefined {
  const normalized = rule.trim().replace(/^RRULE:/iu, "");
  if (normalized.length === 0 || /[\r\n]/u.test(normalized)) return undefined;
  const fields = new Map<string, string>();
  for (const component of normalized.split(";")) {
    const separator = component.indexOf("=");
    if (separator <= 0 || separator === component.length - 1) return undefined;
    const key = component.slice(0, separator).trim().toUpperCase();
    const value = component
      .slice(separator + 1)
      .trim()
      .toUpperCase();
    if (fields.has(key)) return undefined;
    fields.set(key, value);
  }
  return fields;
}

function hasOnlyFields(fields: ReadonlyMap<string, string>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return [...fields.keys()].every((key) => allowedSet.has(key));
}

function isClockFields(hour: string, minute: string): boolean {
  return isSingleInteger(hour, 0, 23) && isSingleInteger(minute, 0, 59);
}

function isSingleInteger(value: string, minimum: number, maximum: number): boolean {
  if (!/^\d{1,2}$/u.test(value)) return false;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum;
}

function orderedWeekdays(days: readonly string[]): string[] {
  const selected = new Set(days);
  return weekdayOptions.map(([value]) => value).filter((day) => selected.has(day));
}

function sameWeekdays(left: readonly string[], right: readonly string[]): boolean {
  return orderedWeekdays(left).join(",") === orderedWeekdays(right).join(",");
}

function cadenceUnit(cadence: ScheduleCadence, amount: number): string {
  const singular =
    cadence === "minutely"
      ? "minute"
      : cadence === "hourly"
        ? "hour"
        : cadence === "daily"
          ? "day"
          : "week";
  return amount === 1 ? singular : `${singular}s`;
}

function formatScheduleDate(value: string, timeZone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  try {
    const time = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    }).format(date);
    const dayKey = (candidate: Date): string =>
      new Intl.DateTimeFormat("en-CA", { dateStyle: "short", timeZone }).format(candidate);
    const now = new Date();
    if (dayKey(date) === dayKey(now)) return `today ${time}`;
    const withinWeek = date.getTime() - now.getTime() < 6 * 86_400_000;
    const day = new Intl.DateTimeFormat(undefined, {
      ...(withinWeek
        ? { weekday: "short" as const }
        : { month: "short" as const, day: "numeric" as const }),
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
      timeZone,
    }).format(date);
    return `${day} ${time}`;
  } catch {
    return date.toLocaleString();
  }
}

function scheduleAttemptId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `schedule-${Date.now()}-${Math.random()}`;
}
