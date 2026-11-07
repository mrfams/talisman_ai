import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity as ActivityIcon,
  CalendarDays,
  ListChecks,
  LogIn,
  Search,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { api, type AuditEntry } from "../lib/api";
import { errorMessage, useMe } from "../lib/queries";
import { Badge, Card, Empty, Notice, Skeleton } from "../ui";

function iconFor(eventType: string) {
  if (eventType.includes("auth") || eventType.includes("session")) return <LogIn size={13} />;
  if (eventType.includes("task")) return <ListChecks size={13} />;
  if (eventType.includes("approval")) return <ShieldCheck size={13} />;
  if (eventType.includes("calendar")) return <CalendarDays size={13} />;
  if (eventType.includes("device") || eventType.includes("phone")) return <Smartphone size={13} />;
  return <ActivityIcon size={13} />;
}

function label(eventType: string): string {
  return eventType.replace(/[._]/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function dayKey(iso: string): string {
  const date = new Date(iso);
  return date.toDateString();
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function Activity() {
  const query = useQuery({ queryKey: ["activity"], queryFn: api.activity, retry: false });
  const team = useQuery({ queryKey: ["team"], queryFn: api.team });
  const me = useMe();
  const [filter, setFilter] = useState("");

  const people = new Map(
    (team.data?.members ?? []).map((member) => [member.userId, member.name ?? member.email]),
  );

  const needle = filter.trim().toLowerCase();
  const rows = (query.data?.events ?? []).filter(
    (event: AuditEntry) =>
      !needle ||
      `${event.eventType} ${event.targetType} ${event.targetId ?? ""}`
        .toLowerCase()
        .includes(needle),
  );

  const groups: { key: string; label: string; events: AuditEntry[] }[] = [];
  for (const event of rows) {
    const key = dayKey(event.createdAt);
    const existing = groups.find((group) => group.key === key);
    if (existing) existing.events.push(event);
    else groups.push({ key, label: dayLabel(event.createdAt), events: [event] });
  }

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="page-title">Activity</h1>
          <p className="page-sub">
            Every action that changed something: who did it, what it touched, and when.
          </p>
        </div>
        <label className="search">
          <Search size={13} aria-hidden />
          <input
            placeholder="Filter events"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            aria-label="Filter activity"
          />
        </label>
      </div>

      {query.isError ? (
        <Notice tone="warn">
          {errorMessage(query.error)} Ask an owner or admin if you need this view.
        </Notice>
      ) : null}

      <Card flush>
        {query.isLoading ? (
          <div className="card-body stack">
            <Skeleton h={14} />
            <Skeleton h={14} w="80%" />
            <Skeleton h={14} w="65%" />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: "var(--space-2) 0" }}>
            <Empty
              icon={<ActivityIcon size={15} />}
              title={needle ? "No events match" : "Nothing has happened yet"}
              body={
                needle
                  ? "Clear the filter to see the full log."
                  : "Signing in, creating a run, approving an action: each one appears here with its actor and target."
              }
            />
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.key}>
              <div className="day-head">{group.label}</div>
              <div className="list">
                {group.events.map((event) => (
                  <div className="list-item" key={event.id} style={{ alignItems: "center" }}>
                    <span className="event-icon">{iconFor(event.eventType)}</span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="small" style={{ color: "var(--text)" }}>
                        {label(event.eventType)}
                      </div>
                      <div className="tiny faint">
                        <span className="mono">{event.targetType}</span>
                        {event.targetId ? (
                          event.targetType.includes("task") ? (
                            <Link
                              to={`/tasks/${event.targetId}`}
                              className="mono"
                              style={{ color: "var(--muted)" }}
                            >
                              {" "}
                              · {event.targetId.slice(0, 8)}
                            </Link>
                          ) : (
                            <span className="mono"> · {event.targetId.slice(0, 12)}</span>
                          )
                        ) : null}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 12 }}>
                      <span className="tiny muted truncate" style={{ maxWidth: 140 }}>
                        {event.actorUserId
                          ? event.actorUserId === me.data?.user.id
                            ? "You"
                            : (people.get(event.actorUserId) ?? event.actorUserId.slice(0, 8))
                          : "system"}
                      </span>
                      <span className="mono tiny faint event-time">{time(event.createdAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </Card>

      {rows.length ? (
        <div className="row-between">
          <span className="count-note">
            {rows.length} event{rows.length === 1 ? "" : "s"}
          </span>
          <Badge>Append-only</Badge>
        </div>
      ) : null}
    </div>
  );
}
