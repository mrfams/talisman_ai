import { randomUUID } from "node:crypto";
import type { Config } from "../core/config.js";
import { errors } from "../core/errors.js";

/**
 * Phone control over the Phone Harness op vocabulary.
 *
 * Two transports, one interface:
 *  - cloud: `POST {control.url}/op` with the session's control token, after
 *    `POST /sessions` and polling until `ready` (api.phone-harness.com).
 *  - bridge: a small authenticated server on the user's machine that shells out
 *    to the `phone-harness` CLI (scripts/phone-bridge.mjs).
 *
 * Ops are exactly the ones the harness documents in transport.py OP_NAMES.
 * A server can never drive a personal iPhone or an adb Android directly, so the
 * bridge is not a workaround: it is the only honest path for those phones.
 */

export const PHONE_OPS = [
  "screen.capture",
  "screen.bounds",
  "screen.text",
  "input.tap",
  "input.text",
  "input.drag",
  "input.scroll",
  "nav.home",
  "nav.back",
  "apps.launch",
  "apps.current",
  "url.open",
  "session.state",
] as const;

export type PhoneOp = (typeof PHONE_OPS)[number];

export interface PhoneStatus {
  kind: "cloud" | "bridge" | "companion";
  label: string;
  ready: boolean;
  detail: string;
  ops?: string[];
}

export interface PhoneShot {
  pngBase64: string;
  /** Companion screenshots are JPEG; the field name is kept for compatibility. */
  mime?: string;
  bounds?: unknown;
}

