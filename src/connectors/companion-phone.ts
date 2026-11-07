import { errors } from "../core/errors.js";
import type { PhoneDevice } from "../db/phone-repos.js";
import type { PhoneService } from "../phone/service.js";
import type { PhoneOp, PhoneShot, PhoneStatus, PhoneTransport } from "./phone.js";

/**
 * The phone-hosted transport. It translates the legacy harness vocabulary into
 * the companion's observe/act ops, so the agent tools and UI keep one interface
 * while the control plane is the outbound queue.
 */
export class CompanionPhone implements PhoneTransport {
  readonly kind = "companion" as const;
  readonly label: string;

  constructor(
    private readonly service: PhoneService,
    private readonly device: PhoneDevice,
  ) {
    this.label = device.name;
  }

  async status(): Promise<PhoneStatus> {
    const ago = this.device.lastSeenAt
      ? Math.max(0, Date.now() - new Date(this.device.lastSeenAt).getTime())
      : null;
    return {
      kind: this.kind,
      label: this.device.name,
      ready: this.device.status === "active" && ago !== null && ago < 90_000,
      detail:
        this.device.status !== "active"
          ? `Phone is ${this.device.status}`
          : ago === null
            ? "Waiting for the companion to check in"
            : ago < 5_000
              ? `Connected · ${this.device.platform}`
              : `Last seen ${Math.floor(ago / 1000)}s ago`,
      ops: ["observe", "act", "flow", "apps", "status"],
    };
  }

  private observe(include: "interactive" | "all" = "all", screenshot = false) {
    return this.service.execute(this.device, "observe", { include, screenshot });
  }

  async send(
    op: PhoneOp,
    kw: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw errors.unavailable("The phone request was cancelled");

    switch (op) {
      case "screen.text": {
        const result = (await this.observe("all")) as {
          screen?: { nodes?: Array<Record<string, unknown>> };
        };
        return (result.screen?.nodes ?? []).map((node) => {
          const bounds = (node.bounds ?? {}) as Record<string, unknown>;
          return {
            text: String(node.text ?? node.desc ?? ""),
            x: Number(bounds.x ?? 0),
            y: Number(bounds.y ?? 0),
            w: Number(bounds.w ?? 0),
            h: Number(bounds.h ?? 0),
            ref: node.ref,
          };
        });
      }
      case "screen.capture": {
        const result = (await this.observe("all", true)) as {
          screenshot?: { base64?: string; mime?: string };
          width?: number;
          height?: number;
        };
        if (!result.screenshot?.base64) throw errors.unavailable("The phone returned no image");
        return {
          png_b64: result.screenshot.base64,
          mime: result.screenshot.mime ?? "image/jpeg",
          bounds: { w: result.width ?? 0, h: result.height ?? 0 },
        };
      }
      case "screen.bounds": {
        const result = (await this.observe("interactive")) as { width?: number; height?: number };
        return { w: result.width ?? 0, h: result.height ?? 0 };
      }
      case "apps.current": {
        const result = (await this.observe("interactive")) as {
          screen?: { package?: string };
        };
        return result.screen?.package ?? null;
      }
      case "input.tap":
        return this.service.execute(this.device, "act", {
          action: "tap",
          x: Number(kw.x ?? 0),
          y: Number(kw.y ?? 0),
        });
      case "input.text":
        return this.service.execute(this.device, "act", {
          action: "type",
          text: String(kw.text ?? ""),
        });
      case "input.scroll":
        return this.service.execute(this.device, "act", {
          action: "scroll",
          direction: String(kw.direction ?? "down"),
        });
      case "input.drag":
        return this.service.execute(this.device, "act", {
          action: "swipe",
          x1: Number(kw.x1 ?? 0),
          y1: Number(kw.y1 ?? 0),
          x2: Number(kw.x2 ?? 0),
          y2: Number(kw.y2 ?? 0),
        });
      case "nav.home":
        return this.service.execute(this.device, "act", { action: "global", name: "home" });
      case "nav.back":
        return this.service.execute(this.device, "act", { action: "global", name: "back" });
      case "apps.launch":
        return this.launch(String(kw.name ?? ""));
      case "url.open":
        return this.service.execute(this.device, "act", {
          action: "deep_link",
          uri: String(kw.url ?? ""),
        });
      case "session.state":
        return this.service.execute(this.device, "status", {});
      default:
        throw errors.invalid(`The companion does not implement ${op}`);
    }
  }

  private async launch(name: string): Promise<unknown> {
    if (!name.trim()) throw errors.invalid("An app name or package is required");
    if (name.includes(".")) {
      return this.service.execute(this.device, "act", { action: "launch", package: name });
    }
    const apps = (await this.service.execute(this.device, "apps", {})) as {
      apps?: Array<{ package?: string; label?: string }>;
    };
    const wanted = name.trim().toLowerCase();
    const match = (apps.apps ?? []).find(
      (app) =>
        String(app.label ?? "").toLowerCase() === wanted ||
        String(app.label ?? "").toLowerCase().includes(wanted) ||
        String(app.package ?? "").toLowerCase() === wanted,
    );
    if (!match?.package) throw errors.notFound(`No app named “${name}” is visible on the phone`);
    return this.service.execute(this.device, "act", {
      action: "launch",
      package: match.package,
    });
  }

  async screenshot(signal?: AbortSignal): Promise<PhoneShot> {
    const shot = (await this.send("screen.capture", {}, signal)) as {
      png_b64: string;
      mime?: string;
      bounds?: unknown;
    };
    return {
      pngBase64: shot.png_b64,
      mime: shot.mime,
      bounds: shot.bounds,
    };
  }
}

/** Kept out of the class so the legacy factory can stay untouched. */
export function companionFor(
  service: PhoneService,
  device: PhoneDevice | null,
): CompanionPhone | null {
  return device ? new CompanionPhone(service, device) : null;
}
