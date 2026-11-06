import { useEffect, useRef, useState } from "react";
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

function StepRow({ step }: { step: TaskStep }) {
  return (
    <div className="list-item" style={{ alignItems: "center" }}>
      <span className="mono tiny faint" style={{ width: 22 }}>
        {String(step.position).padStart(2, "0")}
      </span>
      <div className="grow">
        <div style={{ fontWeight: 550, fontSize: "var(--text-sm)" }}>{step.title}</div>
        {step.error ? <div className="tiny error-text">{step.error}</div> : null}
      </div>
      <Badge tone={STEP_TONE[step.status] ?? "plain"}>{step.status.replace("_", " ")}</Badge>
    </div>
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
      <div>
        <Link to="/tasks" className="row tiny muted" style={{ gap: 6 }}>
          <ArrowLeft size={13} aria-hidden /> All runs
        </Link>
      </div>

      <div className="page-head">
        <div className="stack" style={{ gap: 8, maxWidth: 720 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <StatusBadge status={task.status} />
            <span className="tiny faint">
              created {timeAgo(task.createdAt)} · attempts {task.attempts}/{task.maxAttempts}
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

      <div className="bar">
        <span style={{ width: `${Math.max(2, task.progress)}%` }} />
      </div>

      {task.error ? <Notice tone="bad">{task.error}</Notice> : null}
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
                  <pre
                    className="tiny"
                    style={{
                      marginTop: 8,
                      padding: 10,
                      background: "var(--code-bg)",
                      borderRadius: 8,
                      overflow: "auto",
                      maxHeight: 180,
                    }}
                  >
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

      <div className="grid-2" style={{ alignItems: "start" }}>
        <Card flush>
          <div className="card-head">
            <h2 className="section-title">Plan</h2>
            <span className="tiny faint">
              {steps.filter((step) => step.status === "succeeded").length}/{steps.length} done
            </span>
          </div>
          {steps.length === 0 ? (
            <div className="card-body">
              <p className="small muted">No steps recorded yet.</p>
            </div>
          ) : (
            <div className="list">
              {steps.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </div>
          )}
        </Card>

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
      </div>

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
          <div style={{ maxHeight: 380, overflow: "auto" }}>
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
                  {event.detail ? <div className="tiny faint">{event.detail}</div> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
