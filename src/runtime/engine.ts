import { newId } from "../core/ids.js";
import { messageOf } from "../core/errors.js";
import type { Config } from "../core/config.js";
import type { Conn, Database } from "../db/database.js";
import {
  appendEvent,
  claimNextTask,
  claimTaskById,
  createApproval,
  createArtifact,
  createMemory,
  createNotification,
  createStep,
  getArtifact,
  getTask,
  listApprovals,
  listSteps,
  updateStep,
  updateTask,
} from "../db/repos.js";
import type {
  Artifact,
  Task,
  TaskEventKind,
  TaskStep,
  TaskPlan,
} from "../core/types.js";
import type { ModelRouter } from "../intelligence/router.js";
import type { BrowserDriver } from "../browser/driver.js";
import type { ArtifactStoreLike } from "../workspace/workspace.js";
import { Workspace } from "../workspace/workspace.js";

export class ApprovalPending extends Error {
  constructor() {
    super("Waiting for human approval");
    this.name = "ApprovalPending";
  }
}

export interface StepContext {
  task: Task;
  step: TaskStep;
  signal: AbortSignal;
  /** Outputs of earlier steps, keyed by plan position. */
  results: Record<number, unknown>;
  config: Config;
  models: ModelRouter;
  workspace: Workspace;
  browser: BrowserDriver | null;
  searchProvider: "searxng" | "apinex";
  searchUrl: string | null;
  searchApiKey: string | null;
  report(
    kind: TaskEventKind,
    title: string,
    detail?: string | null,
    data?: unknown,
  ): Promise<void>;
  setProgress(progress: number, detail?: string): Promise<void>;
  requestApproval(input: {
    kind: string;
    summary: string;
    payload?: unknown;
  }): Promise<boolean>;
  saveArtifact(input: {
    name: string;
    mime: string;
    bytes: Uint8Array;
    metadata?: unknown;
  }): Promise<Artifact>;
  getArtifact(id: string): Promise<Artifact>;
  readArtifact(id: string): Promise<Uint8Array>;
  remember(kind: string, content: string): Promise<void>;
}

export type StepHandler = (context: StepContext) => Promise<unknown>;

export interface EngineDeps {
  database: Database;
  config: Config;
  models: ModelRouter;
  handlers: Record<string, StepHandler>;
  artifactStore: ArtifactStoreLike;
  workerId: string;
  leaseMs?: number;
  /** Returns null when this deployment has no page reader at all. */
  browserFactory?: () => BrowserDriver | null;
}

const WATCH_INTERVAL_MS = 750;
const HEARTBEAT_MS = 10_000;

/**
 * Executes a claimed task step by step. Each database write is its own tenant
 * transaction, so progress, approvals and artifacts survive a crash. Pause and
 * cancel are observed from the database and abort in-flight work.
 */
export class TaskEngine {
  private readonly leaseMs: number;

  constructor(private readonly deps: EngineDeps) {
    this.leaseMs = deps.leaseMs ?? 60_000;
  }

  private withTenant<T>(task: Task, fn: (conn: Conn) => Promise<T>): Promise<T> {
    return this.deps.database.withTenant(task.orgId, task.userId, fn);
  }

  private load(task: Task): Promise<Task | null> {
    return this.withTenant(task, (conn) => getTask(conn, task.id));
  }

  /**
   * Claim at organisation scope. RLS is organisation-scoped and the task's real
   * user id is used for execution, so the worker needs no per-user enumeration.
   */
  async claim(orgId: string): Promise<Task | null> {
    return this.deps.database.withTenant(orgId, "service", (conn) =>
      claimNextTask(conn, this.deps.workerId, this.leaseMs),
    );
  }

  /**
   * Claims one specific task for the caller. Used by the HTTP executor on
   * serverless hosts, where a request runs one bounded slice of a task instead of
   * a process living for the whole job. Returns null when the task is finished,
   * waiting for a human, or already leased by another executor.
   */
  async claimById(orgId: string, userId: string, taskId: string): Promise<Task | null> {
    return this.deps.database.withTenant(orgId, userId, (conn) =>
      claimTaskById(conn, taskId, this.deps.workerId, this.leaseMs),
    );
  }

