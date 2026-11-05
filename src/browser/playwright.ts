import { chromium, type Browser, type BrowserContext } from "playwright-core";
import type { BrowserDriver, PageContent } from "./driver.js";
import { assertUrlAllowed, type BrowserPolicy } from "./url-policy.js";
import { errors } from "../core/errors.js";
import { log } from "../core/log.js";

export interface PlaywrightDriverOptions {
  policy: BrowserPolicy;
  headless?: boolean;
  /** Use an installed Chrome instead of a bundled Chromium. */
  channel?: string | null;
  executablePath?: string;
  timeoutMs?: number;
  userAgent?: string;
}

/**
 * A real browser, one isolated context per research run. No persistent profile is
 * shared between users; cookies and storage die with the context.
 */
export class PlaywrightBrowser implements BrowserDriver {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly timeoutMs: number;

  constructor(private readonly options: PlaywrightDriverOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    this.browser = await chromium.launch({
      headless: this.options.headless ?? true,
      ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
      ...(this.options.channel ? { channel: this.options.channel } : {}),
      args: ["--disable-dev-shm-usage", "--disable-background-networking"],
    });
    this.context = await this.browser.newContext({
      userAgent:
        this.options.userAgent ??
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Talisman/0.1",
      viewport: { width: 1280, height: 900 },
      acceptDownloads: false,
      javaScriptEnabled: true,
    });
    this.context.setDefaultTimeout(this.timeoutMs);
    this.context.setDefaultNavigationTimeout(this.timeoutMs);
    return this.context;
  }

  async open(url: string, options?: { signal?: AbortSignal }): Promise<PageContent> {
    const target = await assertUrlAllowed(url, this.options.policy);
    if (options?.signal?.aborted) throw new Error("Browser navigation aborted");
    const context = await this.ensureContext();
    const page = await context.newPage();
    try {
      const response = await page.goto(target.toString(), {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });
      const status = response?.status() ?? 0;
      const finalUrl = page.url();
      // A redirect can land somewhere the policy forbids.
      await assertUrlAllowed(finalUrl, this.options.policy);
      if (status >= 400) {
        log.warn("browser page returned an error status", { url: finalUrl, status });
        throw errors.unavailable(`Page returned HTTP ${status}`);
      }
      const extracted = await page.evaluate(() => {
        const remove = ["script", "style", "noscript", "svg", "iframe"];
        for (const tag of remove) {
          for (const node of document.querySelectorAll(tag)) node.remove();
        }
        const description =
          document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "";
        const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
        const links = Array.from(document.querySelectorAll("a[href]"))
          .map((anchor) => (anchor as HTMLAnchorElement).href)
          .filter((href) => href.startsWith("http"));
        return {
          title: document.title,
          text,
          description,
          links: Array.from(new Set(links)).slice(0, 100),
        };
      });
      const contentType = response?.headers()["content-type"] ?? "";
      if (contentType && !/text\/html|application\/xhtml|text\/plain|application\/xml/.test(contentType)) {
        throw errors.invalid(`Unsupported page type: ${contentType.split(";")[0]}`);
      }
      return {
        requestedUrl: target.toString(),
        finalUrl,
        title: extracted.title.slice(0, 300) || target.hostname,
        text: extracted.text.slice(0, 40_000),
        description: extracted.description.slice(0, 1000),
        status,
        links: extracted.links,
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
  }
}
