import test from "node:test";
import assert from "node:assert/strict";
import { makeDatabase, makeUser, makeConfig, makeDataDir, sleep } from "./helpers.js";
import { AuthService } from "../src/auth/service.js";
import { createApp } from "../src/api/app.js";
import { ArtifactStore } from "../src/workspace/workspace.js";
import { ModelRouter } from "../src/intelligence/router.js";
import { MockProvider } from "../src/intelligence/providers/mock.js";
import { PhoneService } from "../src/phone/service.js";
import { getCommand } from "../src/db/phone-repos.js";
import { canonicalJson, hashArgs } from "../src/phone/protocol.js";

const PASSWORD = "a sufficiently long password";

function appFor(database: Awaited<ReturnType<typeof makeDatabase>>, dataDir: string) {
  const config = makeConfig({ DATA_DIR: dataDir, PUBLIC_URL: "https://talisman.test" });
  const auth = new AuthService(database, "test-secret-that-is-long-enough-0123456789");
  const app = createApp({
    config,
    database,
    auth,
    models: new ModelRouter([new MockProvider([{ text: "ok" }])], { defaultModel: "mock" }),
    artifactStore: new ArtifactStore(dataDir),
  });
  return { app, config, auth };
}

async function pair(
  app: ReturnType<typeof appFor>["app"],
  sessionToken: string,
  name = "Pixel 9",
): Promise<{ deviceId: string; token: string; code: string }> {
  const started = await app.request("/api/phone/pair/start", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ platform: "android", name }),
  });
  const startedText = await started.text();
  assert.equal(started.status, 201, startedText);
  const pairing = JSON.parse(startedText) as { code: string; qr: string; server: string };
  assert.match(pairing.code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  assert.equal(pairing.server, "https://talisman.test");
  assert.match(pairing.qr, /#code=/);

  const claimed = await app.request("/api/phone/pair/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: pairing.code,
      platform: "android",
      model: "Pixel 9",
      os_version: "16",
      app_version: "0.1.0",
    }),
  });
  const claimedText = await claimed.text();
  assert.equal(claimed.status, 201, claimedText);
  const body = JSON.parse(claimedText) as { deviceId: string; token: string; name: string };
  assert.equal(body.name, name);
  assert.match(body.token, new RegExp(`^${body.deviceId}\\.`));
  return { ...body, code: pairing.code };
}

