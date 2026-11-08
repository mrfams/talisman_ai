import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Pause, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, type ScheduleKind } from "../lib/api";
import { errorMessage } from "../lib/queries";
import { Badge, Button, Card, Empty, Field, Input, Notice, Skeleton, Textarea, timeAgo } from "../ui";

function when(iso: string | null): string {
  if (!iso) return "not yet";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function cadence(schedule: {
  kind: ScheduleKind;
  intervalMinutes: number | null;
  hour: number | null;
  minute: number | null;
  timezone: string;
}): string {
  if (schedule.kind === "daily") {
    const time = `${String(schedule.hour ?? 0).padStart(2, "0")}:${String(
      schedule.minute ?? 0,
    ).padStart(2, "0")}`;
    return `Every day at ${time} (${schedule.timezone})`;
  }
  const minutes = schedule.intervalMinutes ?? 60;
  if (minutes % 1440 === 0) return `Every ${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `Every ${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `Every ${minutes} minutes`;
}

function NewSchedule({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("interval");
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [hour, setHour] = useState(8);
  const [minute, setMinute] = useState(0);
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [problem, setProblem] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createSchedule({
        title: title.trim() || goal.trim().slice(0, 80),
        goal: goal.trim(),
        kind,
        intervalMinutes: kind === "interval" ? intervalMinutes : undefined,
        hour: kind === "daily" ? hour : undefined,
        minute: kind === "daily" ? minute : undefined,
        timezone,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["schedules"] });
      onClose();
    },
    onError: (error) => setProblem(errorMessage(error)),
  });

  return (
    <Card>
      <div className="row-between" style={{ alignItems: "flex-start", gap: 12 }}>
        <div>
          <h2 className="section-title">New recurring run</h2>
          <p className="small muted" style={{ marginTop: 4, maxWidth: 620, lineHeight: 1.55 }}>
            Each due time creates a normal durable run. It keeps the same approvals, receipts and
            artifacts as a run you start by hand.
          </p>
        </div>
        <Button size="sm" variant="quiet" onClick={onClose}>
          Close
        </Button>
      </div>

      {problem ? <Notice tone="bad">{problem}</Notice> : null}

      <div className="schedule-form">
        <Field label="Name">
          <Input
            value={title}
            maxLength={200}
            placeholder="Monday morning brief"
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="What should it do?" hint="This is the goal handed to a fresh run each time.">
          <Textarea
            value={goal}
            rows={3}
            maxLength={20_000}
            placeholder="Research the last week in AI and prepare a one-page brief."
            onChange={(event) => setGoal(event.target.value)}
          />
        </Field>
        <div className="schedule-form-row">
          <Field label="Repeat">
            <select
              className="select"
              value={kind}
              onChange={(event) => setKind(event.target.value as ScheduleKind)}
            >
              <option value="interval">Every few minutes or hours</option>
              <option value="daily">Every day at a time</option>
            </select>
          </Field>
          {kind === "interval" ? (
            <Field label="Interval (minutes)">
              <Input
                type="number"
                min={5}
                max={10_080}
                value={intervalMinutes}
                onChange={(event) => setIntervalMinutes(Number(event.target.value))}
              />
            </Field>
          ) : (
            <Field label="Time">
              <div className="row" style={{ gap: 6 }}>
                <Input
                  type="number"
                  min={0}
                  max={23}
                  aria-label="Hour"
                  value={hour}
                  onChange={(event) => setHour(Number(event.target.value))}
                  style={{ width: 76 }}
                />
                <span className="muted">:</span>
                <Input
                  type="number"
                  min={0}
                  max={59}
                  aria-label="Minute"
                  value={minute}
                  onChange={(event) => setMinute(Number(event.target.value))}
                  style={{ width: 76 }}
                />
              </div>
            </Field>
          )}
        </div>
        <Field
          label="Timezone"
          hint="IANA names such as Europe/London or America/New_York. Daily runs follow this zone across daylight saving."
        >
          <Input
            value={timezone}
            maxLength={80}
            onChange={(event) => setTimezone(event.target.value)}
          />
        </Field>
        <div className="row">
          <Button
            variant="primary"
            busy={create.isPending}
            disabled={goal.trim().length < 3 || !timezone.trim()}
            onClick={() => {
              setProblem(null);
              create.mutate();
            }}
          >
            Create schedule
          </Button>
          <span className="tiny faint">
            Starts {when(new Date(Date.now() + (kind === "interval" ? intervalMinutes : 0) * 60_000).toISOString())}
          </span>
        </div>
      </div>
    </Card>
  );
}

