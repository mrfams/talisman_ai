import test from "node:test";
import assert from "node:assert/strict";
import { makeDatabase, makeUser, makeConfig, makeDataDir, enqueueTask, sleep } from "./helpers.js";
import { TaskEngine, type StepHandler } from "../src/runtime/engine.js";
import { ArtifactStore } from "../src/workspace/workspace.js";
import { ModelRouter } from "../src/intelligence/router.js";
import { MockProvider } from "../src/intelligence/providers/mock.js";
import {
  decideApproval,
  getTask,
  listApprovals,
  listSteps,
  updateTask,
} from "../src/db/repos.js";

async function build(handlers: Record<string, StepHandler>) {
  const database = await makeDatabase();
  const user = await makeUser(database);
  const config = makeConfig({ DATA_DIR: await makeDataDir() });
  const engine = new TaskEngine({
    database,
    config,
    models: new ModelRouter([new MockProvider([{ text: "ok" }])], { defaultModel: "mock" }),
    handlers,
    artifactStore: new ArtifactStore(config.dataDir),
    workerId: "test-worker",
    leaseMs: 30_000,
  });
  return { database, user, config, engine };
}

test("a task that needs approval waits, then resumes and succeeds", async () => {
  const { database, user, engine } = await build({
    ask: async (context) => {
      const approved = await context.requestApproval({
        kind: "publish",
        summary: "Publish the report",
      });
      if (!approved) throw new Error("denied");
      return { published: true };
    },
  });
  try {
    const task = await enqueueTask(database, user.user.orgId, user.user.id, {
      steps: [{ title: "Publish", kind: "ask" }],
    });
    const claimed = await engine.claim(user.user.orgId);
    assert.equal(claimed?.id, task.id);
    await engine.runClaimed(claimed!);

    let state = await database.withTenant(user.user.orgId, user.user.id, async (conn) => ({
      task: await getTask(conn, task.id),
      approvals: await listApprovals(conn, task.id),
      steps: await listSteps(conn, task.id),
    }));
    assert.equal(state.task?.status, "waiting_approval");
    assert.equal(state.approvals.length, 1);
    assert.equal(state.approvals[0]!.status, "pending");
    assert.equal(state.steps[0]!.status, "waiting_approval");

    await database.withTenant(user.user.orgId, user.user.id, async (conn) => {
      await decideApproval(conn, state.approvals[0]!.id, "approved", user.user.id);
      await updateTask(conn, task.id, {
        status: "queued",
        attempts: 0,
        leaseOwner: null,
        leaseUntil: null,
      });
      await conn.query("UPDATE task_steps SET status = 'pending' WHERE task_id = $1", [task.id]);
    });

    const resumed = await engine.claim(user.user.orgId);
    assert.equal(resumed?.id, task.id);
    await engine.runClaimed(resumed!);
    state = await database.withTenant(user.user.orgId, user.user.id, async (conn) => ({
      task: await getTask(conn, task.id),
      approvals: await listApprovals(conn, task.id),
      steps: await listSteps(conn, task.id),
    }));
    assert.equal(state.task?.status, "succeeded");
    assert.equal(state.task?.progress, 100);
    assert.equal(state.steps[0]!.status, "succeeded");
    assert.deepEqual(state.steps[0]!.output, { published: true });
  } finally {
    await database.close();
  }
});