test("pairing is single-use, tenant-scoped, and device tokens are stored hashed", async () => {
  const database = await makeDatabase();
  const dataDir = await makeDataDir();
  try {
    const { app } = appFor(database, dataDir);
    const alice = await makeUser(database);
    const bob = await makeUser(database);
    const first = await pair(app, alice.token);

    // The plaintext token is never stored.
    const row = await database.driver.query<{ token_hash: string }>(
      "SELECT token_hash FROM phone_devices WHERE id = $1",
      [first.deviceId],
    );
    assert.ok(row.rows[0]?.token_hash);
    assert.ok(!row.rows[0]!.token_hash.includes(first.token));

    const devices = await app.request("/api/devices", {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(devices.status, 200);
    const listed = (await devices.json()) as {
      devices: Array<{ id: string; name: string; token?: string }>;
    };
    assert.equal(listed.devices.length, 1);
    assert.equal(listed.devices[0]?.id, first.deviceId);
    assert.equal(listed.devices[0]?.token, undefined, "the device secret must never be listed");

    const duplicate = await app.request("/api/phone/pair/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: first.code, platform: "android" }),
    });
    assert.equal(duplicate.status, 422, "a pairing code must work exactly once");

    const crossTenant = await app.request(`/api/devices/${first.deviceId}`, {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    assert.equal(crossTenant.status, 404, "another tenant must not see the phone");

    const forged = await app.request("/api/phone/agent/poll", {
      method: "POST",
      headers: { authorization: `Bearer ${first.token.slice(0, -1)}x` },
    });
    assert.equal(forged.status, 401);
  } finally {
    await database.close();
  }
});

test("a command is claimed once, results are idempotent, and frames stay tenant-scoped", async () => {
  const database = await makeDatabase();
  const dataDir = await makeDataDir();
  try {
    const { app, config } = appFor(database, dataDir);
    const alice = await makeUser(database);
    const bob = await makeUser(database);
    const { deviceId, token } = await pair(app, alice.token);
    const service = new PhoneService(database, config.publicUrl);
    const device = await service.activeDevice(alice.user.orgId, alice.user.id);
    assert.ok(device);

    const queued = await service.enqueue(device!, {
      op: "observe",
      args: { include: "interactive" },
      idempotencyKey: "observe-once",
    });
    const duplicate = await service.enqueue(device!, {
      op: "observe",
      args: { include: "interactive" },
      idempotencyKey: "observe-once",
    });
    assert.equal(duplicate.id, queued.id, "idempotency keys must not create a second command");

    const claimed = await service.poll(device!, 1_000);
    assert.equal(claimed?.id, queued.id);
    assert.equal(claimed?.status, "claimed");
    assert.equal(await service.poll(device!, 50), null, "a claimed command must not be claimed again");

    const result = await app.request("/api/phone/agent/result", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        command_id: queued.id,
        status: "done",
        result: { screen: { package: "com.android.settings", nodes: [] } },
        duration_ms: 120,
      }),
    });
    const resultText = await result.text();
    assert.equal(result.status, 200, resultText);
    const firstResult = JSON.parse(resultText) as { updated: boolean; status: string };
    assert.equal(firstResult.updated, true);

    const retry = await app.request("/api/phone/agent/result", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        command_id: queued.id,
        status: "done",
        result: { screen: { package: "com.android.settings", nodes: [] } },
      }),
    });
    assert.equal(retry.status, 200);
    const retried = (await retry.json()) as { updated: boolean; status: string };
    assert.equal(retried.updated, false);
    assert.equal(retried.status, "done");

    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const uploaded = await app.request("/api/phone/agent/frame", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "image/jpeg",
        "x-talisman-seq": "7",
      },
      body: jpeg,
    });
    assert.equal(uploaded.status, 204, await uploaded.text());

    const frame = await app.request(`/api/devices/${deviceId}/frame`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get("content-type"), "image/jpeg");
    assert.equal(frame.headers.get("cache-control"), "no-store");
    assert.deepEqual(new Uint8Array(await frame.arrayBuffer()), jpeg);

    const foreignFrame = await app.request(`/api/devices/${deviceId}/frame`, {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    assert.equal(foreignFrame.status, 404);
  } finally {
    await database.close();
  }
});

