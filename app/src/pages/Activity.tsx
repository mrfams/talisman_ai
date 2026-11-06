import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity as ActivityIcon, Search } from "lucide-react";
import { api } from "../lib/api";
import { errorMessage } from "../lib/queries";
import { Badge, Card, Empty, Input, Notice, Skeleton, timeAgo } from "../ui";

export function Activity() {
  const query = useQuery({ queryKey: ["activity"], queryFn: api.activity, retry: false });
  const [filter, setFilter] = useState("");

  const rows = (query.data?.events ?? []).filter((event) =>
    `${event.eventType} ${event.targetType} ${event.targetId ?? ""}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase()),
  );

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="page-title">Activity</h1>
          <p className="page-sub">
            Every action that changed something: who did it, what it touched, and when.
          </p>
        </div>
        <div className="row" style={{ width: "min(280px, 100%)" }}>
          <Search size={14} className="faint" aria-hidden />
          <Input
            placeholder="Filter events"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            aria-label="Filter activity"
          />
        </div>
      </div>

      {query.isError ? (
        <Notice tone="warn">
          {errorMessage(query.error)} Ask an owner or admin if you need this view.
        </Notice>
      ) : null}

      <Card flush>
        {query.isLoading ? (
          <div className="card-body stack">
            <Skeleton h={16} />
            <Skeleton h={16} w="80%" />
            <Skeleton h={16} w="65%" />
          </div>
        ) : rows.length === 0 ? (
          <Empty
            icon={<ActivityIcon size={18} />}
            title={filter ? "No events match" : "Nothing has happened yet"}
            body={
              filter
                ? "Clear the filter to see the full log."
                : "Signing in, creating a run, approving an action: each one will appear here with its actor and target."
            }
          />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Target</th>
                  <th>Actor</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((event) => (
                  <tr key={event.id}>
                    <td className="num" style={{ textAlign: "left", whiteSpace: "nowrap" }}>
                      {timeAgo(event.createdAt)}
                    </td>
                    <td>
                      <Badge tone="plain">{event.eventType}</Badge>
                    </td>
                    <td>
                      <span className="mono tiny">{event.targetType}</span>
                      {event.targetId ? (
                        <div className="tiny faint mono truncate" style={{ maxWidth: 320 }}>
                          {event.targetId}
                        </div>
                      ) : null}
                    </td>
                    <td className="mono tiny faint">
                      {event.actorUserId ? event.actorUserId.slice(0, 10) : "system"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
