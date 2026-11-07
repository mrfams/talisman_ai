import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Mail, ShieldCheck, Sparkles, X } from "lucide-react";
import { api } from "../lib/api";
import { errorMessage } from "../lib/queries";
import { Badge, Button, Card, Empty, Notice, Skeleton, timeAgo } from "../ui";

function ApprovalIcon({ kind }: { kind: string }) {
  if (kind.includes("mail") || kind.includes("email")) return <Mail size={15} />;
  if (kind.includes("calendar")) return <Sparkles size={15} />;
  return <ShieldCheck size={15} />;
}

export function Approvals() {
  const query = useQuery({ queryKey: ["approvals"], queryFn: () => api.approvals("pending") });
  const client = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);

  const decide = useMutation({
    mutationFn: (input: { id: string; decision: "approved" | "denied" }) =>
      api.decide(input.id, input.decision),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["approvals"] });
      await client.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => setProblem(errorMessage(error)),
  });

  const approvals = query.data?.approvals ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="page-title">Approvals</h1>
          <p className="page-sub">
            Nothing that sends, pays, or deletes happens without a decision here. The exact action
            is shown, not a summary of it.
          </p>
        </div>
        {approvals.length ? (
          <Badge tone="warn">{approvals.length} waiting</Badge>
        ) : (
          <Badge tone="ok">Clear</Badge>
        )}
      </div>

      {problem ? <Notice tone="bad">{problem}</Notice> : null}

      {query.isLoading ? (
        <Card>
          <Skeleton h={20} w="40%" />
        </Card>
      ) : query.isError ? (
        <Notice tone="bad">{errorMessage(query.error)}</Notice>
      ) : approvals.length === 0 ? (
        <Card>
          <Empty
            icon={<ShieldCheck size={15} />}
            title="Nothing is waiting on you"
            body="When a run reaches a step that changes the world outside this workspace, it pauses here with the exact payload. You can allow it once or refuse it."
            action={
              <Link to="/tasks">
                <Button size="sm">See runs</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="stack" style={{ gap: "var(--space-3)" }}>
          {approvals.map((approval) => (
            <Card key={approval.id} className="approval-card">
              <div className="row" style={{ gap: 8 }}>
                <span className="provider-icon" style={{ width: 28, height: 28 }}>
                  <ApprovalIcon kind={approval.kind} />
                </span>
                <Badge tone="warn">{approval.kind.replace(/_/g, " ")}</Badge>
                <span className="tiny faint">asked {timeAgo(approval.createdAt)}</span>
              </div>

              <div>
                <div className="approval-summary">{approval.summary}</div>
                <div className="row" style={{ gap: 4, marginTop: 4 }}>
                  <span className="tiny faint">Run</span>
                  <Link
                    to={`/tasks/${approval.taskId}`}
                    className="tiny"
                    style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
                  >
                    {approval.taskTitle}
                    <ChevronRight size={11} />
                  </Link>
                </div>
              </div>

              <details>
                <summary className="tiny muted" style={{ cursor: "pointer", width: "fit-content" }}>
                  Review the exact payload
                </summary>
                <pre className="approval-payload" style={{ marginTop: 8 }}>
                  {JSON.stringify(approval.payload ?? {}, null, 2)}
                </pre>
              </details>

              <div className="approval-actions">
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Check size={12} />}
                  busy={decide.isPending}
                  onClick={() => {
                    setProblem(null);
                    decide.mutate({ id: approval.id, decision: "approved" });
                  }}
                >
                  Allow this once
                </Button>
                <Button
                  size="sm"
                  icon={<X size={12} />}
                  busy={decide.isPending}
                  onClick={() => {
                    setProblem(null);
                    decide.mutate({ id: approval.id, decision: "denied" });
                  }}
                >
                  Refuse
                </Button>
                <span className="tiny faint" style={{ marginLeft: "auto" }}>
                  The run is paused until you decide.
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
