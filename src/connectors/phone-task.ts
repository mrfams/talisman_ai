import type { AgentTool } from "../intelligence/agent.js";
import type { PhoneDevice } from "../db/phone-repos.js";
import type { PhoneService, PublicPhoneApproval } from "../phone/service.js";

export interface PhoneTaskDeps {
  service: PhoneService;
  device: PhoneDevice;
  orgId: string;
  userId: string;
  onApprovalRequested?: (approval: PublicPhoneApproval) => Promise<void>;
  onAction?: (input: {
    taskId: string;
    action: string;
    args: Record<string, unknown>;
  }) => Promise<void>;
}

interface ScreenElement {
  ref?: unknown;
  text?: string;
  desc?: string;
  className?: string;
  clickable?: boolean;
  editable?: boolean;
  bounds?: unknown;
}

interface ScreenView {
  app: string;
  width: number;
  height: number;
  elements: ScreenElement[];
}

interface ChecklistItem {
  title: string;
  status: "pending" | "done" | "failed" | "skipped";
}

const MAX_ACTIONS = 30;
const DEFAULT_ACTIONS = 20;
const DEFAULT_WAIT_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function screenView(result: unknown): ScreenView {
  const record = (result ?? {}) as {
    screen?: { package?: string; nodes?: Array<Record<string, unknown>> };
    width?: unknown;
    height?: unknown;
  };
  const nodes = Array.isArray(record.screen?.nodes) ? record.screen!.nodes : [];
  return {
    app: String(record.screen?.package ?? "unknown"),
    width: Number(record.width ?? 0),
    height: Number(record.height ?? 0),
    elements: nodes.slice(0, 80).map((node) => {
      const bounds = node.bounds as Record<string, unknown> | undefined;
      return {
        ref: node.ref,
        text: String(node.text ?? "").slice(0, 200) || undefined,
        desc: String(node.desc ?? "").slice(0, 200) || undefined,
        className: String(node.class ?? "") || undefined,
        clickable: node.clickable === true,
        editable: node.editable === true,
        bounds: bounds
          ? {
              x: Number(bounds.x ?? 0),
              y: Number(bounds.y ?? 0),
              w: Number(bounds.w ?? 0),
              h: Number(bounds.h ?? 0),
            }
          : undefined,
      };
    }),
  };
}

function matches(element: ScreenElement, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return false;
  return [element.text, element.desc]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(wanted));
}

function findElement(screen: ScreenView, query: string, index = 0): ScreenElement | null {
  return screen.elements.filter((element) => matches(element, query))[index] ?? null;
}

function checklist(input: unknown): ChecklistItem[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 20).map((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const status = String(record.status ?? "pending");
    return {
      title: String(record.title ?? "Step").slice(0, 160),
      status:
        status === "done" || status === "failed" || status === "skipped"
          ? status
          : "pending",
    };
  });
}

/**
 * The autonomous phone loop.
 *
 * The owner approves a goal, not a guessed script. The model then has to look
 * at the live screen before every decision, take one action, look again, and
 * keep its own checklist. Nothing here knows any specific app; the labels and
 * refs come from the device.
 */
