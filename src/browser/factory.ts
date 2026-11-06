import type { Config } from "../core/config.js";
import type { BrowserDriver } from "./driver.js";
import { HttpBrowser } from "./http.js";
import { PlaywrightBrowser } from "./playwright.js";

/**
 * Picks the page reader this deployment can actually run.
 *
 * - `cdp` attaches to a remote browser (real Chromium, off-host).
 * - `chromium` launches a local Chrome/Chromium; long-running hosts only.
 * - `http` fetches and parses HTML with no JS engine; serverless default.
 * - `none` disables browsing entirely, so research fails honestly.
 */
export function createBrowser(config: Config): BrowserDriver | null {
  const policy = {
    allowedHosts: config.browserAllowedHosts,
    allowPrivateNetwork: config.browserAllowPrivate,
  };
  switch (config.browserMode) {
    case "cdp":
      if (!config.browserWsEndpoint) return null;
      return new PlaywrightBrowser({
        policy,
        wsEndpoint: config.browserWsEndpoint,
        timeoutMs: 30_000,
      });
    case "chromium":
      return new PlaywrightBrowser({
        policy,
        channel: config.browserChannel,
        timeoutMs: 30_000,
      });
    case "http":
      return new HttpBrowser({ policy, timeoutMs: 20_000 });
    case "none":
    default:
      return null;
  }
}
