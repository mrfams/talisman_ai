#!/usr/bin/env node
/**
 * Talisman phone bridge.
 *
 * A server cannot reach a personal iPhone or an adb Android. This process runs
 * on the machine that can: it exposes the Phone Harness op vocabulary over HTTP
 * and shells out to the `phone-harness` CLI for every call.
 *
 *   PHONE_BRIDGE_TOKEN=long-random-value node scripts/phone-bridge.mjs
 *   # then set PHONE_BRIDGE_URL=http://<this machine>:4319 on Talisman
 *
 * Security: a required bearer token, loopback by default, a fixed op allowlist,
 * a small body limit, no CORS and no directory access. It never returns the
 * machine's filesystem, only a PNG for `screen.capture`.
 */
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4319);
const HOST = process.env.HOST ?? "127.0.0.1";
const TOKEN = process.env.PHONE_BRIDGE_TOKEN ?? "";
const PYTHON = process.env.PHONE_HARNESS_BIN ?? "phone-harness";
const TIMEOUT_MS = Number(process.env.PHONE_BRIDGE_TIMEOUT_MS ?? 45_000);

const OPS = [
  "screen.capture",
  "screen.bounds",
  "screen.text",
  "input.tap",
  "input.text",
  "input.drag",
  "input.scroll",
  "nav.home",
  "nav.back",
  "apps.launch",
  "apps.current",
  "url.open",
  "session.state",
];

if (TOKEN.length < 24) {
  console.error("PHONE_BRIDGE_TOKEN must be set to at least 24 characters.");
  process.exit(1);
}

function authorised(header) {
  const value = header ?? "";
  const expected = `Bearer ${TOKEN}`;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function pythonFor(op, kw) {
  const args = JSON.stringify(kw ?? {});
  if (op === "screen.capture") {
    return [
      "import base64, json",
      "from phone_harness import helpers",
      "path, window = helpers.send('screen.capture')",
      "data = base64.b64encode(open(path, 'rb').read()).decode()",
      "print(json.dumps({'png_b64': data, 'bounds': window}))",
    ].join("\n");
  }
  if (op === "screen.text") {
    return [
      "import json",
      "from phone_harness import helpers",
      `kw = json.loads(${JSON.stringify(args)})`,
      "print(json.dumps(helpers.send('screen.text', **kw), default=str))",
    ].join("\n");
  }
  return [
    "import json",
    "from phone_harness import helpers",
    `kw = json.loads(${JSON.stringify(args)})`,
    `print(json.dumps(helpers.send(${JSON.stringify(op)}, **kw), default=str))`,
  ].join("\n");
}

function runHarness(op, kw) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `Could not run ${PYTHON}: ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `phone-harness exited ${code}` });
        return;
      }
      const line = stdout
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .pop();
      try {
        resolve({ ok: true, value: JSON.parse(line ?? "null") });
      } catch {
        resolve({ ok: false, error: `phone-harness returned unparseable output: ${line?.slice(0, 200)}` });
      }
    });
    child.stdin.end(pythonFor(op, kw));
  });
}

function reply(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 64_000) throw new Error("Request body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/health" && request.method === "GET") {
    const doctor = await runHarness("session.state", {});
    reply(response, 200, {
      ready: doctor.ok,
      platform: process.platform,
      detail: doctor.ok ? "Harness answered." : doctor.error,
      ops: OPS,
    });
    return;
  }
  if (!authorised(request.headers.authorization)) {
    reply(response, 401, { error: "Unauthorized" });
    return;
  }
  if (url.pathname === "/ops" && request.method === "GET") {
    reply(response, 200, { ops: OPS });
    return;
  }
  if (url.pathname === "/op" && request.method === "POST") {
    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      reply(response, 400, { error: error instanceof Error ? error.message : "Bad request" });
      return;
    }
    const op = String(body?.op ?? "");
    if (!OPS.includes(op)) {
      reply(response, 422, { error: `Unsupported op: ${op}` });
      return;
    }
    const kw = body?.kw && typeof body.kw === "object" && !Array.isArray(body.kw) ? body.kw : {};
    const outcome = await runHarness(op, kw);
    if (!outcome.ok) {
      reply(response, 502, { error: outcome.error });
      return;
    }
    reply(response, 200, { result: outcome.value });
    return;
  }
  reply(response, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`phone bridge on http://${HOST}:${PORT}`);
  console.log("Set PHONE_BRIDGE_URL and PHONE_BRIDGE_TOKEN on Talisman, then open Devices.");
});
