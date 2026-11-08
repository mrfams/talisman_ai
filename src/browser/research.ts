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

export type SearchProvider = "searxng" | "apinex";

export interface SearchOptions {
  limit?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  provider?: SearchProvider;
  apiKey?: string | null;
  /** Try DuckDuckGo when the configured provider is down or out of balance. */
  fallback?: boolean;
}

function normaliseResults(entries: unknown[], limit: number): SearchResult[] {
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const entry of entries) {
    const item = entry as Record<string, unknown>;
    const url = String(item.url ?? item.link ?? item.href ?? "");
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: String(item.title ?? item.name ?? "").slice(0, 300),
      url,
      snippet: String(
        item.snippet ?? item.content ?? item.description ?? item.text ?? "",
      ).slice(0, 500),
    });
    if (results.length >= limit) break;
  }
  return results;
}

/** SearXNG-compatible JSON search. No scraping of consumer search engines. */
async function searxngSearch(
  query: string,
  searchUrl: string,
  options: SearchOptions,
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
  return normaliseResults(results, options.limit ?? 5);
}

/**
 * APInex web search: POST /v1/tools/web/search. Returns web and news lists in
 * `results`, plus a usage block. Billed per call from the APInex balance.
 */
async function apinexSearch(
  query: string,
  searchUrl: string,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const apiKey = options.apiKey;
  if (!apiKey) {
    throw new Error("APInex search requires TALISMAN_SEARCH_API_KEY or OPENAI_API_KEY");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = searchUrl.replace(/\/+$/, "");
  const endpoint = /\/tools\/web\/search$/.test(base)
    ? new URL(base)
    : new URL(`${base}/tools/web/search`);
  const signals = [AbortSignal.timeout(SEARCH_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, count: options.limit ?? 5 }),
    signal: AbortSignal.any(signals),
  });
  const payload = (await response.json().catch(() => null)) as
    | { results?: unknown; error?: { message?: string } }
    | null;
  if (!response.ok) {
    const detail = payload?.error?.message ? `: ${payload.error.message}` : "";
    throw new Error(`APInex search returned HTTP ${response.status}${detail}`);
  }
  const container = payload?.results;
  const entries = Array.isArray(container)
    ? container
    : container && typeof container === "object"
      ? [
          ...((container as { web?: unknown[] }).web ?? []),
          ...((container as { news?: unknown[] }).news ?? []),
        ]
      : [];
  return normaliseResults(entries, options.limit ?? 5);
}

const DDG_HTML = "https://html.duckduckgo.com/html/";
const DDG_USER_AGENT =
  "Mozilla/5.0 (compatible; Talisman/0.2; +https://github.com/mrfams/talisman_ai)";

function decodeHtml(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "-",
    ndash: "-",
    hellip: "...",
    rsquo: "'",
    lsquo: "'",
    rdquo: '"',
    ldquo: '"',
  };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function plainText(html: string): string {
  return decodeHtml(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function ddgTarget(href: string): string | null {
  const decoded = decodeHtml(href);
  if (decoded.startsWith("//duckduckgo.com/l/") || decoded.startsWith("/l/")) {
    try {
      const redirect = new URL(decoded, "https://duckduckgo.com");
      const target = redirect.searchParams.get("uddg");
      if (target && /^https?:\/\//i.test(target)) return target;
    } catch {
      return null;
    }
  }
  return /^https?:\/\//i.test(decoded) ? decoded : null;
}

/**
 * Last-resort public search. No key and no account balance, so a paid provider
 * running out of credit cannot make every task fail. DuckDuckGo is used as a
 * fallback only; the configured provider stays the primary path.
 */
export async function duckDuckGoSearch(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = new URL(DDG_HTML);
  endpoint.searchParams.set("q", query);
  const signals = [AbortSignal.timeout(SEARCH_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  const response = await fetchImpl(endpoint, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": DDG_USER_AGENT,
    },
    signal: AbortSignal.any(signals),
  });
  if (!response.ok) throw new Error(`Fallback search returned HTTP ${response.status}`);
  const html = await response.text();
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const anchors = html.matchAll(
    /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
  );
  for (const anchor of anchors) {
    const target = ddgTarget(anchor[1] ?? "");
    if (!target || seen.has(target)) continue;
    seen.add(target);
    const rest = html.slice((anchor.index ?? 0) + anchor[0].length);
    const snippet =
      /<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(rest)?.[1] ??
      /<div\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(rest)?.[1] ??
      "";
    results.push({
      title: plainText(anchor[2] ?? "").slice(0, 300),
      url: target,
      snippet: plainText(snippet).slice(0, 500),
    });
    if (results.length >= (options.limit ?? 5)) break;
  }
  return results;
}

export async function searchWeb(
  query: string,
  searchUrl: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const primary = async () =>
    (options.provider ?? "searxng") === "apinex"
      ? apinexSearch(query, searchUrl, options)
      : searxngSearch(query, searchUrl, options);
  try {
    return await primary();
  } catch (error) {
    if (!options.fallback || options.signal?.aborted) throw error;
    try {
      const results = await duckDuckGoSearch(query, options);
      if (results.length > 0) return results;
    } catch {
      // Preserve the primary provider's error below; it is the actionable one.
    }
    throw error;
  }
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

/** Turns a task instruction into a shorter search query. */
export function searchQuery(goal: string): string {
  const cleaned = goal
    .replace(/https?:\/\/[^\s<>"')\]]+/g, " ")
    .replace(
      /\b(and\s+)?(prepare|write|create|compile|produce)\b[^.]*?\b(document|report|summary|brief|memo|pdf)\b[^.]*\.?/gi,
      " ",
    )
    .replace(/\b(please\s+)?(research|look up|find out|investigate)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || goal.trim()).slice(0, 200);
}

export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[.,;:]$/, "")))];
}
