import type { Database } from "../db/database.js";
import {
  appendEvent,
  claimDueSchedules,
  createTask,
  getTask,
  listOrgIds,
  updateSchedule,
} from "../db/repos.js";
import type { Schedule } from "../core/types.js";
import { planGoal } from "./planner.js";

function zoneParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

/** Convert a wall-clock time in an IANA zone to the matching UTC instant. */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = zoneParts(guess, timeZone);
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
    );
    const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
    const delta = wanted - represented;
    if (delta === 0) break;
    guess = new Date(guess.getTime() + delta);
  }
  return guess;
}

export function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** The next instant this schedule should fire, strictly after `from`. */
export function nextRunAt(schedule: Pick<Schedule, "kind" | "intervalMinutes" | "hour" | "minute" | "timezone">, from = new Date()): Date {
  if (schedule.kind === "interval") {
    const minutes = Math.max(5, schedule.intervalMinutes ?? 60);
    return new Date(from.getTime() + minutes * 60_000);
  }

  const timeZone = validTimezone(schedule.timezone) ? schedule.timezone : "UTC";
  const hour = Math.min(23, Math.max(0, schedule.hour ?? 8));
  const minute = Math.min(59, Math.max(0, schedule.minute ?? 0));
  const parts = zoneParts(from, timeZone);
  let candidate = zonedTimeToUtc(parts.year, parts.month, parts.day, hour, minute, timeZone);
  if (candidate.getTime() <= from.getTime()) {
    const nextDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
    candidate = zonedTimeToUtc(
      nextDay.getUTCFullYear(),
      nextDay.getUTCMonth() + 1,
      nextDay.getUTCDate(),
      hour,
      minute,
      timeZone,
    );
  }
  return candidate;
}

export interface ScheduledTask {
  scheduleId: string;
  taskId: string;
  title: string;
  nextRunAt: string;
}

export interface SkippedSchedule {
  scheduleId: string;
  title: string;
  reason: string;
  nextRunAt: string;
}

export interface DueScheduleDispatch {
  scheduled: ScheduledTask[];
  skipped: SkippedSchedule[];
}

const ACTIVE_TASK_STATUSES = ["queued", "scheduled", "running", "waiting_approval", "paused"];

/**
 * Dispatch due schedules as ordinary queued tasks. The schedule row is locked
 * with SKIP LOCKED and updated in the same transaction as task creation, so two
 * overlapping cron invocations cannot create the same run twice.
 */
export async function runDueSchedules(
  database: Database,
  options: { limitPerOrg?: number } = {},
): Promise<DueScheduleDispatch> {
  const created: ScheduledTask[] = [];
  const skipped: SkippedSchedule[] = [];
  const orgIds = await listOrgIds(database.driver);
  for (const orgId of orgIds) {
    const batch = await database.withTenant(orgId, "service", async (conn) => {
      const due = await claimDueSchedules(conn, orgId, options.limitPerOrg ?? 20);
      const dispatched: ScheduledTask[] = [];
      const deferred: SkippedSchedule[] = [];
      for (const schedule of due) {
        const now = new Date();
        const previous = schedule.lastTaskId ? await getTask(conn, schedule.lastTaskId) : null;
        if (previous && ACTIVE_TASK_STATUSES.includes(previous.status)) {
          const reason = `Previous run is still ${previous.status.replace(/_/g, " ")}`;
          const next = nextRunAt(schedule, now);
          await updateSchedule(conn, schedule.id, orgId, schedule.userId, {
            lastSkippedAt: now,
            lastSkipReason: reason,
            nextRunAt: next,
          });
          deferred.push({
            scheduleId: schedule.id,
            title: schedule.title,
            reason,
            nextRunAt: next.toISOString(),
          });
          continue;
        }

        const plan = planGoal(schedule.goal);
        const task = await createTask(conn, {
          orgId,
          userId: schedule.userId,
          title: schedule.title,
          goal: schedule.goal,
          plan,
        });
        await appendEvent(conn, {
          orgId,
          taskId: task.id,
          kind: "plan",
          title: "Scheduled run started",
          data: { plan, scheduleId: schedule.id },
        });
        const next = nextRunAt(schedule, now);
        await updateSchedule(conn, schedule.id, orgId, schedule.userId, {
          lastRunAt: now,
          nextRunAt: next,
          lastTaskId: task.id,
        });
        dispatched.push({
          scheduleId: schedule.id,
          taskId: task.id,
          title: schedule.title,
          nextRunAt: next.toISOString(),
        });
      }
      return { dispatched, deferred };
    });
    created.push(...batch.dispatched);
    skipped.push(...batch.deferred);
  }
  return { scheduled: created, skipped };
}
