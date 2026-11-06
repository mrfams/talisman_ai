import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed OAuth state. Google redirects the browser back without our session
 * cookie in every deployment shape, so the callback trusts this signature instead
 * of a cookie: it names the tenant and user, the exact redirect URI used, and an
 * expiry. Nothing is stored server-side.
 */
export interface OAuthState {
  orgId: string;
  userId: string;
  redirectUri: string;
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;

function mac(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function signState(secret: string, payload: Omit<OAuthState, "expiresAt">): string {
  const state: OAuthState = { ...payload, expiresAt: Date.now() + TTL_MS };
  const body = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${body}.${mac(secret, body)}`;
}

export function verifyState(secret: string, value: string | undefined): OAuthState | null {
  if (!value) return null;
  const [body, signature] = value.split(".");
  if (!body || !signature) return null;
  const expected = Buffer.from(mac(secret, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthState;
    if (
      typeof parsed.orgId !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.redirectUri !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt <= Date.now()
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