test("pause stops at a safe point and resume finishes the task", async () => {
  const { database, user, engine } = await build({
    slow: async (context) => {
      for (let index = 0; index < 100; index += 1) {
        if (context.signal.aborted) throw new Error("aborted");
        await sleep(25);
      }
      return { done: true };
    },
  });
  try {
    const task = await enqueueTask(database, user.user.orgId, user.user.id, {
      steps: [{ title: "Slow work", kind: "slow" }],
    });
    const claimed = await engine.claim(user.user.orgId);
    const running = engine.runClaimed(claimed!);
    await sleep(200);
    await database.withTenant(user.user.orgId, user.user.id, (conn) =>
      updateTask(conn, task.id, { status: "paused" }),
    );
    await running;

    let state = await database.withTenant(user.user.orgId, user.user.id, async (conn) => ({
      task: await getTask(conn, task.id),
      steps: await listSteps(conn, task.id),
    }));
    assert.equal(state.task?.status, "paused");
    assert.equal(state.steps[0]!.status, "pending");

    await database.withTenant(user.user.orgId, user.user.id, (conn) =>
      updateTask(conn, task.id, { status: "queued", attempts: 0, leaseOwner: null, leaseUntil: null }),
    );
    // The handler would run for 2.5s; replace it with an immediate success for resume.
    const fastEngine = new TaskEngine({
      database,
      config: makeConfig({ DATA_DIR: await makeDataDir() }),
      models: new ModelRouter([], { defaultModel: "none" }),
      handlers: { slow: async () => ({ done: true }) },
      artifactStore: new ArtifactStore((await makeDataDir())),
      workerId: "test-worker-2",
    });
    const resumed = await fastEngine.claim(user.user.orgId);
    await fastEngine.runClaimed(resumed!);
    state = await database.withTenant(user.user.orgId, user.user.id, async (conn) => ({
      task: await getTask(conn, task.id),
      steps: await listSteps(conn, task.id),
    }));
    assert.equal(state.task?.status, "succeeded");
  } finally {
    await database.close();
  }
});

test("cancel stops work and is terminal", async () => {
  const { database, user, engine } = await build({
    slow: async (context) => {
      for (let index = 0; index < 100; index += 1) {
        if (context.signal.aborted) throw new Error("aborted");
        await sleep(25);
      }
      return {};
    },
  });
  try {
    const task = await enqueueTask(database, user.user.orgId, user.user.id, {
      steps: [{ title: "Slow work", kind: "slow" }],
    });
    const claimed = await engine.claim(user.user.orgId);
    const running = engine.runClaimed(claimed!);
    await sleep(200);
    await database.withTenant(user.user.orgId, user.user.id, (conn) =>
      updateTask(conn, task.id, { status: "cancelled", finishedAt: new Date() }),
    );
    await running;
    const state = await database.withTenant(user.user.orgId, user.user.id, (conn) => getTask(conn, task.id));
    assert.equal(state?.status, "cancelled");
  } finally {
    await database.close();
  }
});

test("a step failure retries until attempts are exhausted, then fails", async () => {
  const { database, user, engine } = await build({
    boom: async () => {
      throw new Error("provider exploded");
    },
  });
  try {
    const task = await enqueueTask(
      database,
      user.user.orgId,
      user.user.id,
      { steps: [{ title: "Boom", kind: "boom" }] },
      { maxAttempts: 1 },
    );
    const claimed = await engine.claim(user.user.orgId);
    await engine.runClaimed(claimed!);
    const state = await database.withTenant(user.user.orgId, user.user.id, async (conn) => ({
      task: await getTask(conn, task.id),
      steps: await listSteps(conn, task.id),
    }));
    assert.equal(state.task?.status, "failed");
    assert.match(state.task?.error ?? "", /provider exploded/);
    assert.equal(state.steps[0]!.status, "failed");
  } finally {
    await database.close();
  }
});

test("a failure below max attempts is requeued with a backoff", async () => {
  const { database, user, engine } = await build({
    boom: async () => {
      throw new Error("temporary");
    },
  });
  try {
    const task = await enqueueTask(
      database,
      user.user.orgId,
      user.user.id,
      { steps: [{ title: "Boom", kind: "boom" }] },
      { maxAttempts: 3 },
    );
    const claimed = await engine.claim(user.user.orgId);
    await engine.runClaimed(claimed!);
    const state = await database.withTenant(user.user.orgId, user.user.id, (conn) => getTask(conn, task.id));
    assert.equal(state?.status, "queued");
    assert.ok(state?.runAfter);
    assert.equal(state?.attempts, 1);
  } finally {
    await database.close();
  }
});
