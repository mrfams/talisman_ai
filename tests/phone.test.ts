import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { BridgePhone, CloudPhone, isPhoneOp, type PhoneTransport } from "../src/connectors/phone.js";
import { phoneTools } from "../src/connectors/phone-tools.js";

interface Recorded {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

async function fakeService(
  handle: (recorded: Recorded) => { status: number; json: unknown } | null,
): Promise<{ url: string; calls: Recorded[]; close: () => Promise<void> }> {
  const calls: Recorded[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const recorded: Recorded = {
      method: request.method ?? "GET",
      path: request.url ?? "/",
      body: raw ? JSON.parse(raw) : null,
      headers: request.headers,
    };
    calls.push(recorded);
    const outcome = handle(recorded);
    if (!outcome) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    response.writeHead(outcome.status, { "content-type": "application/json" });
    response.end(JSON.stringify(outcome.json));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("the cloud transport starts a session and drives it with the control token", async () => {
  let base = "";
  const service = await fakeService((call) => {
    if (call.path === "/me") {
      return {
        status: 200,
        json: { available: [{ id: "dev-1", name: "Pixel", platform: "android", state: "ready" }] },
      };
    }
    if (call.path === "/sessions" && call.method === "POST") {
      return { status: 201, json: { id: "sess-1", state: "starting" } };
    }
    if (call.path === "/sessions/sess-1") {
      return {
        status: 200,
        json: { state: "ready", control: { url: `${base}/control`, token: "control-token" } },
      };
    }
    if (call.path === "/control/op") {
      const body = call.body as { op: string; kw: Record<string, unknown> };
      if (body.op === "screen.capture") {
        return { status: 200, json: { result: { png_b64: "iVBORw0KGgo=", bounds: { w: 390, h: 844 } } } };
      }
      return { status: 200, json: { result: { op: body.op, kw: body.kw } } };
    }
    return null;
  });
  base = service.url;

  const phone = new CloudPhone("api-key", service.url, "dev-1");
  const status = await phone.status();
  assert.equal(status.ready, true);
  assert.match(status.label, /Pixel/);

  const tapped = await phone.send("input.tap", { x: 12, y: 34 });
  assert.deepEqual(tapped, { op: "input.tap", kw: { x: 12, y: 34 } });

  const shot = await phone.screenshot();
  assert.equal(shot.pngBase64, "iVBORw0KGgo=");
  assert.deepEqual(shot.bounds, { w: 390, h: 844 });

  const start = service.calls.find((call) => call.path === "/sessions");
  assert.ok(start, "a session was started");
  assert.equal((start!.body as { device_id: string }).device_id, "dev-1");
  assert.ok(start!.headers["idempotency-key"], "session start is idempotent");

  const op = service.calls.find((call) => call.path === "/control/op");
  assert.equal(op!.headers.authorization, "Bearer control-token");
  assert.ok(!String(op!.headers.authorization).includes("api-key"), "the API key never goes to the control URL");

  await service.close();
});

test("a rejected cloud key fails closed with an actionable message", async () => {
  const service = await fakeService((call) =>
    call.path === "/me" ? { status: 401, json: { error: "bad key" } } : null,
  );
  const phone = new CloudPhone("wrong", service.url);
  await assert.rejects(() => phone.send("screen.text", {}), /credentials were rejected/i);
  const status = await phone.status();
  assert.equal(status.ready, false);
  assert.match(status.detail, /bad key/);
  await service.close();
});

test("the bridge transport reports health and sends ops with its own token", async () => {
  const service = await fakeService((call) => {
    if (call.path === "/health") {
      return { status: 200, json: { ready: true, platform: "iPhone", ops: ["screen.text"] } };
    }
    if (call.path === "/op") {
      return { status: 200, json: { result: { boxes: [{ text: "Weather", x: 1, y: 2 }] } } };
    }
    return null;
  });

  const bridge = new BridgePhone(service.url, "bridge-token");
  const health = await bridge.status();
  assert.equal(health.ready, true);
  assert.match(health.label, /iPhone/);

  const text = await bridge.send("screen.text", {});
  assert.deepEqual(text, { boxes: [{ text: "Weather", x: 1, y: 2 }] });

  const op = service.calls.find((call) => call.path === "/op");
  assert.equal(op!.headers.authorization, "Bearer bridge-token");
  await service.close();
});

test("phone tools ask for approval before they touch the phone", async () => {
  const sent: { op: string; kw: Record<string, unknown> }[] = [];
  const phone: PhoneTransport = {
    kind: "bridge",
    label: "test",
    status: async () => ({ kind: "bridge", label: "test", ready: true, detail: "" }),
    screenshot: async () => ({ pngBase64: "" }),
    send: async (op, kw = {}) => {
      sent.push({ op, kw });
      if (op === "screen.text") {
        return [
          { text: "Send", x: 100, y: 200, w: 40, h: 20 },
          { text: "Cancel", x: 10, y: 200, w: 40, h: 20 },
        ];
      }
      if (op === "apps.current") return "Messages";
      return { ok: true };
    },
  };

  const tools = phoneTools({ phone });
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  assert.equal(byName.get("phone_tap_text")?.requiresApproval, true);
  assert.equal(byName.get("phone_type")?.requiresApproval, true);
  assert.equal(byName.get("phone_open_app")?.requiresApproval, true);
  assert.equal(byName.get("phone_look")?.requiresApproval ?? false, false);

  const tap = byName.get("phone_tap_text")!;
  const result = (await tap.execute(
    { text: "send" },
    { signal: new AbortController().signal, callId: "call-1" },
  )) as { tapped: string; at: { x: number; y: number } };
  assert.equal(result.tapped, "send");
  assert.deepEqual(result.at, { x: 120, y: 210 });
  assert.deepEqual(sent.at(-1), { op: "input.tap", kw: { x: 120, y: 210 } });

  const look = byName.get("phone_look")!;
  const screen = (await look.execute(
    {},
    { signal: new AbortController().signal, callId: "call-2" },
  )) as { app: string; count: number };
  assert.equal(screen.app, "Messages");
  assert.equal(screen.count, 2);

  assert.equal(phoneTools({ phone: null }).length, 0);
  assert.equal(isPhoneOp("input.tap"), true);
  assert.equal(isPhoneOp("input.teleport"), false);
});