test("pause cancels queued work, rotate kills the old token, and revoke is terminal", async () => {
  const database = await makeDatabase();
  const dataDir = await makeDataDir();
  try {
    const { app, config } = appFor(database, dataDir);
    const alice = await makeUser(database);
    const { deviceId, token } = await pair(app, alice.token);
    const service = new PhoneService(database, config.publicUrl);
    const device = await service.activeDevice(alice.user.orgId, alice.user.id);
    assert.ok(device);

    const queued = await service.enqueue(device!, { op: "status", args: {} });
    const paused = await app.request(`/api/devices/${deviceId}/pause`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(paused.status, 200);
    assert.equal(await service.poll((await service.get(alice.user.orgId, alice.user.id, deviceId)), 50), null);
    const cancelled = await database.withTenant(alice.user.orgId, alice.user.id, (conn) =>
      getCommand(conn, queued.id, deviceId),
    );
    assert.equal(cancelled?.status, "cancelled");

    const resumed = await app.request(`/api/devices/${deviceId}/resume`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(resumed.status, 200);

    const rotated = await app.request(`/api/devices/${deviceId}/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(rotated.status, 200);
    const rotation = (await rotated.json()) as { token: string };
    assert.notEqual(rotation.token, token);
    assert.equal(await service.authenticate(`Bearer ${token}`), null, "the old token must be dead");
    assert.ok(await service.authenticate(`Bearer ${rotation.token}`));

    const revoked = await app.request(`/api/devices/${deviceId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(revoked.status, 200);
    assert.equal(await service.authenticate(`Bearer ${rotation.token}`), null);
    const poll = await app.request("/api/phone/agent/poll", {
      method: "POST",
      headers: { authorization: `Bearer ${rotation.token}` },
    });
    assert.equal(poll.status, 401);
  } finally {
    await database.close();
  }
});

test("phone actions need an approval bound to the queued arguments", async () => {
  const database = await makeDatabase();
  const dataDir = await makeDataDir();
  try {
    const { app, config } = appFor(database, dataDir);
    const alice = await makeUser(database);
    const bob = await makeUser(database);
    const { deviceId, token } = await pair(app, alice.token);
    const service = new PhoneService(database, config.publicUrl);
    const device = await service.activeDevice(alice.user.orgId, alice.user.id);
    assert.ok(device);

    const args = { action: "launch", package: "com.android.settings" };
    const requested = await app.request(`/api/devices/${deviceId}/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ op: "act", args }),
    });
    const requestedText = await requested.text();
    assert.equal(requested.status, 201, requestedText);
    const { approval } = JSON.parse(requestedText) as {
      approval: { id: string; status: string; args: Record<string, unknown> };
    };
    assert.equal(approval.status, "pending");
    assert.deepEqual(approval.args, args);

    const queued = await database.withTenant(alice.user.orgId, alice.user.id, (conn) =>
      conn.query<{ n: number }>("SELECT count(*)::int AS n FROM phone_commands"),
    );
    assert.equal(queued.rows[0]?.n, 0, "requesting an approval must not queue the action");

    const foreign = await app.request(`/api/phone/approvals/${approval.id}/decision`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bob.token}`,
      },
      body: JSON.stringify({ decision: "approved" }),
    });
    assert.equal(foreign.status, 404, "another tenant must not decide this action");

    const pending = app.request(`/api/phone/approvals/${approval.id}/decision`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ decision: "approved" }),
    });
    await sleep(150);
    const command = await service.poll(device!, 2_000);
    assert.ok(command, "approval must queue a claimable command");
    assert.equal(command!.op, "act");
    assert.equal(command!.approvalId, approval.id);
    assert.equal(command!.argsHash, hashArgs(args));
    assert.deepEqual(command!.args, args);

    const completed = await app.request("/api/phone/agent/result", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        command_id: command!.id,
        status: "done",
        result: { ok: true, action: "launch" },
      }),
    });
    assert.equal(completed.status, 200, await completed.text());

    const decided = await pending;
    const decidedText = await decided.text();
    assert.equal(decided.status, 200, decidedText);
    const outcome = JSON.parse(decidedText) as {
      approval: { status: string };
      command: { status: string; result: unknown } | null;
    };
    assert.equal(outcome.approval.status, "approved");
    assert.equal(outcome.command?.status, "done");
    assert.deepEqual(outcome.command?.result, { ok: true, action: "launch" });

    const second = await app.request(`/api/devices/${deviceId}/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ op: "act", args: { action: "global", name: "home" } }),
    });
    const secondApproval = (await second.json()) as { approval: { id: string } };
    const denied = await app.request(`/api/phone/approvals/${secondApproval.approval.id}/decision`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ decision: "denied" }),
    });
    assert.equal(denied.status, 200);
    const after = await database.withTenant(alice.user.orgId, alice.user.id, (conn) =>
      conn.query<{ n: number }>("SELECT count(*)::int AS n FROM phone_commands"),
    );
    assert.equal(after.rows[0]?.n, 1, "a refused action must not queue a command");
  } finally {
    await database.close();
  }
});

test("expired commands are not delivered and argument hashes are stable", async () => {
  const database = await makeDatabase();
  const dataDir = await makeDataDir();
  try {
    const { app, config } = appFor(database, dataDir);
    const alice = await makeUser(database);
    await pair(app, alice.token);
    const service = new PhoneService(database, config.publicUrl);
    const device = await service.activeDevice(alice.user.orgId, alice.user.id);
    assert.ok(device);

    const command = await service.enqueue(device!, { op: "apps", args: {} });
    await database.withTenant(alice.user.orgId, alice.user.id, (conn) =>
      conn.query(
        "UPDATE phone_commands SET expires_at = now() - interval '1 second' WHERE id = $1",
        [command.id],
      ),
    );
    assert.equal(await service.poll(device!, 50), null);
    const expired = await database.withTenant(alice.user.orgId, alice.user.id, (conn) =>
      getCommand(conn, command.id),
    );
    assert.equal(expired?.status, "expired");

    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
    assert.equal(hashArgs({ b: 1, a: 2 }), hashArgs({ a: 2, b: 1 }));
    assert.notEqual(hashArgs({ text: "hello" }), hashArgs({ text: "hello " }));
  } finally {
    await database.close();
  }
});
