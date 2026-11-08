import { collectSources, searchWeb } from "../browser/research.js";
import type { BrowserDriver } from "../browser/driver.js";
import type { Config } from "../core/config.js";
import type { AgentTool } from "../intelligence/agent.js";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Live web tools for chat. Search is read-only, and it reads the top pages so
 * the model answers from page text rather than from search-result titles alone.
 * The configured provider is tried first; DuckDuckGo is the no-balance fallback.
 */
export function webTools({
  config,
  browserFactory,
}: {
  config: Config;
  browserFactory: () => BrowserDriver | null;
}): AgentTool[] {
  return [
    {
      definition: {
        name: "web_search",
        description:
          "Search the live web for current information. Returns results and readable excerpts from the top pages. Use this for questions and research instead of creating a task.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for" },
            limit: {
              type: "number",
              description: "Maximum results, from 1 to 8. Defaults to 5.",
            },
          },
          required: ["query"],
        },
      },
      execute: async (args, context) => {
        const query = String(args.query ?? "").trim().slice(0, 500);
        if (!query) return { error: "query is required" };
        const limit = Math.max(1, Math.min(8, Math.trunc(Number(args.limit ?? 5)) || 5));
        let results;
        try {
          results = await searchWeb(query, config.searchUrl ?? "", {
            provider: config.searchProvider,
            apiKey: config.searchApiKey,
            signal: context.signal,
            limit,
            fallback: true,
          });
        } catch (error) {
          return { error: `Web search failed: ${messageOf(error)}` };
        }
        if (results.length === 0) {
          return { query, results: [], error: "The search returned no results" };
        }

        const browser = browserFactory();
        if (!browser) {
          return {
            query,
            results,
            pages: [],
            note: "No page reader is configured on this host; use the result snippets.",
          };
        }
        try {
          const collected = await collectSources(
            results.slice(0, 3).map((result) => result.url),
            browser,
            {
              maxSources: 3,
              maxCharsPerSource: 3_500,
              signal: context.signal,
            },
          );
          return {
            query,
            results,
            pages: collected.sources.map((source) => ({
              title: source.title,
              url: source.url,
              text: source.text,
              description: source.description,
            })),
            failures: collected.failures,
            note:
              collected.sources.length === 0
                ? "The top pages could not be read; answer only from the snippets and say what is missing."
                : undefined,
          };
        } finally {
          await browser.close().catch(() => undefined);
        }
      },
    },
    {
      definition: {
        name: "read_page",
        description:
          "Read one web page and return its readable text. Use when a search result needs more detail or the user gives a URL.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "The http(s) URL to read" } },
          required: ["url"],
        },
      },
      execute: async (args, context) => {
        const url = String(args.url ?? "").trim();
        if (!/^https?:\/\//i.test(url)) return { error: "A valid http(s) URL is required" };
        const browser = browserFactory();
        if (!browser) return { error: "No page reader is configured on this host" };
        try {
          const page = await browser.open(url, { signal: context.signal });
          return {
            requestedUrl: page.requestedUrl,
            url: page.finalUrl,
            title: page.title,
            description: page.description,
            text: page.text.slice(0, 8_000),
          };
        } catch (error) {
          return { error: `Could not read ${url}: ${messageOf(error)}` };
        } finally {
          await browser.close().catch(() => undefined);
        }
      },
    },
  ];
}
