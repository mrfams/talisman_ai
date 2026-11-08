import test from "node:test";
import assert from "node:assert/strict";
import { makeDatabase, makeConfig, makeDataDir, makeUser } from "./helpers.js";
import { AuthService } from "../src/auth/service.js";
import { createApp } from "../src/api/app.js";
import { ArtifactStore } from "../src/workspace/workspace.js";
import { ModelRouter } from "../src/intelligence/router.js";
import { MockProvider } from "../src/intelligence/providers/mock.js";
import { updateTask } from "../src/db/repos.js";
import type { TaskEngine } from "../src/runtime/engine.js";
import type { Task } from "../src/core/types.js";

test("chat create_task runs a bounded slice and streams the task status", async () => {
  const database = await makeDatabase();
  const config = makeConfig({ DATA_DIR: await makeDataDir() });
  try {
    const { auth, token, user } = await makeUser(database);
    const runs: Array<{ taskId: string; budgetMs: number }> = [];
    const engine = {
      claimById: async (_orgId: string, _userId: string, taskId: string) =>
        ({ id: taskId }) as Task,
      runClaimed: async (task: Task, options: { budgetMs?: number } = {}) => {
        runs.push({ taskId: task.id, budgetMs: options.budgetMs ?? 0 });
        await database.withTenant(user.orgId, user.id, (conn) =>
          updateTask(conn, task.id, { status: "running", progress: 50 }),
        );
        return { outcome: "timed_out" as const };
      },
    };
    const app = createApp({
      config,
      database,
      auth,
      models: new ModelRouter(
        [
          new MockProvider([
            {
              toolCalls: [
                {
                  id: "call_1",
                  name: "create_task",
                  arguments: { goal: "Research the name Famara and write a short report" },
                },
              ],
            },
            { text: "The run is at 50%." },
          ]),
        ],
        { defaultModel: "mock" },
      ),
      artifactStore: new ArtifactStore(config.dataDir),
      engine: engine as unknown as TaskEngine,
    });
    const cookie = `talisman_session=${token}`;
    const created = await app.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "Task verification" }),
    });
    assert.equal(created.status, 201);
    const conversation = (await created.json()) as { conversation: { id: string } };

    const response = await app.request(`/api/conversations/${conversation.conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: "Research Famara" }),
    });
    assert.equal(response.status, 200);
    const sse = await response.text();

    assert.equal(runs.length, 1);
    assert.ok(runs[0]!.budgetMs > 0 && runs[0]!.budgetMs <= 20_000);
    assert.match(sse, /"name":"create_task"/);
    assert.match(sse, /"task":\{"id":"[^"]+","status":"running","progress":50\}/);
    assert.match(sse, /event: done/);
  } finally {
    await database.close();
  }
});

test("API: signup, create a task, read progress and scope artifacts", async () => {
  const database = await makeDatabase();
  const config = makeConfig({ DATA_DIR: await makeDataDir() });
  try {
    const app = createApp({
      config,
      database,
      auth: new AuthService(database, "c".repeat(32)),
      models: new ModelRouter([new MockProvider([{ text: "hello" }])], { defaultModel: "mock" }),
      artifactStore: new ArtifactStore(config.dataDir),
    });

    const signup = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "api@example.com",
        password: "a sufficiently long password",
        orgName: "API Org",
      }),
    });
    assert.equal(signup.status, 201);
    const cookie = signup.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);

    const me = await app.request("/api/me", { headers: { cookie: cookie! } });
    assert.equal(me.status, 200);

    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({
        goal: "Research https://example.com/report and prepare a document",
        title: "API task",
      }),
    });
    assert.equal(created.status, 201);
    const { task } = (await created.json()) as { task: { id: string; status: string } };
    assert.equal(task.status, "queued");

    const detail = await app.request(`/api/tasks/${task.id}`, { headers: { cookie: cookie! } });
    assert.equal(detail.status, 200);
    const body = (await detail.json()) as {
      task: { id: string };
      steps: unknown[];
      events: unknown[];
    };
    assert.equal(body.task.id, task.id);
    assert.equal(body.events.length, 1);
    assert.equal(body.steps.length, 0);

    const paused = await app.request(`/api/tasks/${task.id}/pause`, {
      method: "POST",
      headers: { cookie: cookie! },
    });
    assert.equal(paused.status, 200);
    const pausedBody = (await paused.json()) as { task: { status: string } };
    assert.equal(pausedBody.task.status, "paused");

    const resumed = await app.request(`/api/tasks/${task.id}/resume`, {
      method: "POST",
      headers: { cookie: cookie! },
    });
    assert.equal(resumed.status, 200);

    const artifact = await app.request("/api/artifacts/does-not-exist", {
      headers: { cookie: cookie! },
    });
    assert.equal(artifact.status, 404);

    const anonymous = await app.request("/api/tasks");
    assert.equal(anonymous.status, 401);
  } finally {
    await database.close();
  }
});
