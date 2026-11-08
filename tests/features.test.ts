import test from "node:test";
import assert from "node:assert/strict";
import { makeDatabase, makeConfig, makeDataDir, makeUser } from "./helpers.js";
import { createApp } from "../src/api/app.js";
import { ArtifactStore } from "../src/workspace/workspace.js";
import { ModelRouter } from "../src/intelligence/router.js";
import { MockProvider } from "../src/intelligence/providers/mock.js";
import { createNotification, listTasks } from "../src/db/repos.js";

test("profile, memory, schedules and notifications are tenant-scoped API features", async () => {
  const database = await makeDatabase();
  const config = makeConfig({ DATA_DIR: await makeDataDir() });
  try {
    const { auth, token, user } = await makeUser(database);
    const app = createApp({
      config,
      database,
      auth,
      models: new ModelRouter([new MockProvider([{ text: "ok" }])], { defaultModel: "mock" }),
      artifactStore: new ArtifactStore(config.dataDir),
      embedder: null,
    });
    const cookie = `talisman_session=${token}`;
    const headers = { "content-type": "application/json", cookie };

    const savedProfile = await app.request("/api/profile", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        displayName: "Sam",
        timezone: "Europe/London",
        locale: "en-GB",
      }),
    });
    assert.equal(savedProfile.status, 200);
    const profileBody = (await savedProfile.json()) as {
      profile: { displayName: string; timezone: string; locale: string };
    };
    assert.equal(profileBody.profile.displayName, "Sam");
    assert.equal(profileBody.profile.timezone, "Europe/London");

    const invalidZone = await app.request("/api/profile", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ timezone: "Mars/Olympus" }),
    });
    assert.equal(invalidZone.status, 422);

    const createdMemory = await app.request("/api/memories", {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "Prefers a short brief before 9am.", kind: "preference" }),
    });
    assert.equal(createdMemory.status, 201);
    const memoryBody = (await createdMemory.json()) as {
      memory: { id: string; embedding?: number[] };
    };
    assert.equal(memoryBody.memory.embedding, undefined);
    const listedMemories = await app.request("/api/memories", { headers: { cookie } });
    const memoryList = (await listedMemories.json()) as { memories: Array<{ id: string }> };
    assert.equal(memoryList.memories[0]?.id, memoryBody.memory.id);

    const createdSchedule = await app.request("/api/schedules", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Hourly check",
        goal: "Check the status page and report anything new.",
        kind: "interval",
        intervalMinutes: 15,
        timezone: "Europe/London",
      }),
    });
    assert.equal(createdSchedule.status, 201);
    const scheduleBody = (await createdSchedule.json()) as {
      schedule: { id: string; enabled: boolean; nextRunAt: string };
    };
    assert.equal(scheduleBody.schedule.enabled, true);

    const paused = await app.request(`/api/schedules/${scheduleBody.schedule.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(paused.status, 200);
    assert.equal(((await paused.json()) as { schedule: { enabled: boolean } }).schedule.enabled, false);

    const ranNow = await app.request(`/api/schedules/${scheduleBody.schedule.id}/run`, {
      method: "POST",
      headers,
    });
    assert.equal(ranNow.status, 201);
    const tasks = await database.withTenant(user.orgId, user.id, (conn) =>
      listTasks(conn, user.orgId, user.id),
    );
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.goal, "Check the status page and report anything new.");

    await database.withTenant(user.orgId, user.id, (conn) =>
      createNotification(conn, {
        orgId: user.orgId,
        userId: user.id,
        kind: "task.succeeded",
        title: "Run finished",
        body: "Hourly check",
        data: { taskId: tasks[0]!.id },
      }),
    );
    const inbox = await app.request("/api/notifications", { headers: { cookie } });
    const inboxBody = (await inbox.json()) as { unread: number; notifications: unknown[] };
    assert.equal(inboxBody.unread, 1);
    assert.equal(inboxBody.notifications.length, 1);

    const readAll = await app.request("/api/notifications/read-all", {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(readAll.status, 200);
    const after = await app.request("/api/notifications", { headers: { cookie } });
    assert.equal(((await after.json()) as { unread: number }).unread, 0);

    const removed = await app.request(`/api/schedules/${scheduleBody.schedule.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(removed.status, 200);
  } finally {
    await database.close();
  }
});
