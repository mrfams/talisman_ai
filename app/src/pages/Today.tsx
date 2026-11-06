import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, CheckCircle2, Clock, Package, Phone, Plug, Sparkles } from "lucide-react";
import { useConnectors, useHealth, useMe, useTasks } from "../lib/queries";
import { Badge, Button, Card, Empty, Skeleton, StatusBadge, timeAgo } from "../ui";

const PROMPTS = [
  "Research a company and write me a one-page brief",
  "Read my calendar tomorrow and tell me what I am walking into",
  "Find the cheapest option for something I need to buy",
  "Summarise a long thread and draft the reply",
];

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

  const firstName = (me.data?.user.name ?? me.data?.user.email ?? "").split(/[@\s]/)[0] ?? "";
  const google = connectors.data?.connectors.find((connector) => connector.id === "google");

  return (
    <div className="page">
      <section className="hero">
        <span className="hero-band dither" aria-hidden />
        <div className="stack" style={{ gap: "var(--space-4)", position: "relative" }}>
          <span className="badge" data-tone="plain">
            <Sparkles size={11} aria-hidden />
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </span>
          <h1 className="hero-title">
            {greeting()}
            {firstName ? `, ${firstName}` : ""}. What should I take off your plate?
          </h1>
          <p className="muted" style={{ maxWidth: "52ch", fontSize: "var(--text-sm)" }}>
            Give me a job and I will plan it, work through it in a real browser, and come back
            when something needs your decision.
          </p>

          <div className="row wrap" style={{ gap: "var(--space-2)" }}>
            {PROMPTS.slice(0, 2).map((prompt) => (
              <button
                key={prompt}
                className="chip"
                style={{ padding: "7px 12px", background: "var(--surface)", color: "var(--text-soft)" }}
                onClick={() => navigate(`/chat?q=${encodeURIComponent(prompt)}`)}
              >
                {prompt}
                <ArrowUpRight size={12} aria-hidden />
              </button>
            ))}
          </div>

          <div className="row wrap" style={{ gap: "var(--space-2)" }}>
            <Button variant="primary" onClick={() => navigate("/chat")}>
              Start a conversation
            </Button>
            <Button variant="secondary" onClick={() => navigate("/tasks")}>
              Open runs
            </Button>
          </div>
        </div>
      </section>

      <div className="grid-3">
        <Card>
          <div className="stat">
            <span className="stat-value">{needsYou.length}</span>
            <span className="stat-label">Waiting on you</span>
          </div>
          <p className="tiny muted" style={{ marginTop: 6 }}>
            {needsYou.length ? "Approvals that are holding work up." : "Nothing needs a decision."}
          </p>
        </Card>
        <Card>
          <div className="stat">
            <span className="stat-value">{inFlight.length}</span>
            <span className="stat-label">In flight</span>
          </div>
          <p className="tiny muted" style={{ marginTop: 6 }}>
            {inFlight.length ? "Running now, or queued for the next slice." : "The queue is empty."}
          </p>
        </Card>
        <Card>
          <div className="stat">
            <span className="stat-value">{done.length}</span>
            <span className="stat-label">Done this week</span>
          </div>
          <p className="tiny muted" style={{ marginTop: 6 }}>
            {done.length ? "Finished runs, ready to open." : "No finished runs yet."}
          </p>
        </Card>
      </div>

      <Card flush>
        <div className="card-head">
          <h2 className="section-title">Needs a decision</h2>
          <Link to="/tasks" className="tiny">
            All runs
          </Link>
        </div>
        {tasks.isLoading ? (
          <div className="card-body stack">
            <Skeleton h={16} w="60%" />
            <Skeleton h={16} w="40%" />
          </div>
        ) : needsYou.length === 0 ? (
          <Empty
            icon={<CheckCircle2 size={18} />}
            title="You are all caught up"
            body="When a run reaches something it should not do alone — a send, a payment, a delete — it will wait here with the exact action shown."
            action={
              <Button size="sm" onClick={() => navigate("/chat")}>
                Give Talisman a job
              </Button>
            }
          />
        ) : (
          <div className="list">
            {needsYou.map((task) => (
              <Link key={task.id} to={`/tasks/${task.id}`} className="list-item" style={{ color: "inherit" }}>
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
        {tasks.isLoading ? (
          <div className="card-body stack">
            <Skeleton h={16} w="70%" />
            <Skeleton h={16} w="50%" />
          </div>
        ) : inFlight.length === 0 ? (
          <Empty
            icon={<Package size={18} />}
            title="Nothing running"
            body="Runs appear here the moment they are queued, with their progress and the step they are on."
          />
        ) : (
          <div className="list">
            {inFlight.map((task) => (
              <Link key={task.id} to={`/tasks/${task.id}`} className="list-item" style={{ color: "inherit" }}>
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
