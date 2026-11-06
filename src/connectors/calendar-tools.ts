import { z } from "zod";
import type { AgentTool } from "../intelligence/agent.js";
import type { CredentialStore } from "./store.js";
import type { GoogleCalendar, GoogleTokens } from "./google.js";

export interface CalendarToolContext {
  google: GoogleCalendar;
  store: CredentialStore;
  orgId: string;
  userId: string;
}

async function tokensFor(
  context: CalendarToolContext,
): Promise<GoogleTokens | { error: string }> {
  if (!context.google.configured) {
    return { error: "Google Calendar is not configured on this deployment." };
  }
  const tokens = await context.store.load<GoogleTokens>(context.orgId, context.userId, "google");
  if (!tokens) {
    return {
      error:
        "Google Calendar is not connected for this user. Ask them to connect it in Talisman settings.",
    };
  }
  return tokens;
}

const listSchema = z.object({
  calendarId: z.string().max(1024).optional(),
  timeMin: z.string().max(64).optional(),
  timeMax: z.string().max(64).optional(),
  maxResults: z.number().int().min(1).max(25).optional(),
});

const createSchema = z.object({
  summary: z.string().min(1).max(500),
  description: z.string().max(4000).optional(),
  location: z.string().max(500).optional(),
  start: z.string().max(64),
  end: z.string().max(64),
  timeZone: z.string().max(64).optional(),
  attendees: z.array(z.string().max(320)).max(50).optional(),
});

/**
 * Calendar tools for the chat agent. Reads run directly; creating an event is a
 * side effect on the user's calendar, so it requires an explicit approval.
 */
export function calendarTools(context: CalendarToolContext): AgentTool[] {
  return [
    {
      definition: {
        name: "calendar_list_events",
        description:
          "List upcoming events from the user's connected Google Calendar. Use before answering questions about their schedule.",
        parameters: {
          type: "object",
          properties: {
            calendarId: { type: "string", description: "Calendar id; defaults to primary" },
            timeMin: { type: "string", description: "ISO date-time lower bound" },
            timeMax: { type: "string", description: "ISO date-time upper bound" },
            maxResults: { type: "number", description: "1-25, default 10" },
          },
        },
      },
      execute: async (args) => {
        const parsed = listSchema.safeParse(args);
        if (!parsed.success) return { error: "Invalid calendar query" };
        const tokens = await tokensFor(context);
        if ("error" in tokens) return tokens;
        const { result, tokens: current } = await context.google.call(tokens, (token) =>
          context.google.listEvents(token, parsed.data),
        );
        if (current !== tokens) {
          await context.store.save(context.orgId, context.userId, "google", current);
        }
        return { events: result, count: result.length };
      },
    },
    {
      definition: {
        name: "calendar_create_event",
        description:
          "Create an event in the user's Google Calendar. Requires the user's approval before it runs.",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string" },
            description: { type: "string" },
            location: { type: "string" },
            start: { type: "string", description: "ISO date-time with offset, e.g. 2026-05-01T09:00:00Z" },
            end: { type: "string", description: "ISO date-time with offset, after start" },
            timeZone: { type: "string", description: "Optional IANA timezone" },
            attendees: { type: "array", items: { type: "string" } },
          },
          required: ["summary", "start", "end"],
        },
      },
      requiresApproval: true,
      execute: async (args) => {
        const parsed = createSchema.safeParse(args);
        if (!parsed.success) return { error: "Invalid event", issues: parsed.error.issues };
        const tokens = await tokensFor(context);
        if ("error" in tokens) return tokens;
        const { result, tokens: current } = await context.google.call(tokens, (token) =>
          context.google.createEvent(token, parsed.data),
        );
        if (current !== tokens) {
          await context.store.save(context.orgId, context.userId, "google", current);
        }
        return { event: result };
      },
    },
  ];
}
