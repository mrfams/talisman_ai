import type { AgentTool } from "../intelligence/agent.js";
import type { PhoneTransport } from "./phone.js";

export interface PhoneApprovalRequest {
  op: "act" | "flow";
  args: Record<string, unknown>;
}

export interface PhoneApprovalRequestResult {
  approvalId: string;
  summary: string;
  expiresAt: string;
  /** Human-readable preview of a multi-step plan. */
  plan?: string[];
}

type Ask = (input: PhoneApprovalRequest) => Promise<PhoneApprovalRequestResult>;

/**
 * Agent tools over phone ops. Reads are direct. Anything that changes the phone,
 * including navigation and opening an app, becomes a durable approval request:
 * the tool returns immediately with an approval card, and the command is only
 * queued after the owner decides. This is why the tools do not set
 * `requiresApproval` themselves: the approval is the tool's output, not a gate
 * that blocks it.
 */
export function phoneTools({
  phone,
  requestApproval,
}: {
  phone: PhoneTransport | null;
  requestApproval?: Ask;
}): AgentTool[] {
  if (!phone) return [];

  const ask: Ask = async (input) => {
    if (!requestApproval) {
      throw new Error("Phone actions need an approval channel, and none is configured.");
    }
    return requestApproval(input);
  };

  const approval = async (op: "act" | "flow", args: Record<string, unknown>) => {
    const requested = await ask({ op, args });
    return {
      status: "approval_required" as const,
      approval_id: requested.approvalId,
      summary: requested.summary,
      expires_at: requested.expiresAt,
      plan: requested.plan ?? null,
      message:
        "No action has run yet. The user must approve the card on screen; do not claim it happened.",
    };
  };

  const textBoxes = async (signal: AbortSignal) => {
    const result = await phone.send("screen.text", {}, signal);
    const boxes = Array.isArray(result)
      ? result
      : result && typeof result === "object" && Array.isArray((result as { boxes?: unknown[] }).boxes)
        ? (result as { boxes: unknown[] }).boxes
        : [];
    return boxes
      .map((box) => (box && typeof box === "object" ? (box as Record<string, unknown>) : null))
      .filter((box): box is Record<string, unknown> => Boolean(box));
  };

  return [
    {
      definition: {
        name: "phone_look",
        description:
          "Read the connected phone's screen: visible text with its position, plus what app is in front. Use before tapping anything.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      execute: async (_args, context) => {
        const boxes = await textBoxes(context.signal);
        const front = await phone
          .send("apps.current", {}, context.signal)
          .catch(() => null);
        return {
          app: front ?? null,
          boxes: boxes.slice(0, 80),
          count: boxes.length,
        };
      },
    },
    {
      definition: {
        name: "phone_tap_text",
        description:
          "Tap visible text on the phone screen. Finds the element by its label, so no coordinates are guessed. Creates an approval card; the tap runs only after the user approves it.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Visible label to tap" },
            index: { type: "number", description: "Which match to tap, starting at 0" },
          },
          required: ["text"],
        },
      },
      execute: async (args, context) => {
        const query = String(args.text ?? "").trim();
        if (!query) return { error: "text is required" };
        const boxes = await textBoxes(context.signal);
        const matches = boxes.filter((box) =>
          String(box.text ?? "")
            .toLowerCase()
            .includes(query.toLowerCase()),
        );
        const index = Math.max(0, Math.trunc(Number(args.index ?? 0)));
        const target = matches[index];
        if (!target) return { error: `No visible text matching “${query}”`, count: matches.length };
        const x = Number(target.x ?? 0) + Number(target.w ?? 0) / 2;
        const y = Number(target.y ?? 0) + Number(target.h ?? 0) / 2;
        return approval("act", {
          action: "tap",
          x: Math.round(x),
          y: Math.round(y),
        });
      },
    },
    {
      definition: {
        name: "phone_type",
        description:
          "Type into the focused field on the phone. Creates an approval card and must never be used for a password or one-time code.",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      execute: async (args) => {
        const text = String(args.text ?? "");
        if (!text) return { error: "text is required" };
        return approval("act", { action: "type", text });
      },
    },
    {
      definition: {
        name: "phone_scroll",
        description:
          "Scroll the current app screen up or down. Use this to find a contact, message, or button that is off screen. Creates an approval card.",
        parameters: {
          type: "object",
          properties: {
            direction: {
              type: "string",
              enum: ["up", "down"],
              description: "Direction to scroll; defaults to down",
            },
          },
        },
      },
      execute: async (args) => {
        const direction = String(args.direction ?? "down").toLowerCase() === "up" ? "up" : "down";
        return approval("act", { action: "scroll", direction });
      },
    },
    {
      definition: {
        name: "phone_back",
        description:
          "Press the Android back button. Use this to leave a search or a conversation. Creates an approval card.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      execute: async () => approval("act", { action: "global", name: "back" }),
    },
    {
      definition: {
        name: "phone_open_app",
        description:
          "Open an app on the phone by name, for example “Messages” or “Maps”. Creates an approval card; the app opens only after the user approves it.",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      execute: async (args, context) => {
        const name = String(args.name ?? "").trim();
        if (!name) return { error: "name is required" };
        if (name.includes(".")) return approval("act", { action: "launch", package: name });

        const apps = phone.listApps ? await phone.listApps(context.signal) : [];
        const wanted = name.toLowerCase();
        const match = apps.find(
          (app) =>
            app.label.toLowerCase() === wanted ||
            app.label.toLowerCase().includes(wanted) ||
            app.package.toLowerCase() === wanted,
        );
        if (!match) return { error: `No app named “${name}” is visible on the phone` };
        return approval("act", { action: "launch", package: match.package });
      },
    },
    {
      definition: {
        name: "phone_home",
        description:
          "Go to the phone's home screen. Creates an approval card because it changes what is on screen.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      execute: async () => approval("act", { action: "global", name: "home" }),
    },
    {
      definition: {
        name: "phone_plan",
        description:
          "Run a short sequence of taps on the phone under one approval. Call phone_look first. Each step can wait for visible text before tapping; if that text never appears, the flow stops instead of tapping blind. Use this for a known path such as opening a conversation and pressing a control. The user approves the whole exact plan once.",
        parameters: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              minItems: 1,
              maxItems: 6,
              items: {
                type: "object",
                properties: {
                  wait_for: {
                    type: "object",
                    properties: {
                      text: { type: "string", description: "Visible text to wait for" },
                      timeout_ms: { type: "number", description: "Up to 15000; defaults to 8000" },
                    },
                    required: ["text"],
                  },
                  then: {
                    type: "object",
                    description:
                      "The action to run after the wait: tap_text, tap, global back/home, or none.",
                    properties: {
                      action: { type: "string", enum: ["tap_text", "tap", "global", "none"] },
                      text: { type: "string" },
                      x: { type: "number" },
                      y: { type: "number" },
                      name: { type: "string", enum: ["back", "home"] },
                    },
                    required: ["action"],
                  },
                  optional: { type: "boolean" },
                },
                required: ["then"],
              },
            },
          },
          required: ["steps"],
        },
      },
      execute: async (args) => {
        const raw = Array.isArray(args.steps) ? args.steps : [];
        if (raw.length === 0) return { error: "steps is required" };
        if (raw.length > 6) return { error: "A phone plan can have at most 6 steps" };
        const steps: Array<Record<string, unknown>> = [];
        const preview: string[] = [];
        for (const entry of raw.slice(0, 6)) {
          if (!entry || typeof entry !== "object") return { error: "Each step must be an object" };
          const step = entry as Record<string, unknown>;
          const then = step.then;
          if (!then || typeof then !== "object") return { error: "Each step needs a then action" };
          const action = String((then as Record<string, unknown>).action ?? "");
          const source = then as Record<string, unknown>;
          const wait =
            step.wait_for && typeof step.wait_for === "object"
              ? (step.wait_for as Record<string, unknown>)
              : null;
          const normalizedWait = wait
            ? {
                text: String(wait.text ?? "").trim().slice(0, 120),
                timeout_ms: Math.min(15_000, Math.max(1_000, Number(wait.timeout_ms ?? 8_000))),
              }
            : null;
          if (normalizedWait && !normalizedWait.text) return { error: "wait_for.text is required" };
          if (!normalizedWait && action !== "none") {
            return {
              error:
                "Every plan step needs wait_for text so a changed screen stops the flow instead of tapping blind",
            };
          }

          let normalizedThen: Record<string, unknown>;
          if (action === "tap_text") {
            const text = String(source.text ?? "").trim().slice(0, 120);
            if (!text) return { error: "tap_text needs text" };
            normalizedThen = { action, text };
          } else if (action === "tap") {
            const x = Number(source.x);
            const y = Number(source.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: "tap needs x and y" };
            normalizedThen = { action, x: Math.round(x), y: Math.round(y) };
          } else if (action === "global") {
            const name = String(source.name ?? "").toLowerCase();
            if (name !== "back" && name !== "home") return { error: "global must be back or home" };
            normalizedThen = { action, name };
          } else if (action === "none") {
            normalizedThen = { action };
          } else {
            return { error: `Unsupported plan action: ${action || "missing"}` };
          }

          const normalized: Record<string, unknown> = { then: normalizedThen };
          if (normalizedWait) normalized.wait_for = normalizedWait;
          if (step.optional === true) normalized.optional = true;
          steps.push(normalized);
          preview.push(
            `${normalizedWait ? `wait for “${normalizedWait.text}” then ` : ""}${
              action === "tap_text"
                ? `tap “${String(normalizedThen.text)}”`
                : action === "tap"
                  ? `tap (${String(normalizedThen.x)}, ${String(normalizedThen.y)})`
                  : action === "global"
                    ? `press ${String(normalizedThen.name)}`
                    : "continue"
            }`,
          );
        }
        const result = await approval("flow", { steps });
        return { ...result, plan: preview };
      },
    },
  ];
}
