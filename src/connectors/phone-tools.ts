import type { AgentTool } from "../intelligence/agent.js";
import type { PhoneTransport } from "./phone.js";

/**
 * Agent tools over phone ops. Anything that can send, submit, pay or delete is
 * marked `requiresApproval`; the agent run denies those unless a decision was
 * granted. Reads never ask.
 */
export function phoneTools({ phone }: { phone: PhoneTransport | null }): AgentTool[] {
  if (!phone) return [];

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
          "Tap visible text on the phone screen. Finds the element by its label, so no coordinates are guessed. Asks for approval because a tap can send or submit.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Visible label to tap" },
            index: { type: "number", description: "Which match to tap, starting at 0" },
          },
          required: ["text"],
        },
      },
      requiresApproval: true,
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
        await phone.send("input.tap", { x: Math.round(x), y: Math.round(y) }, context.signal);
        return { tapped: query, at: { x: Math.round(x), y: Math.round(y) } };
      },
    },
    {
      definition: {
        name: "phone_type",
        description:
          "Type into the focused field on the phone. Asks for approval, and must never be used for a password or one-time code.",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      requiresApproval: true,
      execute: async (args, context) => {
        const text = String(args.text ?? "");
        if (!text) return { error: "text is required" };
        await phone.send("input.text", { text }, context.signal);
        return { typed: text.length };
      },
    },
    {
      definition: {
        name: "phone_open_app",
        description: "Open an app on the phone by name, for example “Messages” or “Maps”.",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      requiresApproval: true,
      execute: async (args, context) => {
        const name = String(args.name ?? "").trim();
        if (!name) return { error: "name is required" };
        const launched = await phone.send("apps.launch", { name }, context.signal);
        return { launched: launched ?? name };
      },
    },
    {
      definition: {
        name: "phone_home",
        description: "Go to the phone's home screen.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      execute: async (_args, context) => {
        await phone.send("nav.home", {}, context.signal);
        return { ok: true };
      },
    },
  ];
}
