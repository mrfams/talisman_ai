import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeDatabase, makeUser, makeConfig, makeDataDir, enqueueTask } from "./helpers.js";
import { TaskEngine } from "../src/runtime/engine.js";
import { defaultHandlers } from "../src/runtime/handlers.js";
import { ArtifactStore } from "../src/workspace/workspace.js";
import { ModelRouter } from "../src/intelligence/router.js";
import { MockProvider } from "../src/intelligence/providers/mock.js";
import { PlaywrightBrowser } from "../src/browser/playwright.js";
import { planGoal } from "../src/runtime/planner.js";
import { getArtifact, getTask, listSteps } from "../src/db/repos.js";
import { verifyPdf } from "../src/documents/pdf.js";

const CHROME =
  process.env.CHROME_PATH ??
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

function fixtureServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (url.startsWith("/alpha")) {
      response.end(`<!doctype html><html><head><title>Alpine Solar Report</title>
        <meta name="description" content="Field notes on solar adoption in alpine regions."></head>
        <body><nav>menu</nav><main>
        <h1>Alpine Solar Report</h1>
        <p>Solar adoption in alpine regions grew by 34 percent in 2025, driven by cheaper
        storage and village-level cooperatives. The report covers Switzerland, Austria and
        northern Italy.</p>
        <p>Grid constraints remain the main obstacle: high-voltage connections are scarce in
        mountain valleys, and permitting can take two winters.</p>
        <a href="/beta">Read the companion study</a>
        </main></body></html>`);
    } else if (url.startsWith("/beta")) {
      response.end(`<!doctype html><html><head><title>Battery Costs Study</title>
        <meta name="description" content="Storage price trends for mountain microgrids."></head>
        <body><main>
        <h1>Battery Costs Study</h1>
        <p>Battery pack prices for village microgrids fell below 190 dollars per kilowatt hour.
        The study attributes the fall to sodium-iron chemistry and larger order volumes.</p>
        <p>Maintenance, not hardware, is now the largest lifetime cost in remote deployments.</p>
        </main></body></html>`);
    } else {
      response.statusCode = 404;
      response.end("<html><body>not found</body></html>");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${address.port}` });
    });
  });
}

test("research task: real browser, real evidence, real PDF", { timeout: 180_000 }, async () => {
  const { server, base } = await fixtureServer();
  const database = await makeDatabase();
  const dataDir = await makeDataDir();
  const config = makeConfig({ DATA_DIR: dataDir, BROWSER_ALLOW_PRIVATE: "true" });
  try {
    assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}`);
    const { user } = await makeUser(database, "research@example.com");
    const goal = `Research ${base}/alpha and ${base}/beta and prepare a document about alpine solar.`;
    const plan = planGoal(goal);

    const browser = new PlaywrightBrowser({
      policy: { allowedHosts: [], allowPrivateNetwork: true },
      executablePath: CHROME,
      channel: null,
      timeoutMs: 20_000,
    });
    const engine = new TaskEngine({
      database,
      config,
      models: new ModelRouter([new MockProvider([{ text: "unused" }])], { defaultModel: "mock" }),
      handlers: defaultHandlers,
      artifactStore: new ArtifactStore(dataDir),
      workerId: "e2e-worker",
      browserFactory: () => browser,
    });

    const task = await enqueueTask(database, user.orgId, user.id, plan);
    const claimed = await engine.claim(user.orgId);
    assert.equal(claimed?.id, task.id);
    await engine.runClaimed(claimed!);

    const detail = await database.withTenant(user.orgId, user.id, async (conn) => ({
      task: await getTask(conn, task.id),
      steps: await listSteps(conn, task.id),
    }));
    assert.equal(
      detail.task?.status,
      "succeeded",
      `task failed: ${detail.task?.error ?? "unknown"} steps=${JSON.stringify(
        detail.steps.map((step) => [step.kind, step.status, step.error]),
      )}`,
    );
    assert.deepEqual(
      detail.steps.map((step) => step.status),
      ["succeeded", "succeeded", "succeeded", "succeeded"],
    );

    const result = detail.task?.result as { steps?: Record<string, unknown> } | undefined;
    const rendered = Object.values(result?.steps ?? {}).find(
      (value) => value && typeof value === "object" && "artifactId" in (value as object),
    ) as { artifactId: string; pageCount: number } | undefined;
    assert.ok(rendered?.artifactId, "no artifact id in task result");

    const artifact = await database.withTenant(user.orgId, user.id, (conn) =>
      getArtifact(conn, rendered.artifactId, user.id),
    );
    assert.ok(artifact);
    assert.equal(artifact!.mime, "application/pdf");
    assert.ok(artifact!.sizeBytes > 1000);

    const bytes = new Uint8Array(await readFile(artifact!.storagePath));
    const verification = await verifyPdf(bytes);
    assert.equal(verification.ok, true, verification.problems.join("; "));
    assert.ok(verification.pageCount >= 1);

    const markdown = await readFile(join(dataDir, "workspaces", user.orgId, user.id, task.id, "report.md"), "utf8");
    assert.match(markdown, /Alpine Solar Report/);
    assert.match(markdown, /grew by 34 percent/);
    assert.match(markdown, /Battery Costs Study/);
    assert.match(markdown, /190 dollars per kilowatt hour/);
    assert.match(markdown, new RegExp(`${base}/alpha`));
  } finally {
    server.close();
    await database.close();
  }
});
