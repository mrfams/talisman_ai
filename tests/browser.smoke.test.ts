import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { PlaywrightBrowser } from "../src/browser/playwright.js";
import { buildResearchReport, renderReportMarkdown } from "../src/documents/report.js";
import { renderReportPdf, verifyPdf } from "../src/documents/pdf.js";

const WINDOWS_CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

function chromeOptions(): { executablePath?: string; channel: string | null } {
  const configured = process.env.CHROME_PATH;
  if (configured && existsSync(configured)) return { executablePath: configured, channel: null };
  if (existsSync(WINDOWS_CHROME)) return { executablePath: WINDOWS_CHROME, channel: null };
  return { channel: "chrome" };
}

test("real Chromium reads a page and produces a verified PDF", { timeout: 120_000 }, async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url?.startsWith("/evidence")) {
      response.end(`<!doctype html><html><head><title>Coastal Restoration Notes</title>
        <meta name="description" content="A field note about dune restoration."></head>
        <body><nav>ignore me</nav><main>
        <h1>Coastal Restoration Notes</h1>
        <p>Dune restoration in the northern delta reduced storm damage by 41 percent over
        three seasons, according to the regional survey published this spring.</p>
        <p>Volunteer planting accounted for most of the new vegetation, with councils
        supplying fencing and seed.</p>
        </main></body></html>`);
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = new PlaywrightBrowser({
    policy: { allowedHosts: [], allowPrivateNetwork: true },
    ...chromeOptions(),
    timeoutMs: 25_000,
  });

  try {
    const page = await browser.open(`${base}/evidence`);
    assert.equal(page.title, "Coastal Restoration Notes");
    assert.match(page.text, /reduced storm damage by 41 percent/);
    assert.match(page.text, /Coastal Restoration Notes/);

    const report = buildResearchReport({
      subject: "Coastal restoration",
      sources: [
        {
          url: page.finalUrl,
          title: page.title,
          text: page.text,
          description: page.description,
          fetchedAt: new Date().toISOString(),
        },
      ],
    });
    const markdown = renderReportMarkdown(report);
    assert.match(markdown, /reduced storm damage by 41 percent/);
    assert.match(markdown, /Coastal Restoration Notes/);
    assert.ok(report.sources[0]!.url.startsWith(base));

    const { bytes, pageCount } = await renderReportPdf(report);
    assert.ok(pageCount >= 1);
    const verification = await verifyPdf(bytes);
    assert.equal(verification.ok, true, verification.problems.join("; "));
    assert.ok(verification.sizeBytes > 1000);
    assert.match(new TextDecoder("latin1").decode(bytes.subarray(0, 5)), /%PDF-/);
  } finally {
    await browser.close();
    server.close();
  }
});