export function Schedules() {
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });

  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      api.updateSchedule(input.id, { enabled: input.enabled }),
    onSuccess: async () => client.invalidateQueries({ queryKey: ["schedules"] }),
    onError: (error) => setProblem(errorMessage(error)),
  });
  const runNow = useMutation({
    mutationFn: api.runSchedule,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["schedules"] });
      await client.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => setProblem(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: api.deleteSchedule,
    onSuccess: async () => client.invalidateQueries({ queryKey: ["schedules"] }),
    onError: (error) => setProblem(errorMessage(error)),
  });

  const schedules = query.data?.schedules ?? [];
  const enabled = schedules.filter((schedule) => schedule.enabled).length;

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="page-title">Schedules</h1>
          <p className="page-sub">
            Recurring work that does not depend on you remembering. Runs still ask before anything
            sends, pays or deletes.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {enabled > 0 ? <Badge tone="live">{enabled} active</Badge> : null}
          <Button
            variant="primary"
            size="sm"
            icon={<Plus size={13} />}
            onClick={() => setCreating((open) => !open)}
          >
            New schedule
          </Button>
        </div>
      </div>

      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      {creating ? <NewSchedule onClose={() => setCreating(false)} /> : null}

      {query.isLoading ? (
        <Card>
          <Skeleton h={90} />
        </Card>
      ) : query.isError ? (
        <Notice tone="bad">{errorMessage(query.error)}</Notice>
      ) : schedules.length === 0 && !creating ? (
        <Card>
          <Empty
            icon={<CalendarClock size={15} />}
            title="Nothing repeats yet"
            body="Schedule a brief, a check of a page, or a recurring research pass. Talisman will queue it on time even when this tab is closed."
            action={
              <Button size="sm" variant="primary" icon={<Plus size={12} />} onClick={() => setCreating(true)}>
                Create the first one
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="stack" style={{ gap: "var(--space-3)" }}>
          {schedules.map((schedule) => (
            <Card key={schedule.id}>
              <div className="row-between wrap" style={{ alignItems: "flex-start", gap: 12 }}>
                <div className="row" style={{ gap: 10, minWidth: 0 }}>
                  <span className="provider-icon" style={{ width: 30, height: 30 }}>
                    <CalendarClock size={14} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="provider-name truncate">{schedule.title}</div>
                    <div className="tiny faint">{cadence(schedule)}</div>
                  </div>
                </div>
                <div className="row wrap" style={{ gap: 7 }}>
                  <Badge tone={schedule.enabled ? "ok" : "plain"}>
                    {schedule.enabled ? "Active" : "Paused"}
                  </Badge>
                  <Button
                    size="sm"
                    icon={<RefreshCw size={12} />}
                    busy={runNow.isPending}
                    onClick={() => {
                      setProblem(null);
                      runNow.mutate(schedule.id);
                    }}
                  >
                    Run now
                  </Button>
                  <Button
                    size="sm"
                    icon={schedule.enabled ? <Pause size={12} /> : <Play size={12} />}
                    busy={toggle.isPending}
                    onClick={() => toggle.mutate({ id: schedule.id, enabled: !schedule.enabled })}
                  >
                    {schedule.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Trash2 size={12} />}
                    busy={remove.isPending}
                    onClick={() => {
                      if (window.confirm(`Delete “${schedule.title}”?`)) remove.mutate(schedule.id);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>

              <p className="small muted" style={{ marginTop: 10, lineHeight: 1.55 }}>
                {schedule.goal}
              </p>

              <div className="row wrap" style={{ gap: 16, marginTop: 12 }}>
                <span className="tiny faint">Next {when(schedule.nextRunAt)}</span>
                <span className="tiny faint">
                  Last {schedule.lastRunAt ? timeAgo(schedule.lastRunAt) : "never"}
                </span>
                {schedule.lastTaskId ? (
                  <Link className="tiny" to={`/tasks/${schedule.lastTaskId}`}>
                    Open last run
                  </Link>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
