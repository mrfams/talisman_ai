import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { searchQuery, searchWeb } from "../src/browser/research.js";

function bodyOf(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
  });
}

async function withServer(
  handler: (request: IncomingMessage, body: string) => { status?: number; payload: unknown },
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(async (request, response) => {
    const body = await bodyOf(request);
    const { status = 200, payload } = handler(request, body);
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("APInex search sends auth and query, merges web and news, dedupes and limits", async () => {
  await withServer(
    (request, body) => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/tools/web/search");
      assert.equal(request.headers.authorization, "Bearer test-key");
      const parsed = JSON.parse(body) as { query: string; count: number };
      assert.equal(parsed.query, "alpine solar");
      assert.equal(parsed.count, 3);
      return {
        payload: {
          results: {
            web: [
              { title: "Alpine A", url: "https://a.example/page", snippet: "one" },
              { title: "Alpine B", link: "https://b.example/page", description: "two" },
            ],
            news: [
              { title: "Duplicate A", url: "https://a.example/page" },
              { title: "Alpine C", url: "https://c.example/page", content: "three" },
            ],
          },
          usage: { tool: "web.search", units: 1, cost_tokens: 600 },
        },
      };
    },
    async (base) => {
      const results = await searchWeb("alpine solar", `${base}/v1`, {
        provider: "apinex",
        apiKey: "test-key",
        limit: 3,
      });
      assert.deepEqual(
        results.map((result) => result.url),
        ["https://a.example/page", "https://b.example/page", "https://c.example/page"],
      );
      assert.equal(results[1]!.title, "Alpine B");
      assert.equal(results[1]!.snippet, "two");
    },
  );
});

test("APInex search surfaces the provider's billing message", async () => {
  await withServer(
    () => ({
      status: 402,
      payload: {
        error: { message: "Insufficient balance", type: "billing_error" },
      },
    }),
    async (base) => {
      await assert.rejects(
        searchWeb("anything", `${base}/v1`, {
          provider: "apinex",
          apiKey: "test-key",
        }),
        /HTTP 402: Insufficient balance/,
      );
    },
  );
});

test("APInex search fails clearly without a key", async () => {
  await assert.rejects(
    searchWeb("anything", "https://api.apinex.bond/v1", { provider: "apinex" }),
    /requires TALISMAN_SEARCH_API_KEY/,
  );
});

test("SearXNG search still maps results", async () => {
  await withServer(
    (request) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      assert.equal(url.pathname, "/search");
      assert.equal(url.searchParams.get("q"), "alpine solar");
      assert.equal(url.searchParams.get("format"), "json");
      return {
        payload: {
          results: [{ title: "Searx result", url: "https://s.example/x", content: "snippet" }],
        },
      };
    },
    async (base) => {
      const results = await searchWeb("alpine solar", base, { provider: "searxng" });
      assert.deepEqual(results, [
        { title: "Searx result", url: "https://s.example/x", snippet: "snippet" },
      ]);
    },
  );
});

test("a task instruction becomes a search query", () => {
  assert.equal(
    searchQuery("Research alpine solar https://example.com/a and prepare a document about it."),
    "alpine solar",
  );
});