  async runClaimed(
    task: Task,
    options: { budgetMs?: number } = {},
  ): Promise<{ outcome: "completed" | "timed_out" }> {
    const controller = new AbortController();
    const browser = this.deps.browserFactory?.() ?? null;
    let timedOut = false;
    const deadline = options.budgetMs
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.budgetMs)
      : null;
    deadline?.unref?.();
    const heartbeat = setInterval(() => {
      void this.heartbeat(task).catch(() => undefined);
    }, HEARTBEAT_MS);
    const watcher = setInterval(() => {
      void this.watch(task, controller).catch(() => undefined);
    }, WATCH_INTERVAL_MS);
    try {
      await this.execute(task, controller.signal, browser);
      return { outcome: timedOut ? "timed_out" : "completed" };
    } finally {
      if (deadline) clearTimeout(deadline);
      clearInterval(heartbeat);
      clearInterval(watcher);
      await browser?.close().catch(() => undefined);
      // A slice that ran out of time must hand the task back, not leave a lease
      // that blocks the next tick until it expires.
      if (timedOut) await this.abandon(task).catch(() => undefined);
    }
  }

  /**
   * Releases a still-running task back to the queue so another slice resumes it.
   * Only the current lease holder may do this.
   */
  private async abandon(task: Task): Promise<void> {
    const fresh = await this.load(task);
    if (!fresh || fresh.leaseOwner !== this.deps.workerId) return;
    if (["waiting_approval", "paused", "cancelled", "succeeded", "failed"].includes(fresh.status)) {
      await this.withTenant(task, (conn) =>
        updateTask(conn, task.id, { leaseOwner: null, leaseUntil: null }),
      );
      return;
    }
    await this.withTenant(task, async (conn) => {
      await conn.query(
        `UPDATE task_steps SET status = 'pending', error = NULL, started_at = NULL, finished_at = NULL
          WHERE task_id = $1 AND status = 'running'`,
        [task.id],
      );
      await updateTask(conn, task.id, {
        status: "queued",
        leaseOwner: null,
        leaseUntil: null,
      });
      await appendEvent(conn, {
        orgId: task.orgId,
        taskId: task.id,
        kind: "status",
        title: "Paused at the time limit",
        detail: "The unfinished step will resume on the next execution slice.",
      });
    });
  }

  private async watch(task: Task, controller: AbortController): Promise<void> {
    const fresh = await this.load(task);
    if (!fresh) return controller.abort();
    if (["paused", "cancelled"].includes(fresh.status)) controller.abort();
    if (fresh.leaseOwner && fresh.leaseOwner !== this.deps.workerId) controller.abort();
  }

  private async heartbeat(task: Task): Promise<void> {
    const fresh = await this.load(task);
    if (!fresh || fresh.status !== "running" || fresh.leaseOwner !== this.deps.workerId) return;
    await this.withTenant(task, (conn) =>
      updateTask(conn, task.id, { leaseUntil: new Date(Date.now() + this.leaseMs) }),
    );
  }

  private async execute(
    task: Task,
    signal: AbortSignal,
    browser: BrowserDriver | null,
  ): Promise<void> {
    const current = await this.load(task);
    if (!current || current.status !== "running") return;
    if (current.leaseOwner && current.leaseOwner !== this.deps.workerId) return;

    const plan: TaskPlan = current.plan ?? { steps: [] };
    if (plan.steps.length === 0) {
      await this.failTask(current, new Error("Task has no plan"));
      return;
    }

    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index]!;
      await this.withTenant(task, (conn) =>
        createStep(conn, {
          orgId: task.orgId,
          taskId: task.id,
          position: index,
          title: step.title,
          kind: step.kind,
          input: step.input ?? null,
        }),
      );
    }

    const steps = await this.withTenant(task, (conn) => listSteps(conn, task.id));
    const results: Record<number, unknown> = {};

    for (const step of steps) {
      if (step.status === "succeeded") {
        results[step.position] = step.output;
        continue;
      }
      if (signal.aborted) {
        await this.settleInterrupted(task, step);
        return;
      }

      const fresh = await this.load(task);
      if (!fresh || fresh.status !== "running") {
        await this.settleInterrupted(task, step);
        return;
      }

      await this.withTenant(task, async (conn) => {
        await updateStep(conn, step.id, {
          status: "running",
          error: null,
          // Counts every execution, so a resumed slice and a retry both show up.
          attempts: step.attempts + 1,
          startedAt: new Date(),
          finishedAt: null,
        });
        await updateTask(conn, task.id, {
          status: "running",
          error: null,
          progress: Math.round((step.position / steps.length) * 100),
        });
        await appendEvent(conn, {
          orgId: task.orgId,
          taskId: task.id,
          kind: "step",
          title: `Started: ${step.title}`,
        });
      });

      const handler = this.deps.handlers[step.kind];
      if (!handler) {
        await this.withTenant(task, (conn) =>
          updateStep(conn, step.id, {
            status: "failed",
            error: `No handler for step kind "${step.kind}"`,
            finishedAt: new Date(),
          }),
        );
        await this.failTask(task, new Error(`No handler for step kind "${step.kind}"`));
        return;
      }

      const context = this.buildContext(task, step, steps.length, { ...results }, signal, browser);

      try {
        const output = await handler(context);
        if (signal.aborted) {
          await this.settleInterrupted(task, step);
          return;
        }
        results[step.position] = output;
        const progress = Math.round(((step.position + 1) / steps.length) * 100);
        await this.withTenant(task, async (conn) => {
          await updateStep(conn, step.id, {
            status: "succeeded",
            output,
            finishedAt: new Date(),
          });
          await updateTask(conn, task.id, { progress });
          await appendEvent(conn, {
            orgId: task.orgId,
            taskId: task.id,
            kind: "step",
            title: `Completed: ${step.title}`,
          });
        });
      } catch (error) {
        if (error instanceof ApprovalPending) return;
        if (signal.aborted) {
          await this.settleInterrupted(task, step);
          return;
        }
        await this.withTenant(task, (conn) =>
          updateStep(conn, step.id, {
            status: "failed",
            error: messageOf(error),
            finishedAt: new Date(),
          }),
        );
        await this.failTask(task, error);
        return;
      }
    }

    await this.complete(task, results);
  }

  private async settleInterrupted(task: Task, step: TaskStep): Promise<void> {
    const fresh = await this.load(task);
    if (!fresh) return;
    if (fresh.status === "waiting_approval") return;
    if (fresh.status === "paused") {
      await this.withTenant(task, (conn) =>
        updateStep(conn, step.id, {
          status: "pending",
          error: null,
          startedAt: null,
          finishedAt: null,
        }),
      );
      await this.withTenant(task, (conn) =>
        appendEvent(conn, {
          orgId: task.orgId,
          taskId: task.id,
          kind: "status",
          title: "Paused",
          detail: "Work stopped at a safe point; resume to continue.",
        }),
      );
      return;
    }
    if (fresh.status === "cancelled") {
      await this.withTenant(task, async (conn) => {
        await updateStep(conn, step.id, {
          status: "cancelled",
          finishedAt: new Date(),
        });
        await updateTask(conn, task.id, {
          leaseOwner: null,
          leaseUntil: null,
          finishedAt: new Date(),
        });
        await appendEvent(conn, {
          orgId: task.orgId,
          taskId: task.id,
          kind: "status",
          title: "Cancelled",
        });
      });
    }
  }

  private async complete(task: Task, results: Record<number, unknown>): Promise<void> {
    await this.withTenant(task, async (conn) => {
      await updateTask(conn, task.id, {
        status: "succeeded",
        progress: 100,
        result: { steps: results, completedAt: new Date().toISOString() },
        error: null,
        leaseOwner: null,
        leaseUntil: null,
        finishedAt: new Date(),
      });
      await appendEvent(conn, {
        orgId: task.orgId,
        taskId: task.id,
        kind: "done",
        title: "Task completed",
      });
      await createNotification(conn, {
        orgId: task.orgId,
        userId: task.userId,
        kind: "task.succeeded",
        title: "Run finished",
        body: task.title,
        data: { taskId: task.id },
      });
    });
  }

  private async failTask(task: Task, error: unknown): Promise<void> {
    const fresh = await this.load(task);
    if (!fresh) return;
    const message = messageOf(error).slice(0, 2000);
    const retry = fresh.attempts < fresh.maxAttempts;
    await this.withTenant(task, async (conn) => {
      if (retry) {
        const delayMs = Math.min(60_000, 1000 * 2 ** fresh.attempts);
        await updateTask(conn, task.id, {
          status: "queued",
          error: message,
          leaseOwner: null,
          leaseUntil: null,
          runAfter: new Date(Date.now() + delayMs),
        });
        await appendEvent(conn, {
          orgId: task.orgId,
          taskId: task.id,
          kind: "error",
          title: "Step failed; retrying",
          detail: message,
        });
      } else {
        await updateTask(conn, task.id, {
          status: "failed",
          error: message,
          leaseOwner: null,
          leaseUntil: null,
          finishedAt: new Date(),
        });
        await appendEvent(conn, {
          orgId: task.orgId,
          taskId: task.id,
          kind: "error",
          title: "Task failed",
          detail: message,
        });
        await createNotification(conn, {
          orgId: task.orgId,
          userId: task.userId,
          kind: "task.failed",
          title: "Run failed",
          body: `${task.title} — ${message}`,
          data: { taskId: task.id },
        });
      }
    });
  }

  private buildContext(
    task: Task,
    step: TaskStep,
    stepCount: number,
    results: Record<number, unknown>,
    signal: AbortSignal,
    browser: BrowserDriver | null,
  ): StepContext {
    const tenant = <T>(fn: (conn: Conn) => Promise<T>) => this.withTenant(task, fn);
    const workspace = Workspace.forTask(
      this.deps.config.dataDir,
      task.orgId,
      task.userId,
      task.id,
      // Artifacts in Postgres means the host has no durable disk to write to.
      this.deps.config.artifactStore === "fs",
    );

    return {
      task,
      step,
      signal,
      results,
      config: this.deps.config,
      models: this.deps.models,
      workspace,
      browser,
      searchProvider: this.deps.config.searchProvider,
      searchUrl: this.deps.config.searchUrl,
      searchApiKey: this.deps.config.searchApiKey,
      report: async (kind, title, detail, data) => {
        await tenant((conn) =>
          appendEvent(conn, {
            orgId: task.orgId,
            taskId: task.id,
            kind,
            title,
            detail: detail ?? null,
            data,
          }),
        );
      },
      setProgress: async (progress, detail) => {
        const bounded = Math.max(0, Math.min(100, Math.round(progress)));
        await tenant(async (conn) => {
          await updateTask(conn, task.id, { progress: bounded });
          await appendEvent(conn, {
            orgId: task.orgId,
            taskId: task.id,
            kind: "progress",
            title: `Progress ${bounded}%`,
            detail: detail ?? null,
          });
        });
      },
      requestApproval: async (input) => {
        if (signal.aborted) throw new Error("Task cancelled");
        // Persist the decision request inside the transaction, then signal the
        // pause outside it: throwing inside would roll the request back.
        const outcome = await tenant(async (conn) => {
          const existing = (await listApprovals(conn, task.id)).filter(
            (approval) =>
              approval.stepId === step.id &&
              approval.kind === input.kind &&
              approval.status !== "expired",
          );
          const approved = existing.find((approval) => approval.status === "approved");
          if (approved) return "approved" as const;
          const denied = existing.find((approval) => approval.status === "denied");
          if (denied) return "denied" as const;
          if (existing.some((approval) => approval.status === "pending")) {
            return "pending" as const;
          }
          const approval = await createApproval(conn, {
            orgId: task.orgId,
            taskId: task.id,
            stepId: step.id,
            kind: input.kind,
            summary: input.summary.slice(0, 500),
            payload: input.payload,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          });
          await updateTask(conn, task.id, {
            status: "waiting_approval",
            leaseOwner: null,
            leaseUntil: null,
          });
          await updateStep(conn, step.id, { status: "waiting_approval" });
          await appendEvent(conn, {
            orgId: task.orgId,
            taskId: task.id,
            kind: "approval",
            title: "Approval required",
            detail: input.summary.slice(0, 500),
            data: { approvalId: approval.id, kind: input.kind },
          });
          await createNotification(conn, {
            orgId: task.orgId,
            userId: task.userId,
            kind: "approval.pending",
            title: "Approval needed",
            body: input.summary.slice(0, 500),
            data: { taskId: task.id, approvalId: approval.id },
          });
          return "pending" as const;
        });
        if (outcome === "pending") throw new ApprovalPending();
        return outcome === "approved";
      },
      saveArtifact: async (input) => {
        const id = newId();
        const stored = await this.deps.artifactStore.put({
          orgId: task.orgId,
          artifactId: id,
          name: input.name,
          bytes: input.bytes,
        });
        const artifact = await tenant(async (conn) => {
          const created = await createArtifact(conn, {
            id,
            orgId: task.orgId,
            taskId: task.id,
            userId: task.userId,
            name: input.name,
            mime: input.mime,
            sizeBytes: stored.sizeBytes,
            sha256: stored.sha256,
            storagePath: stored.storagePath,
            metadata: input.metadata,
          });
          await appendEvent(conn, {
            orgId: task.orgId,
            taskId: task.id,
            kind: "artifact",
            title: `Produced ${input.name}`,
            detail: `${stored.sizeBytes} bytes`,
            data: { artifactId: created.id, mime: input.mime, sha256: stored.sha256 },
          });
          return created;
        });
        return artifact;
      },
      getArtifact: async (id) => {
        const artifact = await tenant((conn) => getArtifact(conn, id, task.userId));
        if (!artifact) throw new Error("Artifact not found");
        return artifact;
      },
      readArtifact: async (id) => {
        const artifact = await tenant((conn) => getArtifact(conn, id, task.userId));
        if (!artifact) throw new Error("Artifact not found");
        return new Uint8Array(
          await this.deps.artifactStore.read(artifact.storagePath, task.orgId),
        );
      },
      remember: async (kind, content) => {
        await tenant((conn) =>
          createMemory(conn, {
            orgId: task.orgId,
            userId: task.userId,
            kind,
            content,
            source: `task:${task.id}`,
          }),
        );
      },
    };
  }

  /** Progress denominator used by the API when reporting step counts. */
  static stepProgress(stepCount: number): number {
    return stepCount > 0 ? Math.round(100 / stepCount) : 0;
  }
}
