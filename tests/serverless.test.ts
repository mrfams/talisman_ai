import test from "node:test";
import assert from "node:assert/strict";
import { makeDatabase, makeUser, makeConfig, makeDataDir, enqueueTask, sleep } from "./helpers.js";
import { TaskEngine, type StepHandler } from "../src/runtime/engine.js";
import { PgArtifactStore, ArtifactStore } from "../src/workspace/workspace.js";
import { ModelRouter } from "../src/intelligence/router.js";
import { MockProvider } from "../src/intelligence/providers/mock.js";
import { HttpBrowser, htmlToText } from "../src/browser/http.js";
import { getTask, listSteps } from "../src/db/repos.js";

function engineWith(
  database: Awaited<ReturnType<typeof makeDatabase>>,
  handlers: Record<string, StepHandler>,
  dataDir: string,
): TaskEngine {
  return new TaskEngine({
    database,
    config: makeConfig({ DATA_DIR: dataDir }),
    models: new ModelRouter([new MockProvider([{ text: "ok" }])], { defaultModel: "mock" }),
    handlers,
    artifactStore: new ArtifactStore(dataDir),
    workerId: "slice-worker",
    leaseMs: 30_000,
  });
}

test("a bounded slice hands the task back and the next slice finishes it", async () => {
  const database = await makeDatabase();
  const dataDir = await makeDataDir();
  let calls = 0;
  const engine = engineWith(
    database,
    {
      slow: async (context) => {
        calls += 1;
        if (calls === 1) {
          // Long enough to outlive the slice budget.
          for (let index = 0; index < 40; index += 1) {
            if (context.signal.aborted) break;
            await sleep(25);
          }
        }
        return { done: true };
      },
    },
    dataDir,
  );
  try {
    const { user } = await makeUser(database);
    const task = await enqueueTask(database, user.orgId, user.id, {
      steps: [{ title: "Slow", kind: "slow" }],
    });

    const claimed = await engine.claimById(user.orgId, user.id, task.id);
    assert.equal(claimed?.id, task.id);
    const first = await engine.runClaimed(claimed!, { budgetMs: 150 });
    assert.equal(first.outcome, "timed_out");

    const afterTimeout = await database.withTenant(user.orgId, user.id, async (conn) => ({
      task: await getTask(conn, task.id),
      steps: await listSteps(conn, task.id),
    }));
    assert.equal(afterTimeout.task?.status, "queued", "a timed-out slice must requeue the task");
    assert.equal(afterTimeout.task?.leaseOwner, null, "the lease must be released");
    assert.equal(afterTimeout.steps[0]?.status, "pending", "the running step must be resumable");

    const second = await engine.claimById(user.orgId, user.id, task.id);
    assert.ok(second, "the requeued task must be claimable again");
    const result = await engine.runClaimed(second!);
    assert.equal(result.outcome, "completed");

    const done = await database.withTenant(user.orgId, user.id, async (conn) => ({
      task: await getTask(conn, task.id),
      steps: await listSteps(conn, task.id),
    }));
    assert.equal(done.task?.status, "succeeded");
    assert.equal(done.task?.progress, 100);
    assert.deepEqual(done.steps[0]?.output, { done: true });

    const finished = await engine.claimById(user.orgId, user.id, task.id);
    assert.equal(finished, null, "a finished task must not be claimable");
  } finally {
    await database.close();
  }
});

test("a task waiting for approval is not claimable by the executor", async () => {
  const database = await makeDatabase();
  const dataDir = await makeDataDir();
  const engine = engineWith(
    database,
    {
      ask: async (context) => {
        await context.requestApproval({ kind: "publish", summary: "Publish it" });
        return {};
      },
    },
    dataDir,
  );
  try {
    const { user } = await makeUser(database);
    const task = await enqueueTask(database, user.orgId, user.id, {
      steps: [{ title: "Ask", kind: "ask" }],
    });
    const claimed = await engine.claimById(user.orgId, user.id, task.id);
    await engine.runClaimed(claimed!);

    const waiting = await database.withTenant(user.orgId, user.id, (conn) => getTask(conn, task.id));
    assert.equal(waiting?.status, "waiting_approval");
    assert.equal(await engine.claimById(user.orgId, user.id, task.id), null);
  } finally {
    await database.close();
  }
});

test("Postgres artifacts round-trip and stay inside their tenant", async () => {
  const database = await makeDatabase();
  const store = new PgArtifactStore(database);
  try {
    const alice = await makeUser(database);
    const bob = await makeUser(database);
    const bytes = new Uint8Array(Buffer.from("%PDF-1.4 fake bytes for the tenant test"));
    const stored = await store.put({
      orgId: alice.user.orgId,
      artifactId: "artifact-1",
      name: "report.pdf",
      bytes,
    });
    assert.equal(stored.sizeBytes, bytes.byteLength);
    assert.match(stored.storagePath, /^pg:/);

    const read = await store.read(stored.storagePath, alice.user.orgId);
    assert.equal(read.toString(), Buffer.from(bytes).toString());

    await assert.rejects(
      () => store.read(stored.storagePath, bob.user.orgId),
      /not found/i,
      "another tenant must not read the bytes",
    );
  } finally {
    await database.close();
  }
});

test("the HTTP reader extracts page text without scripts and refuses private hosts", async () => {
  const html = `<!doctype html><html><head><title>Alpine &amp; Solar</title>
    <meta name="description" content="Field notes"><style>.x{color:red}</style></head>
    <body><nav>menu</nav><script>alert("ignore me")</script>
    <h1>Real heading</h1><p>Solar adoption grew by 34 percent.</p>
    <a href="https://example.com/more">more</a></body></html>`;

  const extracted = htmlToText(html);
  assert.equal(extracted.title, "Alpine & Solar");
  assert.equal(extracted.description, "Field notes");
  assert.match(extracted.text, /Solar adoption grew by 34 percent/);
  assert.doesNotMatch(extracted.text, /alert|color:red/);
  assert.deepEqual(extracted.links, ["https://example.com/more"]);

  const browser = new HttpBrowser({
    policy: { allowedHosts: [], allowPrivateNetwork: true },
    fetchImpl: async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  assert.equal(browser.mode, "http");
  const page = await browser.open("https://example.com/article");
  assert.equal(page.title, "Alpine & Solar");
  assert.match(page.text, /Real heading/);
  assert.equal(page.status, 200);

  const blocked = new HttpBrowser({ policy: { allowedHosts: [], allowPrivateNetwork: false } });
  await assert.rejects(() => blocked.open("http://127.0.0.1/internal"), /private/i);
});
