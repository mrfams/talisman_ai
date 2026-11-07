import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Download,
  Pause,
  Play,
  RotateCcw,
  ShieldQuestion,
  X,
} from "lucide-react";
import { api, type Approval, type TaskStep } from "../lib/api";
import { errorMessage, isActive, useTask } from "../lib/queries";
import {
  Badge,
  Button,
  Card,
  Empty,
  Markdown,
  Notice,
  Skeleton,
  StatusBadge,
  bytes,
  timeAgo,
} from "../ui";

const STEP_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "plain" | "live"> = {
  succeeded: "ok",
  running: "live",
  waiting_approval: "warn",
  failed: "bad",
  cancelled: "bad",
  skipped: "plain",
  pending: "plain",
};

const STEP_NODE: Record<string, ReactNode> = {
  succeeded: <Check size={11} strokeWidth={3} />,
  failed: <X size={11} strokeWidth={3} />,
  cancelled: <X size={11} strokeWidth={3} />,
  waiting_approval: <ShieldQuestion size={11} />,
};

/** Wall-clock time a step spent executing, or null when it never finished. */
function duration(step: TaskStep): string | null {
  if (!step.startedAt || !step.finishedAt) return null;
  const ms = new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function elapsedLabel(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function FailureNotice({ text }: { text: string }) {
  if (text.length <= 260) return <Notice tone="bad">{text}</Notice>;
  return (
    <Notice tone="bad">
      <div>{text.slice(0, 260).trimEnd()}…</div>
      <details style={{ marginTop: 4 }}>
        <summary className="tiny" style={{ cursor: "pointer" }}>
          Show full error
        </summary>
        <div className="mono tiny" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>
          {text}
        </div>
      </details>
    </Notice>
  );
}

function TimelineStep({ step }: { step: TaskStep }) {
  const retried = step.attempts > 1;
  const elapsed = duration(step);
  const hasDetail = step.input !== null || step.output !== null || step.error !== null;

  return (
    <li className="tl-item" data-state={step.status}>
      <span className="tl-node" aria-hidden>
        {step.status === "running" ? <span className="tl-dot" /> : (STEP_NODE[step.status] ?? null)}
      </span>
      <div className="tl-body">
        <div className="tl-head">
          <span className="mono tiny faint">{String(step.position + 1).padStart(2, "0")}</span>
          <span className="tl-title">{step.title}</span>
          <Badge tone={STEP_TONE[step.status] ?? "plain"}>
            {step.status.replace(/_/g, " ")}
          </Badge>
        </div>
        <div className="tl-meta">
          <span>{step.kind}</span>
          {retried ? (
            <span className="tl-retry" title={`Execution started ${step.attempts} times`}>
              <RotateCcw size={9} aria-hidden /> {step.attempts} attempts
            </span>
          ) : null}
          {elapsed ? <span>{elapsed}</span> : null}
          {step.finishedAt
            ? <span>ended {timeAgo(step.finishedAt)}</span>
            : step.startedAt
              ? <span>started {timeAgo(step.startedAt)}</span>
              : null}
        </div>
        {step.error ? (
          step.error.length > 220 ? (
            <details className="tl-error-detail">
              <summary>
                Error · {step.error.slice(0, 110).trimEnd()}…
              </summary>
              <div className="tl-error" style={{ marginTop: 5 }}>
                {step.error}
              </div>
            </details>
          ) : (
            <div className="tl-error">{step.error}</div>
          )
        ) : null}
        {hasDetail ? (
          <details className="tl-detail">
            <summary>Input and output</summary>
            <pre>{JSON.stringify({ input: step.input, output: step.output }, null, 2)}</pre>
          </details>
        ) : null}
      </div>
    </li>
  );
}

export function TaskDetail() {
  const { id } = useParams();
  const query = useTask(id);
  const client = useQueryClient();
  const [slicing, setSlicing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const status = query.data?.task.status;
  const active = status ? isActive(status) : false;

  // Serverless deployments have no always-on worker: this page drives the next
  // slice while the run is active, then stops on its own.
  useEffect(() => {
    if (!id || !active || slicing) return;
    setSlicing(true);
    api
      .taskAction(id, "run")
      .catch(() => undefined)
      .finally(() => {
        timer.current = setTimeout(() => {
          setSlicing(false);
          void client.invalidateQueries({ queryKey: ["task", id] });
        }, 900);
      });
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [active, id, slicing, client]);

  const act = useMutation({
    mutationFn: (action: "pause" | "resume" | "cancel" | "retry") => api.taskAction(id!, action),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["task", id] });
      void client.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  const decide = useMutation({
    mutationFn: (input: { approval: Approval; decision: "approved" | "denied" }) =>
      api.decide(input.approval.id, input.decision),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["task", id] });
      void client.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  if (query.isLoading) {
    return (
      <div className="page">
        <Skeleton h={20} w={220} />
        <Skeleton h={140} />
        <Skeleton h={260} />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="page">
        <Empty
          title="This run is not available"
          body={query.isError ? errorMessage(query.error) : "It may have been deleted."}
          action={
            <Link to="/tasks">
              <Button size="sm">Back to runs</Button>
            </Link>
          }
        />
      </div>
    );
  }

  const { task, steps, approvals, artifacts, events } = query.data;
  const pending = approvals.filter((approval) => approval.status === "pending");

  return (
    <div className="page">
      <div className="breadcrumb">
        <Link to="/tasks" className="row" style={{ gap: 5 }}>
          <ArrowLeft size={12} aria-hidden /> Runs
        </Link>
        <span>/</span>
        <span className="mono">{task.id.slice(0, 8)}</span>
      </div>

      <div className="page-head">
        <div className="stack" style={{ gap: 7, maxWidth: 760 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <StatusBadge status={task.status} />
            <span className="tiny faint">
              {task.status === "running" ? "started" : "created"} {timeAgo(task.createdAt)}
            </span>
          </div>
          <h1 className="page-title">{task.title}</h1>
          <p className="page-sub">{task.goal}</p>
        </div>
        <div className="row wrap">
          {["queued", "running", "waiting_approval", "scheduled"].includes(task.status) ? (
            <Button
              size="sm"
              icon={<Pause size={13} />}
              busy={act.isPending}
              onClick={() => act.mutate("pause")}
            >
              Pause
            </Button>
          ) : null}
          {task.status === "paused" ? (
            <Button
              size="sm"
              variant="primary"
              icon={<Play size={13} />}
              busy={act.isPending}
              onClick={() => act.mutate("resume")}
            >
              Resume
            </Button>
          ) : null}
          {!["succeeded", "failed", "cancelled"].includes(task.status) ? (
            <Button
              size="sm"
              variant="danger"
              icon={<X size={13} />}
              busy={act.isPending}
              onClick={() => act.mutate("cancel")}
            >
              Cancel
            </Button>
          ) : null}
          {["failed", "cancelled"].includes(task.status) ? (
            <Button
              size="sm"
              icon={<RotateCcw size={13} />}
              busy={act.isPending}
              onClick={() => act.mutate("retry")}
            >
              Retry
            </Button>
          ) : null}
        </div>
      </div>

      <div className="metric-strip">
        <div className="metric">
          <span className="metric-value">
            {steps.filter((step) => ["succeeded", "skipped"].includes(step.status)).length}/{steps.length}
          </span>
          <span className="metric-label">Steps complete</span>
        </div>
        <div className="metric">
          <span className="metric-value">
            {elapsedLabel(
              task.startedAt
                ? (task.finishedAt ? new Date(task.finishedAt) : new Date()).getTime() -
                    new Date(task.startedAt).getTime()
                : null,
            )}
          </span>
          <span className="metric-label">Elapsed</span>
        </div>
        <div className="metric">
          <span className="metric-value">
            {task.attempts}
            <span className="faint" style={{ fontSize: "var(--text-sm)", fontWeight: 500 }}>
              /{task.maxAttempts}
            </span>
          </span>
          <span className="metric-label">Attempts</span>
        </div>
        <div className="metric">
          <span className="metric-value">{artifacts.length}</span>
          <span className="metric-label">Artifacts</span>
        </div>
      </div>

      {active ? (
        <div className="bar" aria-label={`${task.progress} percent complete`}>
          <span style={{ width: `${Math.max(2, task.progress)}%` }} />
        </div>
      ) : null}

      {task.error ? <FailureNotice text={task.error} /> : null}
      {act.isError ? <Notice tone="bad">{errorMessage(act.error)}</Notice> : null}

      {pending.length ? (
        <Card flush>
          <div className="card-head">
            <h2 className="section-title">Waiting on your decision</h2>
            <Badge tone="warn">{pending.length} pending</Badge>
          </div>
          <div className="list">
            {pending.map((approval) => (
              <div key={approval.id} className="list-item">
                <ShieldQuestion size={17} className="muted" style={{ marginTop: 2 }} aria-hidden />
                <div className="grow">
                  <div className="list-title">{approval.summary}</div>
                  <div className="tiny faint">
                    {approval.kind.replace(/_/g, " ")} · asked {timeAgo(approval.createdAt)}
                  </div>
                  <pre className="approval-payload" style={{ marginTop: 8 }}>
                    {JSON.stringify(approval.payload ?? {}, null, 2)}
                  </pre>
                </div>
                <div className="row">
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Check size={13} />}
                    busy={decide.isPending}
                    onClick={() => decide.mutate({ approval, decision: "approved" })}
                  >
                    Allow
                  </Button>
                  <Button
                    size="sm"
                    icon={<X size={13} />}
                    busy={decide.isPending}
                    onClick={() => decide.mutate({ approval, decision: "denied" })}
                  >
                    Refuse
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {task.result !== null && task.result !== undefined ? (
        <Card flush>
          <div className="card-head">
            <h2 className="section-title">Result</h2>
            <span className="tiny faint">Written by the run</span>
          </div>
          <div className="card-body">
            {typeof task.result === "string" ? (
              <Markdown text={task.result} />
            ) : (
              <pre className="approval-payload" style={{ maxHeight: 320 }}>
                {JSON.stringify(task.result, null, 2)}
              </pre>
            )}
          </div>
        </Card>
      ) : null}

      <Card flush>
        <div className="card-head">
          <h2 className="section-title">Timeline</h2>
          <span className="tiny faint">
            {steps.filter((step) => ["succeeded", "skipped"].includes(step.status)).length} of{" "}
            {steps.length} done
          </span>
        </div>
        {steps.length === 0 ? (
          <div className="card-body">
            <p className="small muted">
              The plan is written when the run first executes. Nothing has started yet.
            </p>
          </div>
        ) : (
          <ol className="timeline">
            {steps.map((step) => (
              <TimelineStep key={step.id} step={step} />
            ))}
          </ol>
        )}
      </Card>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <Card flush>
          <div className="card-head">
            <h2 className="section-title">Artifacts</h2>
            <span className="tiny faint">{artifacts.length}</span>
          </div>
          {artifacts.length === 0 ? (
            <div className="card-body">
              <p className="small muted">
                Nothing produced yet. Files a run creates appear here with their hash.
              </p>
            </div>
          ) : (
            <div className="list">
              {artifacts.map((artifact) => (
                <a
                  key={artifact.id}
                  href={api.artifactUrl(artifact.id)}
                  className="list-item"
                  style={{ color: "inherit" }}
                >
                  <Download size={15} className="muted" style={{ marginTop: 3 }} aria-hidden />
                  <div className="grow">
                    <div className="list-title">{artifact.name}</div>
                    <div className="tiny faint mono">
                      {bytes(artifact.sizeBytes)} · {artifact.sha256.slice(0, 10)}
                    </div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </Card>

        <Card flush>
          <div className="card-head">
            <h2 className="section-title">Execution log</h2>
            <span className="tiny faint">{events.length} events</span>
          </div>
          {events.length === 0 ? (
            <div className="card-body">
              <p className="small muted">The run has not written an event yet.</p>
            </div>
          ) : (
            <div className="list-scroll">
            {events.map((event) => (
              <div
                key={event.id}
                className="row"
                style={{
                  gap: 12,
                  padding: "8px var(--space-5)",
                  borderBottom: "1px solid var(--line)",
                  alignItems: "flex-start",
                }}
              >
                <span className="mono tiny faint" style={{ width: 92, flex: "none" }}>
                  {new Date(event.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
                <span className="badge" data-tone="plain" style={{ flex: "none" }}>
                  {event.kind}
                </span>
                <div className="grow">
                  <div className="small">{event.title}</div>
                  {event.detail ? (
                    <div className="tiny faint log-detail" title={event.detail}>
                      {event.detail}
                    </div>
                  ) : null}
                </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
