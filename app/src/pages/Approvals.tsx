import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ShieldCheck, X } from "lucide-react";
import { api } from "../lib/api";
import { errorMessage } from "../lib/queries";
import { Badge, Button, Card, Empty, Notice, Skeleton, timeAgo } from "../ui";

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
        {approvals.length ? <Badge tone="warn">{approvals.length} waiting</Badge> : null}
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
            icon={<ShieldCheck size={18} />}
            title="Nothing is waiting on you"
            body="When a run reaches a step that changes the world outside this workspace, it pauses and asks. You will see the exact payload and can allow or refuse it."
            action={
              <Link to="/tasks">
                <Button size="sm">See runs</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="stack" style={{ gap: "var(--space-4)" }}>
          {approvals.map((approval) => (
            <Card key={approval.id}>
              <div className="row-between wrap" style={{ alignItems: "flex-start" }}>
                <div className="stack" style={{ gap: 6, flex: 1, minWidth: 260 }}>
                  <div className="row wrap" style={{ gap: 8 }}>
                    <Badge tone="warn">{approval.kind.replace(/_/g, " ")}</Badge>
                    <span className="tiny faint">asked {timeAgo(approval.createdAt)}</span>
                  </div>
                  <div style={{ fontWeight: 600, fontSize: "var(--text-lg)" }}>
                    {approval.summary}
                  </div>
                  <div className="tiny muted">
                    Run:{" "}
                    <Link to={`/tasks/${approval.taskId}`}>{approval.taskTitle}</Link>
                  </div>
                </div>
                <div className="row">
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Check size={13} />}
                    busy={decide.isPending}
                    onClick={() => {
                      setProblem(null);
                      decide.mutate({ id: approval.id, decision: "approved" });
                    }}
                  >
                    Allow
                  </Button>
                  <Button
                    size="sm"
                    icon={<X size={13} />}
                    busy={decide.isPending}
                    onClick={() => {
                      setProblem(null);
                      decide.mutate({ id: approval.id, decision: "denied" });
                    }}
                  >
                    Refuse
                  </Button>
                </div>
              </div>
              <pre
                className="tiny"
                style={{
                  marginTop: "var(--space-4)",
                  padding: 12,
                  background: "var(--code-bg)",
                  border: "1px solid var(--line)",
                  borderRadius: 10,
                  overflow: "auto",
                  maxHeight: 200,
                }}
              >
                {JSON.stringify(approval.payload ?? {}, null, 2)}
              </pre>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
