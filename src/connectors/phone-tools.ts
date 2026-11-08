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
  ];
}
