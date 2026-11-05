import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { errors } from "../core/errors.js";

export interface BrowserPolicy {
  allowedHosts: string[];
  allowPrivateNetwork: boolean;
}

const PRIVATE_V4 = [
  [/^10\./, "10/8"],
  [/^127\./, "loopback"],
  [/^169\.254\./, "link-local"],
  [/^172\.(1[6-9]|2\d|3[01])\./, "172.16/12"],
  [/^192\.168\./, "192.168/16"],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, "100.64/10"],
  [/^0\./, "0/8"],
] as const;

const BLOCKED_HOST_SUFFIXES = [".internal", ".local", ".localhost", ".home.arpa", ".lan"];

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::1" || normalized === "::") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (normalized.startsWith("fe80")) return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return PRIVATE_V4.some(([pattern]) => pattern.test(address));
}

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host === "::1") return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (isIP(host) && isPrivateAddress(host)) return true;
  return false;
}

/**
 * Validates a URL before the browser is allowed to open it, and resolves DNS so a
 * public-looking name cannot point at loopback. Redirects are re-checked by the
 * driver. Default deny: a hostname in `allowedHosts`, when non-empty, is required.
 */
export async function assertUrlAllowed(rawUrl: string, policy: BrowserPolicy): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw errors.invalid("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw errors.forbidden(`Blocked URL scheme: ${url.protocol}`);
  }
  if (url.username || url.password) throw errors.forbidden("URLs with credentials are blocked");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");

  if (policy.allowedHosts.length > 0) {
    const allowed = policy.allowedHosts.some(
      (entry) => hostname === entry || hostname.endsWith(`.${entry}`),
    );
    if (!allowed) throw errors.forbidden(`Host is not on the allowlist: ${hostname}`);
  }

  if (!policy.allowPrivateNetwork) {
    if (isPrivateHostname(hostname)) throw errors.forbidden(`Blocked private host: ${hostname}`);
    let addresses: string[] = [];
    try {
      addresses = (await lookup(hostname, { all: true })).map((entry) => entry.address);
    } catch {
      throw errors.invalid(`Could not resolve host: ${hostname}`);
    }
    if (addresses.length === 0) throw errors.invalid(`Could not resolve host: ${hostname}`);
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        throw errors.forbidden(`Blocked private address for ${hostname}`);
      }
    }
  }
  return url;
}