export interface PhoneTransport {
  readonly kind: "cloud" | "bridge" | "companion";
  readonly label: string;
  status(): Promise<PhoneStatus>;
  send(op: PhoneOp, kw?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  screenshot(signal?: AbortSignal): Promise<PhoneShot>;
}

const CLOUD_API = "https://api.phone-harness.com";

export function isPhoneOp(value: string): value is PhoneOp {
  return (PHONE_OPS as readonly string[]).includes(value);
}

async function requestJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
  outer?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (error) {
    throw errors.unavailable(
      `Phone service unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const detail =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      throw errors.unavailable(`Phone credentials were rejected: ${detail}`);
    }
    throw errors.unavailable(`Phone service error: ${detail}`);
  }
  return body;
}

function shotFrom(payload: unknown): PhoneShot {
  const box =
    payload && typeof payload === "object" && "result" in payload
      ? (payload as { result: unknown }).result
      : payload;
  if (!box || typeof box !== "object") throw errors.unavailable("The phone returned no image");
  const record = box as Record<string, unknown>;
  const png = record.png_b64 ?? record.png;
  if (typeof png !== "string" || png.length === 0) {
    throw errors.unavailable("The phone returned no image");
  }
  return { pngBase64: png, bounds: record.bounds };
}

/* -------------------------------------------------------------------- cloud */

interface CloudSession {
  id: string;
  control: { url: string; token: string };
  expiresAt: number;
}

export class CloudPhone implements PhoneTransport {
  readonly kind = "cloud" as const;
  readonly label = "Phone Harness Cloud";
  private session: CloudSession | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly apiBase = CLOUD_API,
    private readonly deviceId?: string,
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" };
  }

  async status(): Promise<PhoneStatus> {
    try {
      const body = (await requestJson(
        `${this.apiBase}/me`,
        { headers: this.headers() },
        15_000,
      )) as { available?: { id?: string; name?: string; platform?: string; state?: string }[] };
      const phones = body?.available ?? [];
      const chosen = this.deviceId
        ? phones.find((phone) => phone.id === this.deviceId)
        : phones[0];
      if (!chosen?.id) {
        return {
          kind: this.kind,
          label: this.label,
          ready: false,
          detail: "The account has no phone available.",
        };
      }
      return {
        kind: this.kind,
        label: chosen.name ?? `Cloud ${chosen.platform ?? "phone"}`,
        ready: true,
        detail: `${phones.length} phone(s) on the account${chosen.state ? ` · ${chosen.state}` : ""}`,
      };
    } catch (error) {
      return {
        kind: this.kind,
        label: this.label,
        ready: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async control(signal?: AbortSignal): Promise<CloudSession> {
    if (this.session && this.session.expiresAt > Date.now() + 30_000) return this.session;
    const me = (await requestJson(
      `${this.apiBase}/me`,
      { headers: this.headers() },
      15_000,
      signal,
    )) as { available?: { id?: string; platform?: string }[] };
    const phones = me?.available ?? [];
    const target = this.deviceId
      ? phones.find((phone) => phone.id === this.deviceId)
      : phones[0];
    if (!target?.id) {
      throw errors.unavailable("No cloud phone is available on this account.");
    }
    const created = (await requestJson(
      `${this.apiBase}/sessions`,
      {
        method: "POST",
        headers: { ...this.headers(), "idempotency-key": randomUUID() },
        body: JSON.stringify({
          platform: target.platform ?? "android",
          kind: "device",
          device_id: target.id,
          timeout_seconds: 900,
        }),
      },
      30_000,
      signal,
    )) as { id?: string; state?: string; control?: { url?: string; token?: string } };
    if (!created?.id) throw errors.unavailable("The cloud refused to start a phone session.");
    const id = created.id;

    let control = created.control;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (control?.url && control.token) break;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const session = (await requestJson(
        `${this.apiBase}/sessions/${encodeURIComponent(id)}`,
        { headers: this.headers() },
        15_000,
        signal,
      )) as { state?: string; control?: { url?: string; token?: string }; error?: string };
      if (session?.state === "failed" || session?.state === "stopped") {
        throw errors.unavailable(session.error ?? `The cloud phone session ended (${session.state}).`);
      }
      control = session?.control;
    }
    if (!control?.url || !control.token) {
      throw errors.unavailable("The cloud phone did not become ready in time.");
    }
    this.session = {
      id,
      control: { url: control.url, token: control.token },
      expiresAt: Date.now() + 12 * 60_000,
    };
    return this.session;
  }

  async send(
    op: PhoneOp,
    kw: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const session = await this.control(signal);
    const body = (await requestJson(
      `${session.control.url.replace(/\/$/, "")}/op`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.control.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ op, kw }),
      },
      30_000,
      signal,
    )) as { result?: unknown };
    return body?.result ?? body;
  }

  async screenshot(signal?: AbortSignal): Promise<PhoneShot> {
    return shotFrom(await this.send("screen.capture", {}, signal));
  }
}

/* ------------------------------------------------------------------- bridge */

export class BridgePhone implements PhoneTransport {
  readonly kind = "bridge" as const;
  readonly label = "Your phone (bridge)";

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, "content-type": "application/json" };
  }

  async status(): Promise<PhoneStatus> {
    try {
      const body = (await requestJson(
        `${this.url.replace(/\/$/, "")}/health`,
        { headers: this.headers() },
        8_000,
      )) as { ready?: boolean; platform?: string; detail?: string; ops?: string[] };
      return {
        kind: this.kind,
        label: body?.platform ? `Your ${body.platform}` : this.label,
        ready: Boolean(body?.ready),
        detail: body?.detail ?? "Bridge answered.",
        ops: Array.isArray(body?.ops) ? body.ops : undefined,
      };
    } catch (error) {
      return {
        kind: this.kind,
        label: this.label,
        ready: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async send(
    op: PhoneOp,
    kw: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const body = (await requestJson(
      `${this.url.replace(/\/$/, "")}/op`,
      { method: "POST", headers: this.headers(), body: JSON.stringify({ op, kw }) },
      45_000,
      signal,
    )) as { result?: unknown };
    return body?.result ?? body;
  }

  async screenshot(signal?: AbortSignal): Promise<PhoneShot> {
    return shotFrom(await this.send("screen.capture", {}, signal));
  }
}

/** The bridge wins when both are configured: it is the user's own phone. */
export function createPhone(config: Config): PhoneTransport | null {
  const bridgeUrl = config.phoneBridgeUrl ?? process.env.PHONE_BRIDGE_URL;
  const bridgeToken = config.phoneBridgeToken ?? process.env.PHONE_BRIDGE_TOKEN;
  if (bridgeUrl && bridgeToken) return new BridgePhone(bridgeUrl, bridgeToken);
  if (config.phoneHarnessApiKey) {
    return new CloudPhone(
      config.phoneHarnessApiKey,
      config.phoneCloudApi ?? CLOUD_API,
      config.phoneDefaultDevice ?? undefined,
    );
  }
  return null;
}
