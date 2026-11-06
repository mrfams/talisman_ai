/**
 * Live end-to-end check against a running Talisman deployment.
 *
 * It exercises the real HTTP API and the real task engine: signup, a research
 * task over real public pages, bounded execution slices, artifact download and
 * PDF structure, tenant isolation, and the cross-origin guard. No mocks.
 *
 *   BASE=https://talisman-agent.vercel.app node scripts/e2e-live.mjs
 */
const base = (process.env.BASE ?? "https://talisman-agent.vercel.app").replace(/\/$/, "");
const password = "talisman e2e password 2026";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function call(path, { method = "GET", body, cookie, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}

function sessionCookie(response) {
  const raw = response.headers.get("set-cookie") ?? "";
  const match = /talisman_session=([^;]+)/.exec(raw);
  return match ? `talisman_session=${match[1]}` : null;
}

async function signup(label) {
  const email = `e2e-${label}-${Date.now()}@example.com`;
  const response = await call("/api/auth/signup", {
    method: "POST",
    body: { email, password, orgName: `E2E ${label}` },
  });
  return { email, status: response.status, cookie: sessionCookie(response), json: response.json };
}

const run = async () => {
  const health = await call("/api/health");
  record(
    "health",
    health.status === 200 && health.json?.ok === true && health.json?.schema === "ok",
    JSON.stringify(health.json?.capabilities ?? {}),
  );

  const anonymous = await call("/api/tasks");
  record("anonymous request rejected", anonymous.status === 401, `HTTP ${anonymous.status}`);

  const alice = await signup("alice");
  record("signup", alice.status === 201 && Boolean(alice.cookie), `HTTP ${alice.status}`);

  const crossOrigin = await call("/api/tasks", {
    method: "POST",
    cookie: alice.cookie,
    body: { goal: "Research https://example.com and prepare a document" },
    headers: { origin: "https://attacker.example" },
  });
  record("cross-origin mutation refused", crossOrigin.status === 403, `HTTP ${crossOrigin.status}`);

  const created = await call("/api/tasks", {
    method: "POST",
    cookie: alice.cookie,
    body: {
      goal: "Research https://example.com and https://www.iana.org/help/example-domains and prepare a document about reserved example domains.",
      seedUrls: ["https://example.com", "https://www.iana.org/help/example-domains"],
      title: "Live E2E research",
    },
  });
  record("task created", created.status === 201, `HTTP ${created.status}`);
  const taskId = created.json?.task?.id;
  if (!taskId) throw new Error(`no task id: ${created.text.slice(0, 300)}`);

  let detail = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const slice = await call(`/api/tasks/${taskId}/run`, { method: "POST", cookie: alice.cookie });
    if (slice.status !== 200) {
      record("execution slice", false, `HTTP ${slice.status} ${slice.text.slice(0, 200)}`);
      break;
    }
    detail = (await call(`/api/tasks/${taskId}`, { cookie: alice.cookie })).json;
    if (["succeeded", "failed", "cancelled"].includes(detail?.task?.status)) break;
  }

  const task = detail?.task;
  const steps = detail?.steps ?? [];
  record("task succeeded", task?.status === "succeeded", `${task?.status ?? "?"} ${task?.error ?? ""}`);
  record(
    "all steps succeeded",
    steps.length >= 4 && steps.every((step) => step.status === "succeeded"),
    steps.map((step) => `${step.kind}:${step.status}`).join(", "),
  );

  const artifact = (detail?.artifacts ?? [])[0];
  record("artifact recorded", Boolean(artifact), artifact ? `${artifact.name} ${artifact.sizeBytes}B` : "none");

  if (artifact) {
    const response = await fetch(`${base}/api/artifacts/${artifact.id}`, {
      headers: { cookie: alice.cookie },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 8));
    const tail = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
    // Parse the document rather than scanning bytes: pdf-lib compresses object
    // streams, so a raw text scan says nothing about the real page count.
    let pages = 0;
    let parsed = false;
    try {
      const { PDFDocument } = await import("pdf-lib");
      pages = (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
      parsed = true;
    } catch {
      parsed = false;
    }
    const servedHash = response.headers.get("x-content-sha256");
    record(
      "PDF downloads and parses",
      response.status === 200 &&
        parsed &&
        head.startsWith("%PDF-") &&
        tail.includes("%EOF") &&
        bytes.byteLength > 1000 &&
        pages >= 1 &&
        servedHash === artifact.sha256,
      `${bytes.byteLength}B, ${pages} page(s), hash ${servedHash === artifact.sha256 ? "matches" : "MISMATCH"}`,
    );
  }

  const bob = await signup("bob");
  const foreignTask = await call(`/api/tasks/${taskId}`, { cookie: bob.cookie });
  record("other tenant cannot read the task", foreignTask.status === 404, `HTTP ${foreignTask.status}`);
  const foreignArtifact = artifact
    ? await call(`/api/artifacts/${artifact.id}`, { cookie: bob.cookie })
    : { status: 0 };
  record("other tenant cannot read the artifact", foreignArtifact.status === 404, `HTTP ${foreignArtifact.status}`);

  const pauseBefore = await call(`/api/tasks/${taskId}/run`, { method: "POST", cookie: alice.cookie });
  record("finished task is not re-executed", pauseBefore.json?.ran === false, JSON.stringify(pauseBefore.json?.reason ?? ""));

  const connectors = await call("/api/connectors", { cookie: alice.cookie });
  const google = connectors.json?.connectors?.find((entry) => entry.id === "google");
  record(
    "credential encryption is enabled",
    connectors.json?.encryption === true,
    `google configured: ${google?.configured ?? false}`,
  );
  const unconnected = await call("/api/connectors/google/verify", {
    method: "POST",
    cookie: alice.cookie,
  });
  record(
    "unconnected connector refuses to execute",
    unconnected.status === 409 || unconnected.status === 503,
    `HTTP ${unconnected.status}`,
  );

  const artifacts = await call("/api/artifacts", { cookie: alice.cookie });
  record(
    "artifact library lists the produced file",
    artifacts.status === 200 && (artifacts.json?.artifacts?.length ?? 0) > 0,
    `${artifacts.json?.artifacts?.length ?? 0} artifact(s)`,
  );

  const approvals = await call("/api/approvals", { cookie: alice.cookie });
  record(
    "approvals inbox answers",
    approvals.status === 200 && Array.isArray(approvals.json?.approvals),
    `HTTP ${approvals.status}`,
  );

  const activity = await call("/api/activity", { cookie: alice.cookie });
  record(
    "audit log answers for an owner",
    activity.status === 200 && (activity.json?.events?.length ?? 0) > 0,
    `${activity.json?.events?.length ?? 0} event(s)`,
  );

  const team = await call("/api/team", { cookie: alice.cookie });
  record(
    "team lists the owner",
    (team.json?.members?.length ?? 0) >= 1,
    `${team.json?.members?.length ?? 0} member(s)`,
  );

  const devices = await call("/api/devices", { cookie: alice.cookie });
  record(
    "device registry answers honestly",
    devices.status === 200 && typeof devices.json?.configured === "boolean",
    `configured: ${devices.json?.configured}`,
  );

  const devicesRoute = await fetch(`${base}/devices`, { headers: { accept: "text/html" } });
  const devicesHtml = await devicesRoute.text();
  record(
    "devices route serves the app shell",
    devicesRoute.status === 200 && devicesHtml.includes('id="root"'),
    `HTTP ${devicesRoute.status}`,
  );

  const shell = await fetch(`${base}/chat`, { headers: { accept: "text/html" } });
  const shellHtml = await shell.text();
  record(
    "app shell is served on a client route",
    shell.status === 200 &&
      shellHtml.includes('<div id="root">') &&
      /assets\/index-[^"]+\.js/.test(shellHtml),
    `HTTP ${shell.status}, ${shellHtml.length} bytes`,
  );
};

try {
  await run();
} catch (error) {
  record("e2e crashed", false, error instanceof Error ? error.message : String(error));
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed against ${base}`);
if (failed.length > 0) process.exitCode = 1;
