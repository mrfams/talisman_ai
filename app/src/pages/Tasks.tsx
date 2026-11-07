import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ListChecks, Plus, Search } from "lucide-react";
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
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(params.get("new") === "1");
  const [goal, setGoal] = useState("");
  const [seeds, setSeeds] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const navigate = useNavigate();
  const client = useQueryClient();

  useEffect(() => {
    setOpen(params.get("new") === "1");
  }, [params]);

  function close() {
    setOpen(false);
    if (params.get("new")) {
      const next = new URLSearchParams(params);
      next.delete("new");
      setParams(next, { replace: true });
    }
  }

  const create = useMutation({
    mutationFn: async () => {
      const urls = seeds
        .split(/[\s,]+/)
        .map((url) => url.trim())
        .filter(Boolean);
      return api.createTask({ goal: goal.trim(), ...(urls.length ? { seedUrls: urls } : {}) });
    },
    onSuccess: async ({ task }) => {
      close();
      setGoal("");
      setSeeds("");
      await client.invalidateQueries({ queryKey: ["tasks"] });
      navigate(`/tasks/${task.id}`);
    },
    onError: (error) => setProblem(errorMessage(error)),
  });

  const needle = query.trim().toLowerCase();
  const all = tasks.data ?? [];
  const rows = all
    .filter((task) => {
      if (filter === "active") return isActive(task.status);
      if (filter === "needs") return task.status === "waiting_approval";
      if (filter === "done") return ["succeeded", "failed", "cancelled"].includes(task.status);
      return true;
    })
    .filter((task) => !needle || `${task.title} ${task.goal}`.toLowerCase().includes(needle));

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="page-title">Runs</h1>
          <p className="page-sub">
            Every job the agent has taken on, the step it is on, and what came out of it.
          </p>
        </div>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setOpen(true)}>
          New run
        </Button>
      </div>

      <div className="toolbar">
        <div className="toolbar-group">
          <div className="tabs" role="tablist" aria-label="Filter runs">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={filter === tab.id}
                className="tab"
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.delete("new");
                  if (tab.id === "all") next.delete("tab");
                  else next.set("tab", tab.id);
                  setParams(next, { replace: true });
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <span className="count-note">
            {rows.length}
            {needle ? ` of ${all.length}` : ""} run{rows.length === 1 ? "" : "s"}
          </span>
        </div>
        <label className="search">
          <Search size={13} aria-hidden />
          <input
            placeholder="Search runs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search runs"
          />
        </label>
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
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table table-runs">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th style={{ textAlign: "right" }}>Attempts</th>
                  <th style={{ textAlign: "right" }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr className="table-empty">
                    <td colSpan={5}>
                      <Empty
                        icon={<ListChecks size={15} />}
                        title={
                          needle
                            ? "No runs match that search"
                            : filter === "all"
                              ? "No runs yet"
                              : "Nothing in this filter"
                        }
                        body={
                          needle
                            ? "Try a shorter phrase, or clear the search."
                            : filter === "all"
                              ? "A run starts when you give the agent a job that takes more than one step. It keeps going in slices, so closing the tab does not stop it."
                              : "Try another filter, or start a new run."
                        }
                        action={
                          needle ? (
                            <Button size="sm" onClick={() => setQuery("")}>
                              Clear search
                            </Button>
                          ) : (
                            <Button size="sm" icon={<Plus size={13} />} onClick={() => setOpen(true)}>
                              New run
                            </Button>
                          )
                        }
                      />
                    </td>
                  </tr>
                ) : (
                  rows.map((task) => (
                    <tr key={task.id}>
                      <td className="run-cell">
                        <Link
                          to={`/tasks/${task.id}`}
                          className="cell-title"
                          style={{ color: "inherit" }}
                        >
                          {task.title}
                        </Link>
                        <div className="tiny faint truncate run-goal">{task.goal}</div>
                      </td>
                      <td>
                        <StatusBadge status={task.status} />
                      </td>
                      <td>
                        <div className="row" style={{ gap: 8, minWidth: 116 }}>
                          <div className="bar" style={{ width: 70 }}>
                            <span style={{ width: `${Math.max(2, task.progress)}%` }} />
                          </div>
                          <span className="mono tiny faint">{task.progress}%</span>
                        </div>
                      </td>
                      <td className="num" title={`${task.attempts} of ${task.maxAttempts} attempts used`}>
                        {task.attempts}/{task.maxAttempts}
                      </td>
                      <td className="num">{timeAgo(task.updatedAt)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={open}
        onClose={close}
        title="New run"
        footer={
          <>
            <Button variant="quiet" onClick={close}>
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
          hint="Be specific about the outcome, not the clicks. The agent writes the steps."
        >
          <Textarea
            id="goal"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Find three suppliers for recycled packaging under €2 per unit and put the comparison in a PDF."
            autoFocus
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && goal.trim().length >= 8) {
                event.preventDefault();
                setProblem(null);
                create.mutate();
              }
            }}
          />
        </Field>
        <details>
          <summary className="tiny muted" style={{ cursor: "pointer" }}>
            Add starting pages (optional)
          </summary>
          <div style={{ marginTop: 10 }}>
            <Field label="URLs" htmlFor="seeds" hint="One per line or comma separated. The agent can also search.">
              <Input
                id="seeds"
                value={seeds}
                onChange={(event) => setSeeds(event.target.value)}
                placeholder="https://example.com/pricing"
              />
            </Field>
          </div>
        </details>
        {problem ? <Notice tone="bad">{problem}</Notice> : null}
      </Modal>
    </div>
  );
}
