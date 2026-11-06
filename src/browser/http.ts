import type { BrowserDriver, PageContent } from "./driver.js";
import { assertUrlAllowed, type BrowserPolicy } from "./url-policy.js";
import { errors } from "../core/errors.js";

const USER_AGENT =
  "Mozilla/5.0 (compatible; Talisman/0.2; +https://github.com/mrfams/talisman_ai)";

const BLOCK_TAGS =
  /<\/?(?:p|div|section|article|header|footer|main|aside|nav|h[1-6]|li|ul|ol|tr|table|thead|tbody|blockquote|pre|br|hr|figure|figcaption)\b[^>]*>/gi;

function decodeEntities(text: string): string {
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

/**
 * Extracts readable text from an HTML document without a DOM. Scripts, styles
 * and embedded frames are removed first so their contents never reach the report.
 */
export function htmlToText(html: string): { title: string; description: string; text: string; links: string[] } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const description =
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ??
    /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html)?.[1] ??
    "";

  const body = /<body[^>]*>([\s\S]*)$/i.exec(html)?.[1] ?? html;
  const stripped = body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(BLOCK_TAGS, "\n")
    .replace(/<[^>]+>/g, " ");

  const text = decodeEntities(stripped)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const links: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) {
    const href = match[1];
    if (href && /^https?:\/\//i.test(href)) links.push(href);
  }

  return {
    title: decodeEntities(title).replace(/\s+/g, " ").trim(),
    description: decodeEntities(description).replace(/\s+/g, " ").trim(),
    text,
    links: Array.from(new Set(links)).slice(0, 100),
  };
}

export interface HttpBrowserOptions {
  policy: BrowserPolicy;
  timeoutMs?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Reads pages over plain HTTP with no JavaScript engine. This is the fallback for
 * serverless hosts, where a Chromium binary cannot be shipped or launched. It
 * fetches the real page and extracts its real text; it cannot see client-rendered
 * content, so pages that exist only after hydration return little or nothing.
 * The task history records which reader was used.
 */
export class HttpBrowser implements BrowserDriver {
  readonly mode = "http";
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpBrowserOptions) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async open(url: string, options?: { signal?: AbortSignal }): Promise<PageContent> {
    const target = await assertUrlAllowed(url, this.options.policy);
    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (options?.signal) signals.push(options.signal);
    const fetchImpl = this.options.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await fetchImpl(target, {
        redirect: "follow",
        headers: {
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
          "user-agent": this.options.userAgent ?? USER_AGENT,
        },
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (options?.signal?.aborted) throw new Error("Browser navigation aborted");
      throw errors.unavailable(
        `Could not fetch ${target.hostname}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const finalUrl = response.url || target.toString();
    // A redirect can land somewhere the policy forbids.
    await assertUrlAllowed(finalUrl, this.options.policy);

    if (response.status >= 400) {
      throw errors.unavailable(`Page returned HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/text\/html|application\/xhtml|text\/plain|application\/xml/i.test(contentType)) {
      throw errors.invalid(`Unsupported page type: ${contentType.split(";")[0]}`);
    }

    const html = await response.text();
    const extracted = htmlToText(html);
    return {
      requestedUrl: target.toString(),
      finalUrl,
      title: (extracted.title || new URL(finalUrl).hostname).slice(0, 300),
      text: extracted.text.slice(0, 40_000),
      description: extracted.description.slice(0, 1000),
      status: response.status,
      links: extracted.links,
    };
  }

  async close(): Promise<void> {
    // Nothing to release: each read is an independent request.
  }
}