export function phoneTaskTools({
  service,
  device,
  orgId,
  userId,
  onApprovalRequested,
  onAction,
}: PhoneTaskDeps): AgentTool[] {
  const activeTask = async (): Promise<PublicPhoneApproval> => {
    const task = await service.activeTask(orgId, userId, device.id);
    if (!task) {
      throw new Error("No approved phone task is active. Start one with phone_task_start.");
    }
    return task;
  };

  const observe = async (): Promise<ScreenView> =>
    screenView(await service.execute(device, "observe", {}));

  const resolvePackage = async (input: { app?: unknown; package?: unknown }): Promise<string> => {
    const raw = String(input.package ?? input.app ?? "").trim();
    if (!raw) throw new Error("launch needs an app name or package");
    if (raw.includes(".")) return raw;
    const result = (await service.execute(device, "apps", {})) as {
      apps?: Array<{ package?: string; label?: string }>;
    };
    const wanted = raw.toLowerCase();
    const match = (result.apps ?? []).find(
      (app) =>
        String(app.label ?? "").toLowerCase() === wanted ||
        String(app.label ?? "").toLowerCase().includes(wanted) ||
        String(app.package ?? "").toLowerCase() === wanted,
    );
    if (!match?.package) throw new Error(`No app named “${raw}” is visible on the phone`);
    return match.package;
  };

  const waitForExpectation = async (
    query: string,
    timeoutMs: number,
  ): Promise<{ verified: boolean; screen: ScreenView }> => {
    const deadline = Date.now() + Math.max(500, Math.min(timeoutMs, 10_000));
    let screen = await observe();
    while (Date.now() < deadline) {
      if (findElement(screen, query)) return { verified: true, screen };
      await sleep(400);
      screen = await observe();
    }
    return { verified: Boolean(findElement(screen, query)), screen };
  };

  const start: AgentTool = {
    definition: {
      name: "phone_task_start",
      description:
        "Start an autonomous phone task. Use this for any phone request that needs more than one action. Pass the outcome the owner asked for, not a step-by-step script. The owner approves the goal once; after approval you will inspect the live screen and choose each action yourself. Never include passwords, PINs or one-time codes in the goal.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description:
              "The outcome, in the owner's words. Include who/what/which app only as needed; do not precompute taps.",
          },
          max_steps: {
            type: "number",
            description: `Safety cap on actions, default ${DEFAULT_ACTIONS}, maximum ${MAX_ACTIONS}.`,
          },
        },
        required: ["goal"],
      },
    },
    execute: async (args, context) => {
      const goal = String(args.goal ?? "").trim().slice(0, 1_000);
      if (goal.length < 3) return { error: "goal is required" };
      const existing = await service.activeTask(orgId, userId, device.id);
      if (existing) {
        return {
          error: "This phone already has an approved task. Continue it instead of starting another.",
          task_id: existing.id,
          goal: String(existing.args.goal ?? ""),
        };
      }
      const maxSteps = Number(args.max_steps ?? DEFAULT_ACTIONS);
      const approval = await service.requestTask(orgId, userId, device.id, {
        goal,
        maxSteps,
      });
      await onApprovalRequested?.(approval);
      if (context.signal.aborted) throw new Error("Phone task approval was cancelled");
      return {
        status: "approval_required",
        approval_id: approval.id,
        summary: approval.summary,
        expires_at: approval.expiresAt,
        task: true,
        message:
          "No phone action has run yet. The owner approves this goal once. After approval, read the screen and take the first action.",
      };
    },
  };

  const look: AgentTool = {
    definition: {
      name: "phone_task_look",
      description:
        "Read the live phone screen during an approved task. Returns the foreground app and visible elements with refs, text, descriptions and bounds. Call this before deciding an action, and again after any action that did not return a screen.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    execute: async () => {
      const task = await activeTask();
      const screen = await observe();
      return {
        task: {
          id: task.id,
          goal: String(task.args.goal ?? ""),
          max_steps: Number(task.args.max_steps ?? DEFAULT_ACTIONS),
        },
        ...screen,
      };
    },
  };

  const act: AgentTool = {
    definition: {
      name: "phone_task_act",
      description:
        "Take exactly one action inside the approved phone task, then return the new screen. Choose the action from the live screen you just read; never guess a hardcoded app sequence. Use refs for taps. Do not type passwords, PINs or one-time codes, and do not pay, delete or send anything outside the approved goal.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["launch", "tap_ref", "tap_text", "type", "scroll", "back", "home"],
          },
          ref: { type: "number", description: "Element ref from phone_task_look for tap_ref" },
          text: {
            type: "string",
            description: "Text for tap_text or type. For type this is the exact text to enter.",
          },
          index: { type: "number", description: "Which tap_text match, starting at 0" },
          app: { type: "string", description: "App label for launch" },
          package: { type: "string", description: "Android package for launch" },
          direction: { type: "string", enum: ["up", "down"] },
          expect: {
            type: "string",
            description:
              "Optional visible text or description that should appear after the action; the tool waits and reports whether it did.",
          },
          wait_ms: {
            type: "number",
            description: "How long to wait for expect, up to 10000ms; defaults to 4000.",
          },
        },
        required: ["action"],
      },
    },
    execute: async (args) => {
      const task = await activeTask();
      const action = String(args.action ?? "");
      let command: Record<string, unknown>;
      let label = action;

      if (action === "launch") {
        const pkg = await resolvePackage({ app: args.app, package: args.package });
        command = { action: "launch", package: pkg };
        label = `open ${pkg}`;
      } else if (action === "tap_ref") {
        const ref = Math.trunc(Number(args.ref ?? 0));
        if (ref <= 0) return { error: "tap_ref needs a ref from phone_task_look" };
        command = { action: "tap_ref", ref };
        label = `tap ref ${ref}`;
      } else if (action === "tap_text") {
        const text = String(args.text ?? "").trim();
        if (!text) return { error: "tap_text needs text" };
        const screen = await observe();
        const index = Math.max(0, Math.trunc(Number(args.index ?? 0)));
        const element = findElement(screen, text, index);
        const bounds = element?.bounds as { x?: number; y?: number; w?: number; h?: number } | undefined;
        if (!element || !bounds) {
          return {
            error: `No visible text or description matching “${text}”`,
            screen,
          };
        }
        command = {
          action: "tap",
          x: Math.round(Number(bounds.x ?? 0) + Number(bounds.w ?? 0) / 2),
          y: Math.round(Number(bounds.y ?? 0) + Number(bounds.h ?? 0) / 2),
        };
        label = `tap “${text}”`;
      } else if (action === "type") {
        const text = String(args.text ?? "");
        if (!text) return { error: "type needs text" };
        if (text.length > 2_000) return { error: "type text is too long" };
        command = { action: "type", text };
        label = `type ${text.length} characters`;
      } else if (action === "scroll") {
        const direction = String(args.direction ?? "down").toLowerCase();
        if (direction !== "up" && direction !== "down") {
          return { error: "scroll needs up or down" };
        }
        command = { action: "scroll", direction };
        label = `scroll ${direction}`;
      } else if (action === "back" || action === "home") {
        command = { action: "global", name: action };
        label = `press ${action}`;
      } else {
        return { error: `Unsupported phone task action: ${action || "missing"}` };
      }

      const outcome = await service.executeApproved(device, task.id, command);
      await onAction?.({ taskId: task.id, action: label, args: command });
      if (outcome.status === "error") {
        return { error: outcome.error ?? "The phone could not complete that action", action: label };
      }
      if (outcome.status !== "done") {
        return {
          pending: true,
          status: outcome.status,
          action: label,
          message: "The phone has not confirmed this action yet. Look at the screen before doing more.",
        };
      }

      const expect = String(args.expect ?? "").trim();
      const waitMs = Number(args.wait_ms ?? DEFAULT_WAIT_MS);
      const result = expect
        ? await waitForExpectation(expect, waitMs)
        : { verified: null as boolean | null, screen: await observe() };
      return {
        ok: true,
        action: label,
        result: outcome.result,
        verified: result.verified,
        screen: result.screen,
      };
    },
  };

  const update: AgentTool = {
    definition: {
      name: "phone_task_update",
      description:
        "Maintain the todo list the owner sees while the phone task runs. Send the complete current list after each meaningful action. Keep it short (3-8 items) and mark items done only after the screen confirms them.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "One line describing the current task" },
          items: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                status: {
                  type: "string",
                  enum: ["pending", "done", "failed", "skipped"],
                },
              },
              required: ["title"],
            },
          },
        },
        required: ["items"],
      },
    },
    execute: async (args) => {
      const task = await activeTask();
      const items = checklist(args.items);
      if (items.length === 0) return { error: "items must contain at least one step" };
      return {
        ok: true,
        task_id: task.id,
        summary: String(args.summary ?? task.args.goal ?? "Phone task").slice(0, 200),
        items,
      };
    },
  };

  const done: AgentTool = {
    definition: {
      name: "phone_task_done",
      description:
        "Finish the approved phone task. Call this only after the live screen visibly confirms the owner's goal is complete. Include the final todo list and a one-line result. This closes the task and prevents further actions under its approval.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "What was accomplished, in one line" },
          items: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                status: {
                  type: "string",
                  enum: ["pending", "done", "failed", "skipped"],
                },
              },
              required: ["title"],
            },
          },
        },
        required: ["summary"],
      },
    },
    execute: async (args) => {
      const task = await activeTask();
      const summary = String(args.summary ?? "").trim().slice(0, 500);
      if (!summary) return { error: "summary is required" };
      const items = checklist(args.items);
      await service.completeTask(orgId, userId, task.id);
      return {
        status: "complete",
        task_id: task.id,
        summary,
        items,
      };
    },
  };

  return [start, look, act, update, done];
}
