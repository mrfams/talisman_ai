import { Link, useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  CheckCircle2,
  Clock,
  ListChecks,
  Package,
  Phone,
  Plug,
  Sparkles,
} from "lucide-react";
import { useConnectors, useHealth, useMe, useTasks } from "../lib/queries";
import { Badge, Button, Card, Empty, Skeleton, StatusBadge, timeAgo } from "../ui";

const PROMPTS = [
  "Research a company and write me a one-page brief",
  "Read my calendar tomorrow and tell me what I am walking into",
  "Find the cheapest option for something I need to buy",
];

const START = [
  ["Give it a job", "Describe the outcome, not the clicks. It turns the job into a plan."],
  ["Watch the run", "Every step, retry and tool call is visible while it works."],
  ["Approve the risky bits", "Sends, payments and deletes wait for your decision."],
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
  const navigate = useNavigate();

  const all = tasks.data ?? [];
  const needsYou = all.filter((task) => task.status === "waiting_approval");
  const inFlight = all.filter((task) => ["queued", "scheduled", "running"].includes(task.status));
  const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const done = all.filter(
    (task) => task.status === "succeeded" && new Date(task.updatedAt).getTime() > week,
  );

  // An email handle is not a name: greet plainly rather than showing "shot-1793…".
  const firstName = (me.data?.user.name ?? "").trim().split(/\s+/)[0] ?? "";
  const google = connectors.data?.connectors.find((connector) => connector.id === "google");

  return (
    <div className="page">
      <section className="hero">
        <span className="hero-grain dither" aria-hidden />
        <div className="hero-inner">
          <div className="row wrap" style={{ gap: 10 }}>
            <span className="eyebrow">
              {new Date().toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </span>
            <Badge tone={inFlight.length ? "live" : "plain"}>
              {inFlight.length ? `${inFlight.length} running` : "Agent idle"}
            </Badge>
          </div>

          <h1 className="hero-title">
            {greeting()}
            {firstName ? `, ${firstName}` : ""}.{" "}
            <span className="hero-dim">What should I take off your plate?</span>
          </h1>

          <p className="muted" style={{ maxWidth: "54ch", fontSize: "var(--text-sm)" }}>
            I plan the work, run it in a real browser, and come back only when something needs your
            decision.
          </p>

          <div className="prompt-deck">
            {PROMPTS.map((prompt, index) => (
              <button
                key={prompt}
                className="prompt"
                onClick={() => navigate(`/chat?q=${encodeURIComponent(prompt)}`)}
              >
                <span className="prompt-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="grow">{prompt}</span>
                <ArrowUpRight size={14} aria-hidden />
              </button>
            ))}
          </div>

          <div className="row wrap" style={{ gap: "var(--space-2)", marginTop: 2 }}>
            <Button variant="primary" onClick={() => navigate("/chat")} icon={<Sparkles size={14} />}>
              Start a conversation
            </Button>
            <Button variant="secondary" onClick={() => navigate("/tasks")}>
              Open runs
            </Button>
          </div>
        </div>
      </section>

      <section className="pulse card">
        {[
          ["Waiting on you", needsYou.length, "Approvals holding work up."],
          ["In flight", inFlight.length, "Running now or queued for the next slice."],
          ["Done this week", done.length, "Finished runs, ready to open."],
        ].map(([label, value, note]) => (
          <div className="pulse-item" key={String(label)}>
            <span className="stat-value">{value}</span>
            <span className="stat-label">{label}</span>
            <span className="tiny faint">{note}</span>
          </div>
        ))}
      </section>

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
                  <div style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>{title}</div>
                  <div className="tiny muted">{body}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding: "var(--space-4) var(--space-5)" }}>
            <Button
              size="sm"
              variant="primary"
              icon={<ListChecks size={14} />}
              onClick={() => navigate("/tasks")}
            >
              Create your first run
            </Button>
          </div>
        </Card>
      ) : (
        <>
          <Card flush>
            <div className="card-head">
              <h2 className="section-title">Needs a decision</h2>
              <Link to="/approvals" className="tiny">
                All approvals
              </Link>
            </div>
            {tasks.isLoading ? (
              <div className="card-body stack">
                <Skeleton h={16} w="60%" />
                <Skeleton h={16} w="40%" />
              </div>
            ) : needsYou.length === 0 ? (
              <Empty
                icon={<CheckCircle2 size={17} />}
                title="You are all caught up"
                body="When a run reaches something it should not do alone, it waits here with the exact action shown."
              />
            ) : (
              <div className="list">
                {needsYou.map((task) => (
                  <Link
                    key={task.id}
                    to={`/tasks/${task.id}`}
                    className="list-item"
                    style={{ color: "inherit" }}
                  >
                    <Clock size={16} className="muted" style={{ marginTop: 3 }} aria-hidden />
                    <div className="grow">
                      <div className="list-title">{task.title}</div>
                      <div className="tiny muted">
                        {task.progress}% · updated {timeAgo(task.updatedAt)}
                      </div>
                    </div>
                    <StatusBadge status={task.status} />
                  </Link>
                ))}
              </div>
            )}
          </Card>

          <Card flush>
            <div className="card-head">
              <h2 className="section-title">In flight</h2>
              {inFlight.length ? <Badge tone="live">{inFlight.length} active</Badge> : null}
            </div>
            {inFlight.length === 0 ? (
              <Empty
                icon={<Package size={17} />}
                title="Nothing running"
                body="Runs appear here the moment they are queued, with the step they are on."
              />
            ) : (
              <div className="list">
                {inFlight.map((task) => (
                  <Link
                    key={task.id}
                    to={`/tasks/${task.id}`}
                    className="list-item"
                    style={{ color: "inherit" }}
                  >
                    <div className="grow">
                      <div className="list-title">{task.title}</div>
                      <div className="bar" style={{ marginTop: 8, maxWidth: 280 }}>
                        <span style={{ width: `${Math.max(3, task.progress)}%` }} />
                      </div>
                    </div>
                    <StatusBadge status={task.status} />
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      <div className="grid-2">
        <Card>
          <div className="row-between">
            <h2 className="section-title">Connected</h2>
            <Link to="/connectors" className="tiny">
              Manage
            </Link>
          </div>
          <div className="stack" style={{ marginTop: "var(--space-4)" }}>
            <div className="row">
              <Plug size={15} className="muted" aria-hidden />
              <span className="small grow">Google Calendar</span>
              {connectors.isLoading ? (
                <Skeleton h={16} w={70} />
              ) : google?.connected ? (
                <Badge tone="ok">Connected</Badge>
              ) : google?.configured ? (
                <Badge tone="warn">Not connected</Badge>
              ) : (
                <Badge>Needs keys</Badge>
              )}
            </div>
            <div className="row">
              <Phone size={15} className="muted" aria-hidden />
              <span className="small grow">Phones</span>
              <Badge>Not set up</Badge>
            </div>
          </div>
        </Card>

        <Card>
          <h2 className="section-title">Runtime</h2>
          <div className="stack" style={{ marginTop: "var(--space-4)" }}>
            {health.isLoading ? (
              <Skeleton h={14} w="70%" />
            ) : health.data ? (
              <>
                <div className="row-between small">
                  <span className="muted">Database</span>
                  <Badge tone={health.data.database === "ok" ? "ok" : "bad"}>
                    {health.data.database}
                  </Badge>
                </div>
                <div className="row-between small">
                  <span className="muted">Model</span>
                  <span className="mono tiny">{health.data.capabilities.defaultModel}</span>
                </div>
                <div className="row-between small">
                  <span className="muted">Browser</span>
                  <span className="mono tiny">{health.data.capabilities.browser}</span>
                </div>
                <div className="row-between small">
                  <span className="muted">Search</span>
                  <span className="mono tiny">{health.data.capabilities.search ?? "none"}</span>
                </div>
              </>
            ) : (
              <p className="small error-text">The API did not answer. The interface still works.</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
