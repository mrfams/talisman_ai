import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Clock,
  ListChecks,
  Phone,
  Plug,
  ShieldCheck,
} from "lucide-react";
import { api } from "../lib/api";
import { useConnectors, useHealth, useMe, useTasks } from "../lib/queries";
import { Badge, Card, Skeleton, StatusBadge, timeAgo } from "../ui";

const SUGGESTIONS = [
  { label: "Company brief", prompt: "Research a company and write me a one-page brief" },
  { label: "Tomorrow's calendar", prompt: "Read my calendar tomorrow and flag any conflicts" },
  { label: "Supplier comparison", prompt: "Find three suppliers and put a pricing comparison in a PDF" },
];

const START = [
  ["Describe the outcome", "A sentence is enough. Talisman turns it into steps it can finish."],
  ["Watch it work", "Every tool call, retry and page visit is visible in the run timeline."],
  ["Approve what matters", "Sends, payments and deletes pause until you decide."],
] as const;

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function Today() {
  const me = useMe();
  const tasks = useTasks();
  const health = useHealth();
  const connectors = useConnectors();
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.approvals("pending"),
  });
  const navigate = useNavigate();
  const [job, setJob] = useState("");

  const all = tasks.data ?? [];
  const waiting = approvals.data?.approvals ?? [];
  const needsYou = all.filter((task) => task.status === "waiting_approval");
  const needsCount = approvals.data ? waiting.length : needsYou.length;
  const inFlight = all.filter((task) => ["queued", "scheduled", "running"].includes(task.status));
  const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const done = all.filter(
    (task) => task.status === "succeeded" && new Date(task.updatedAt).getTime() > week,
  );

  const firstName = (me.data?.user.name ?? "").trim().split(/\s+/)[0] ?? "";
  const google = connectors.data?.connectors.find((connector) => connector.id === "google");

  function start() {
    const text = job.trim();
    if (!text) return;
    navigate(`/chat?q=${encodeURIComponent(text)}`);
  }

  const active = inFlight.length > 0;

  return (
    <div className="page">
      <header className="page-head">
        <div className="stack" style={{ gap: 5 }}>
          <span className="eyebrow">
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </span>
          <h1 className="page-title" style={{ fontSize: 28 }}>
            {greeting()}
            {firstName ? `, ${firstName}` : ""}.
          </h1>
          <p className="page-sub">
            Hand over a job. The agent plans it, works through it, and stops only when a decision
            needs you.
          </p>
        </div>
        <Badge tone={active ? "live" : "plain"}>
          {active ? `${inFlight.length} running` : "Agent ready"}
        </Badge>
      </header>

      <section className="job-composer" aria-label="Start a job">
        <textarea
          className="job-input"
          rows={1}
          placeholder="What should the agent take off your plate?"
          value={job}
          aria-label="Describe the job"
          onChange={(event) => setJob(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              start();
            }
          }}
        />
        <div className="job-foot">
          <div className="suggest">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion.label}
                className="suggest-item"
                onClick={() => setJob(suggestion.prompt)}
                title={suggestion.prompt}
              >
                {suggestion.label}
              </button>
            ))}
          </div>
          <div className="job-actions">
            <span className="tiny faint">⌘↵</span>
            <button className="composer-send" disabled={!job.trim()} onClick={start} aria-label="Start">
              <ArrowUp size={15} />
            </button>
          </div>
        </div>
      </section>

      <section className="pulse card" aria-label="Workspace activity">
        <Link to="/approvals" className="pulse-item">
          <span className="stat-value">{needsCount}</span>
          <span className="stat-label">waiting on you</span>
          <span className="pulse-note">decisions</span>
        </Link>
        <Link to="/tasks?tab=active" className="pulse-item">
          <span className="stat-value">{inFlight.length}</span>
          <span className="stat-label">in flight</span>
          <span className="pulse-note">now</span>
        </Link>
        <Link to="/tasks?tab=done" className="pulse-item">
          <span className="stat-value">{done.length}</span>
          <span className="stat-label">done this week</span>
          <span className="pulse-note">finished</span>
        </Link>
      </section>

      <div className="dashboard">
        <div className="stack" style={{ gap: "var(--space-4)" }}>
          {all.length === 0 ? (
            <Card flush>
              <div className="card-head">
                <h2 className="section-title">Start here</h2>
                <span className="tiny faint">Nothing has run yet</span>
              </div>
              <div className="steps">
                {START.map(([title, body], index) => (
                  <div className="step-row" key={title}>
                    <span className="step-index">{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <div className="list-title">{title}</div>
                      <div className="tiny muted" style={{ marginTop: 2 }}>
                        {body}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="row" style={{ padding: "var(--space-3)", borderTop: "1px solid var(--line)" }}>
                <span className="tiny muted grow">Write the first job above to begin.</span>
                <Link to="/tasks" className="tiny">
                  Or configure a run <ChevronRight size={12} style={{ display: "inline" }} />
                </Link>
              </div>
            </Card>
          ) : (
            <>
              <Card flush>
                <div className="card-head">
                  <h2 className="section-title">Needs your decision</h2>
                  <Link to="/approvals" className="tiny muted">
                    All approvals
                  </Link>
                </div>
                {tasks.isLoading || approvals.isLoading ? (
                  <div className="card-body stack">
                    <Skeleton h={15} w="55%" />
                    <Skeleton h={15} w="38%" />
                  </div>
                ) : waiting.length === 0 ? (
                  <div className="list-item" style={{ alignItems: "center" }}>
                    <CheckCircle2 size={16} style={{ color: "var(--ok)", flex: "none" }} aria-hidden />
                    <div className="grow">
                      <div className="list-title">You are all caught up</div>
                      <div className="tiny muted">
                        Nothing is holding. Risky steps will wait here with the exact action.
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="list">
                    {waiting.map((approval) => (
                      <Link
                        key={approval.id}
                        to={`/tasks/${approval.taskId}`}
                        className="list-item"
                        style={{ color: "inherit", alignItems: "center" }}
                      >
                        <Clock size={15} style={{ color: "var(--warn)", flex: "none" }} aria-hidden />
                        <div className="grow" style={{ minWidth: 0 }}>
                          <div className="list-title truncate">{approval.summary}</div>
                          <div className="tiny faint truncate">
                            {approval.kind.replace(/_/g, " ")} · {approval.taskTitle} · asked{" "}
                            {timeAgo(approval.createdAt)}
                          </div>
                        </div>
                        <span className="chip">Review</span>
                      </Link>
                    ))}
                  </div>
                )}
              </Card>

              <Card flush>
                <div className="card-head">
                  <h2 className="section-title">Running now</h2>
                  {inFlight.length ? <Badge tone="live">{inFlight.length} active</Badge> : null}
                </div>
                {inFlight.length === 0 ? (
                  <div className="list-item" style={{ alignItems: "center" }}>
                    <ListChecks size={16} className="faint" aria-hidden />
                    <div className="grow">
                      <div className="list-title">Nothing in flight</div>
                      <div className="tiny muted">Start a job above, or open a finished run.</div>
                    </div>
                    <Link to="/tasks" className="chip">
                      All runs
                    </Link>
                  </div>
                ) : (
                  <div className="list">
                    {inFlight.map((task) => (
                      <Link
                        key={task.id}
                        to={`/tasks/${task.id}`}
                        className="list-item"
                        style={{ color: "inherit", alignItems: "center" }}
                      >
                        <div className="grow" style={{ minWidth: 0 }}>
                          <div className="row" style={{ gap: 8 }}>
                            <span className="list-title truncate grow">{task.title}</span>
                            <StatusBadge status={task.status} />
                          </div>
                          <div className="row" style={{ gap: 8, marginTop: 7 }}>
                            <div className="bar" style={{ maxWidth: 240, flex: 1 }}>
                              <span style={{ width: `${Math.max(3, task.progress)}%` }} />
                            </div>
                            <span className="mono tiny faint">{task.progress}%</span>
                          </div>
                        </div>
                        <ChevronRight size={14} className="faint" aria-hidden />
                      </Link>
                    ))}
                  </div>
                )}
              </Card>
            </>
          )}
        </div>

        <div className="stack" style={{ gap: "var(--space-4)" }}>
          <Card flush>
            <div className="card-head">
              <h2 className="section-title">Connections</h2>
              <Link to="/connectors" className="tiny muted">
                Manage
              </Link>
            </div>
            <div className="list">
              <div className="list-item" style={{ alignItems: "center" }}>
                <Plug size={15} className="faint" aria-hidden />
                <div className="grow">
                  <div className="small">Google Calendar</div>
                  <div className="tiny faint">
                    {google?.connected
                      ? "Reading events with your approval"
                      : google?.configured
                        ? "Keys are set, account not linked"
                        : "Needs deployment keys"}
                  </div>
                </div>
                {connectors.isLoading ? (
                  <Skeleton h={16} w={62} />
                ) : google?.connected ? (
                  <Badge tone="ok">Connected</Badge>
                ) : google?.configured ? (
                  <Badge tone="warn">Ready</Badge>
                ) : (
                  <Badge>Off</Badge>
                )}
              </div>
              <Link to="/devices" className="list-item" style={{ alignItems: "center", color: "inherit" }}>
                <Phone size={15} className="faint" aria-hidden />
                <div className="grow">
                  <div className="small">Phones</div>
                  <div className="tiny faint">A real device through Phone Harness</div>
                </div>
                <Badge>Not set up</Badge>
              </Link>
            </div>
          </Card>

          <Card flush>
            <div className="card-head">
              <h2 className="section-title">Agent runtime</h2>
              {health.data?.database === "ok" ? <Badge tone="ok">Operational</Badge> : null}
            </div>
            <div className="card-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
              <div className="kv">
                {health.isLoading ? (
                  <div className="stack" style={{ padding: "8px 0" }}>
                    <Skeleton h={13} w="65%" />
                    <Skeleton h={13} w="45%" />
                  </div>
                ) : health.data ? (
                  <>
                    <div className="kv-row">
                      <span className="kv-label">Model</span>
                      <span className="kv-value mono tiny">{health.data.capabilities.defaultModel}</span>
                    </div>
                    <div className="kv-row">
                      <span className="kv-label">Browser</span>
                      <span className="kv-value mono tiny">{health.data.capabilities.browser}</span>
                    </div>
                    <div className="kv-row">
                      <span className="kv-label">Search</span>
                      <span className="kv-value mono tiny">
                        {health.data.capabilities.search ?? "none"}
                      </span>
                    </div>
                    <div className="kv-row">
                      <span className="kv-label">Artifacts</span>
                      <span className="kv-value mono tiny">{health.data.capabilities.artifacts}</span>
                    </div>
                  </>
                ) : (
                  <p className="small error-text" style={{ padding: "8px 0" }}>
                    The API did not answer.
                  </p>
                )}
              </div>
            </div>
          </Card>

          <Card>
            <div className="row" style={{ gap: 8 }}>
              <ShieldCheck size={14} className="faint" aria-hidden />
              <span className="tiny muted grow">
                Runs are isolated to your workspace. Nothing is shared across accounts.
              </span>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
