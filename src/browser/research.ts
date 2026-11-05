import type { BrowserDriver } from "./driver.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ResearchSource {
  url: string;
  title: string;
  text: string;
  description: string;
  fetchedAt: string;
  error?: string;
}

export interface CollectResult {
  sources: ResearchSource[];
  failures: Array<{ url: string; error: string }>;
}

const SEARCH_TIMEOUT_MS = 15_000;

/** SearXNG-compatible JSON search. No scraping of consumer search engines. */
export async function searchWeb(
  query: string,
  searchUrl: string,
  options: { limit?: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<SearchResult[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = new URL("/search", searchUrl.endsWith("/") ? searchUrl : `${searchUrl}/`);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  const signals = [AbortSignal.timeout(SEARCH_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  const response = await fetchImpl(endpoint, {
    headers: { accept: "application/json" },
    signal: AbortSignal.any(signals),
  });
  if (!response.ok) throw new Error(`Search provider returned HTTP ${response.status}`);
  const payload = (await response.json()) as { results?: unknown };
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results
    .map((entry) => {
      const item = entry as Record<string, unknown>;
      return {
        title: String(item.title ?? "").slice(0, 300),
        url: String(item.url ?? ""),
        snippet: String(item.content ?? "").slice(0, 500),
      };
    })
    .filter((result) => /^https?:\/\//.test(result.url))
    .slice(0, options.limit ?? 5);
}

/**
 * Reads pages sequentially, one failure at a time. A page that fails is recorded
 * and the run continues: partial evidence beats no evidence, and the failure is
 * visible in the task history.
 */
export async function collectSources(
  urls: readonly string[],
  browser: BrowserDriver,
  options: { maxSources?: number; maxCharsPerSource?: number; signal?: AbortSignal } = {},
): Promise<CollectResult> {
  const maxSources = options.maxSources ?? 4;
  const maxChars = options.maxCharsPerSource ?? 12_000;
  const sources: ResearchSource[] = [];
  const failures: Array<{ url: string; error: string }> = [];

  for (const url of urls.slice(0, maxSources)) {
    if (options.signal?.aborted) throw new Error("Research cancelled");
    try {
      const page = await browser.open(url, { signal: options.signal });
      sources.push({
        url: page.finalUrl,
        title: page.title,
        text: page.text.slice(0, maxChars),
        description: page.description,
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      failures.push({ url, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { sources, failures };
}

export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[.,;:]$/, "")))];
}
