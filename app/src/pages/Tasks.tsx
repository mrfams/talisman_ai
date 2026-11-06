import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ListChecks, Plus } from "lucide-react";
import { api } from "../lib/api";
import { errorMessage, isActive, useTasks } from "../lib/queries";
import {
  Button,
  Card,
  Empty,
  Field,
  Input,
  Modal,
  Notice,
  Skeleton,
  StatusBadge,
  Textarea,
  timeAgo,
} from "../ui";

type Filter = "all" | "active" | "needs" | "done";

const TABS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "needs", label: "Needs you" },
  { id: "done", label: "Finished" },
];

export function Tasks() {
  const tasks = useTasks();
  const [params, setParams] = useSearchParams();
  const filter = (params.get("tab") as Filter | null) ?? "all";
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [seeds, setSeeds] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const navigate = useNavigate();
  const client = useQueryClient();

  const create = useMutation({
    mutationFn: async () => {
      const urls = seeds
        .split(/[\s,]+/)
        .map((url) => url.trim())
        .filter(Boolean);
      return api.createTask({ goal: goal.trim(), ...(urls.length ? { seedUrls: urls } : {}) });
    },
    onSuccess: async ({ task }) => {
      setOpen(false);
      setGoal("");
      setSeeds("");
      await client.invalidateQueries({ queryKey: ["tasks"] });
      navigate(`/tasks/${task.id}`);
    },
    onError: (error) => setProblem(errorMessage(error)),
  });

  const all = tasks.data ?? [];
  const rows = all.filter((task) => {
    if (filter === "active") return isActive(task.status);
    if (filter === "needs") return task.status === "waiting_approval";
    if (filter === "done") return ["succeeded", "failed", "cancelled"].includes(task.status);
    return true;
  });

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="page-title">Runs</h1>
          <p className="page-sub">
            Every job the agent has taken on, the step it is on, and what came out of it.
          </p>
        </div>
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setOpen(true)}>
          New run
        </Button>
      </div>

      <div className="row-between wrap">
        <div className="tabs" role="tablist" aria-label="Filter runs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={filter === tab.id}
              className="tab"
              onClick={() => {
                if (tab.id === "all") setParams({});
                else setParams({ tab: tab.id });
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <span className="tiny faint">{rows.length} shown</span>
      </div>

      <Card flush>
        {tasks.isLoading ? (
          <div className="card-body stack">
            <Skeleton h={18} w="60%" />
            <Skeleton h={18} w="45%" />
            <Skeleton h={18} w="52%" />
          </div>
        ) : tasks.isError ? (
          <div className="card-body">
            <Notice tone="bad">{errorMessage(tasks.error)}</Notice>
          </div>
        ) : rows.length === 0 ? (
          <Empty
            icon={<ListChecks size={18} />}
            title={filter === "all" ? "No runs yet" : "Nothing in this filter"}
            body={
              filter === "all"
                ? "A run starts when you give the agent a job that takes more than one step. It keeps going in slices, so closing the tab does not stop it."
                : "Try another filter, or start a new run."
            }
            action={
              <Button size="sm" icon={<Plus size={14} />} onClick={() => setOpen(true)}>
                New run
              </Button>
            }
          />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Attempts</th>
                  <th style={{ textAlign: "right" }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <Link to={`/tasks/${task.id}`} style={{ color: "inherit", fontWeight: 600 }}>
                        {task.title}
                      </Link>
                      <div className="tiny faint truncate" style={{ maxWidth: 460 }}>
                        {task.goal}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={task.status} />
                    </td>
                    <td>
                      <div className="row" style={{ gap: 8, minWidth: 120 }}>
                        <div className="bar" style={{ width: 80 }}>
                          <span style={{ width: `${Math.max(2, task.progress)}%` }} />
                        </div>
                        <span className="mono tiny faint">{task.progress}%</span>
                      </div>
                    </td>
                    <td className="num">
                      {task.attempts}/{task.maxAttempts}
                    </td>
                    <td className="num">{timeAgo(task.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New run"
        footer={
          <>
            <Button variant="quiet" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={create.isPending}
              disabled={goal.trim().length < 8}
              onClick={() => {
                setProblem(null);
                create.mutate();
              }}
            >
              Start run
            </Button>
          </>
        }
      >
        <Field
          label="What should it accomplish?"
          htmlFor="goal"
          hint="Be specific about the outcome, not the clicks."
        >
          <Textarea
            id="goal"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Find three suppliers for recycled packaging under €2 per unit and put the comparison in a PDF."
            autoFocus
          />
        </Field>
        <Field label="Starting points" htmlFor="seeds" hint="Optional. One URL per line or comma separated.">
          <Input
            id="seeds"
            value={seeds}
            onChange={(event) => setSeeds(event.target.value)}
            placeholder="https://example.com/pricing"
          />
        </Field>
        {problem ? <Notice tone="bad">{problem}</Notice> : null}
      </Modal>
    </div>
  );
}
