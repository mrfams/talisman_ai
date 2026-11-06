import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z, ZodError } from "zod";
import type { Config } from "../core/config.js";
import { errors, TalismanError } from "../core/errors.js";
import { log } from "../core/log.js";
import type { Database, Conn } from "../db/database.js";
import {
  addMessage,
  appendEvent,
  createConversation,
  createMemory,
  createTask,
  decideApproval,
  deleteMemory,
  getApproval,
  getArtifact,
  getConversation,
  getTask,
  listApprovals,
  listApprovalsForUser,
  listArtifacts,
  listArtifactsForUser,
  listAuditEvents,
  listConversations,
  listEvents,
  listMemories,
  listMembers,
  listMessages,
  listOrgIds,
  listSteps,
  listTasks,
  recordAudit,
  updateTask,
} from "../db/repos.js";
import { planGoal } from "../runtime/planner.js";
import { isTerminal, type SessionInfo, type Task } from "../core/types.js";
import { AuthService, bearerToken } from "../auth/service.js";
import type { ArtifactStoreLike } from "../workspace/workspace.js";
import { applySchema } from "../db/migrate.js";
import { timingSafeEqual } from "node:crypto";
import type { TaskEngine } from "../runtime/engine.js";
import { SecretBox } from "../security/secrets.js";
import { CredentialStore } from "../connectors/store.js";
import { GoogleCalendar, type GoogleTokens } from "../connectors/google.js";
import { signState, verifyState } from "../connectors/oauth-state.js";
import { calendarTools } from "../connectors/calendar-tools.js";
import { createPhone, isPhoneOp, PHONE_OPS } from "../connectors/phone.js";
import { phoneTools } from "../connectors/phone-tools.js";
import type { ModelRouter } from "../intelligence/router.js";
import { Agent, type AgentTool } from "../intelligence/agent.js";
import type { ChatMessage } from "../intelligence/types.js";
import { buildContext, selectMemories } from "../intelligence/context.js";

export interface AppDeps {
  config: Config;
  database: Database;
  auth: AuthService;
  models: ModelRouter;
  artifactStore: ArtifactStoreLike;
  /**
   * Present when this process can execute tasks itself. On a serverless host the
   * request drives one bounded slice; without it, a separate worker must run.
   */
  engine?: TaskEngine;
  /** Injectable for tests; otherwise built from config. */
  google?: GoogleCalendar;
}

type Env = { Variables: { session: SessionInfo; token: string } };
type AppContext = Context<Env>;

const credentials = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(1024),
});

const signupBody = credentials.extend({
  name: z.string().max(120).optional(),
  orgName: z.string().max(120).optional(),
});

const taskBody = z.object({
  goal: z.string().min(3).max(20_000),
  title: z.string().max(200).optional(),
  conversationId: z.string().max(64).optional(),
  seedUrls: z.array(z.string().url()).max(10).optional(),
});

const decisionBody = z.object({ decision: z.enum(["approved", "denied"]) });

function requireUser(c: AppContext): SessionInfo {
  return c.get("session");
}

function taskForUser(deps: AppDeps, c: AppContext, taskId: string): Promise<Task | null> {
  const session = requireUser(c);
  return deps.database.withTenant(session.user.orgId, session.user.id, async (conn) => {
    const task = await getTask(conn, taskId);
    return task && task.userId === session.user.id ? task : null;
  });
}

function param(c: AppContext, name: string): string {
  const value = c.req.param(name);
  if (!value) throw errors.invalid(`Missing ${name}`);
  return value;
}

function audit(
  deps: AppDeps,
  session: SessionInfo,
  eventType: string,
  targetType: string,
  targetId: string,
  payload?: unknown,
): Promise<void> {
  return deps.database.withTenant(session.user.orgId, session.user.id, (conn) =>
    recordAudit(conn, {
      orgId: session.user.orgId,
      actorUserId: session.user.id,
      eventType,
      targetType,
      targetId,
      payload,
    }),
  );
}

function startSession(c: AppContext, deps: AppDeps, token: string): void {
  setCookie(c, "talisman_session", token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: deps.config.production,
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
}

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const credentialStore = new CredentialStore(
    deps.database,
    SecretBox.from(deps.config.credentialKey),
  );
  const google =
    deps.google ??
    new GoogleCalendar({
      clientId: deps.config.googleClientId,
      clientSecret: deps.config.googleClientSecret,
    });
  const phone = createPhone(deps.config);

  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof TalismanError) {
      return c.json({ error: error.message, code: error.code }, error.status as 400);
    }
    if (error instanceof ZodError) {
      return c.json({ error: "Invalid request", code: "invalid", issues: error.issues }, 422);
    }
    if (error instanceof SyntaxError) {
      return c.json({ error: "Invalid JSON body", code: "invalid" }, 400);
    }
    log.error("unhandled request error", {
      path: c.req.path,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Internal server error", code: "internal" }, 500);
  });

  const publicPaths = new Set([
    "/api/health",
    "/api/auth/signup",
    "/api/auth/login",
    // Machine endpoints: authenticated by CRON_SECRET, not by a user session.
    "/api/internal/tick",
    "/api/internal/migrate",
    // OAuth redirect from Google: authenticated by the signed state, not a cookie.
    "/api/connectors/google/callback",
  ]);

  app.use("/api/*", async (c, next) => {
    if (publicPaths.has(c.req.path)) return next();
    const header = c.req.header("authorization");
    const bearer = bearerToken(header);
    const cookie = getCookie(c, "talisman_session");
    const token = bearer ?? cookie;
    const session = await deps.auth.authenticate(token);
    if (!session) throw errors.unauthorized();
    // Cookie-authenticated mutations must come from the same origin.
    if (!bearer && cookie && !["GET", "HEAD"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin) {
        // Compare with the host that actually served this request: preview
        // deployments and custom domains never match a fixed PUBLIC_URL.
        const expectedHost =
          c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(deps.config.publicUrl).host;
        let originHost: string | null = null;
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = null;
        }
        if (!originHost || originHost !== expectedHost) {
          throw errors.forbidden("Cross-origin request refused");
        }
      }
    }
    c.set("session", session);
    c.set("token", token!);
    return next();
  });

  app.get("/api/health", async (c) => {
    let database = "ok";
    let schema = "ok";
    try {
      await deps.database.query("SELECT 1");
    } catch {
      database = "unreachable";
    }
    if (database === "ok") {
      try {
        const { rows } = await deps.database.query<{ present: string | null }>(
          "SELECT to_regclass('public.tasks')::text AS present",
        );
        schema = rows[0]?.present ? "ok" : "missing";
      } catch {
        schema = "unknown";
      }
    }
    return c.json({
      ok: database === "ok" && schema === "ok",
      service: "talisman",
      version: "0.2.0",
      runtime: deps.config.serverless ? "serverless" : "node",
      database,
      schema,
      capabilities: {
        models: deps.models.candidates().length > 0,
        defaultModel: deps.config.defaultModel,
        search: deps.config.searchUrl ? deps.config.searchProvider : null,
        browser: deps.config.browserMode,
        artifacts: deps.config.artifactStore,
        executor: deps.engine ? "embedded" : "external-worker",
      },
    });
  });

  app.post("/api/auth/signup", async (c) => {
    const body = signupBody.parse(await c.req.json());
    const result = await deps.auth.signup({
      email: body.email,
      password: body.password,
      name: body.name,
      orgName: body.orgName ?? "",
    });
    startSession(c, deps, result.token);
    return c.json({ user: result.session.user, expiresAt: result.session.expiresAt }, 201);
  });

  app.post("/api/auth/login", async (c) => {
    const body = credentials.parse(await c.req.json());
    const result = await deps.auth.login(body.email, body.password);
    startSession(c, deps, result.token);
    return c.json({ user: result.session.user, expiresAt: result.session.expiresAt });
  });

  app.post("/api/auth/logout", async (c) => {
    await deps.auth.logout(c.get("token"));
    deleteCookie(c, "talisman_session", { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/me", (c) => c.json({ user: requireUser(c).user }));

  /* ------------------------------------------------------------ libraries */

  app.get("/api/artifacts", async (c) => {
    const { user } = requireUser(c);
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 200);
    const artifacts = await deps.database.withTenant(user.orgId, user.id, (conn) =>
      listArtifactsForUser(conn, user.id, limit),
    );
    return c.json({ artifacts });
  });

  app.get("/api/approvals", async (c) => {
    const { user } = requireUser(c);
    const status = c.req.query("status") ?? "pending";
    if (!["pending", "approved", "denied", "expired", "all"].includes(status)) {
      throw errors.invalid("Unknown approval status");
    }
    const approvals = await deps.database.withTenant(user.orgId, user.id, (conn) =>
      listApprovalsForUser(conn, user.id, status as "pending", 100),
    );
    return c.json({ approvals });
  });

  app.get("/api/activity", async (c) => {
    const { user } = requireUser(c);
    if (user.role === "member") throw errors.forbidden("Only owners and admins can read the audit log");
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 200);
    const events = await deps.database.withTenant(user.orgId, user.id, (conn) =>
      listAuditEvents(conn, user.orgId, limit),
    );
    return c.json({ events });
  });

  app.get("/api/team", async (c) => {
    const { user } = requireUser(c);
    const members = await deps.database.withTenant(user.orgId, user.id, (conn) =>
      listMembers(conn, user.orgId),
    );
    return c.json({ members });
  });

  /* ---------------------------------------------------------------- devices */

  app.get("/api/devices", async (c) => {
    requireUser(c);
    if (!phone) {
      return c.json({
        configured: false,
        devices: [],
        ops: PHONE_OPS,
        hint: "Set PHONE_HARNESS_API_KEY, or PHONE_BRIDGE_URL and PHONE_BRIDGE_TOKEN.",
      });
    }
    const status = await phone.status();
    return c.json({ configured: true, devices: [status], ops: PHONE_OPS });
  });

  app.post("/api/devices/op", async (c) => {
    requireUser(c);
    if (!phone) throw errors.unavailable("No phone is configured for this deployment.");
    const body = z
      .object({
        op: z.string(),
        kw: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(await c.req.json());
    if (!isPhoneOp(body.op)) throw errors.invalid(`Unsupported phone op: ${body.op}`);
    const result = await phone.send(body.op, body.kw, c.req.raw.signal);
    if (body.op === "screen.capture") {
      const box =
        result && typeof result === "object" && "result" in result
          ? (result as { result: unknown }).result
          : result;
      const record = (box ?? {}) as Record<string, unknown>;
      return c.json({ png_b64: record.png_b64 ?? record.png ?? null, bounds: record.bounds ?? null });
    }
    return c.json({ result });
  });

  /* ------------------------------------------------------- conversations */

  app.get("/api/conversations", async (c) => {
    const { user } = requireUser(c);
    const items = await deps.database.withTenant(user.orgId, user.id, (conn) =>
      listConversations(conn, user.orgId, user.id),
    );
    return c.json({ conversations: items });
  });

  app.post("/api/conversations", async (c) => {
    const body = z
      .object({ title: z.string().min(1).max(200).default("New conversation") })
      .parse(await c.req.json().catch(() => ({})));
    const { user } = requireUser(c);
    const conversation = await deps.database.withTenant(user.orgId, user.id, (conn) =>
      createConversation(conn, { orgId: user.orgId, userId: user.id, title: body.title }),
    );
    return c.json({ conversation }, 201);
  });

  app.get("/api/conversations/:id/messages", async (c) => {
    const { user } = requireUser(c);
    const id = param(c, "id");
    const messages = await deps.database.withTenant(user.orgId, user.id, async (conn) => {
      const conversation = await getConversation(conn, id, user.id);
      if (!conversation) return null;
      return listMessages(conn, id);
    });
    if (!messages) throw errors.notFound("Conversation not found");
    return c.json({ messages });
  });

  app.post("/api/conversations/:id/messages", async (c) => {
    const { user } = requireUser(c);
    const id = param(c, "id");
    const body = z.object({ content: z.string().min(1).max(20_000) }).parse(await c.req.json());

    const conversation = await deps.database.withTenant(user.orgId, user.id, (conn) =>
      getConversation(conn, id, user.id),
    );
    if (!conversation) throw errors.notFound("Conversation not found");
    if (deps.models.candidates().length === 0) {
      throw errors.unavailable("No model provider is configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.");
    }

    await deps.database.withTenant(user.orgId, user.id, async (conn) => {
      await addMessage(conn, {
        orgId: user.orgId,
        conversationId: id,
        role: "user",
        content: { text: body.content },
      });
    });

    const history = await deps.database.withTenant(user.orgId, user.id, (conn) =>
      listMessages(conn, id, 40),
    );
    const memories = await deps.database.withTenant(user.orgId, user.id, (conn) =>
      listMemories(conn, user.orgId, user.id, 100),
    );
    const chatHistory: ChatMessage[] = history.map((message) => {
      const content = message.content as { text?: string } | null;
      return {
        role: message.role,
        content: content?.text ?? (typeof message.content === "string" ? message.content : null),
      };
    });
    const messages = buildContext({
      system:
        "You are Talisman, a personal AI agent. You can create durable tasks that run in a real browser, and remember facts the user shares. Use tools when the user asks for work that should continue in the background.",
      memories: selectMemories(memories, body.content),
      history: chatHistory,
      budgetTokens: 24_000,
    });

    const tools: AgentTool[] = [
      {
        definition: {
          name: "create_task",
          description:
            "Create a durable background task. Use for research, browsing, documents, or anything multi-step.",
          parameters: {
            type: "object",
            properties: {
              goal: { type: "string", description: "What the task must accomplish" },
              seed_urls: {
                type: "array",
                items: { type: "string" },
                description: "Optional URLs to start from",
              },
            },
            required: ["goal"],
          },
        },
        execute: async (args) => {
          const goal = String(args.goal ?? "").slice(0, 20_000);
          if (goal.length < 3) return { error: "goal is required" };
          const urls = Array.isArray(args.seed_urls)
            ? args.seed_urls.filter((url): url is string => typeof url === "string")
            : [];
          const plan = planGoal(goal, { seedUrls: urls });
          const task = await deps.database.withTenant(user.orgId, user.id, (conn) =>
            createTask(conn, {
              orgId: user.orgId,
              userId: user.id,
              conversationId: id,
              title: goal.slice(0, 120),
              goal,
              plan,
            }),
          );
          await deps.database.withTenant(user.orgId, user.id, (conn) =>
            appendEvent(conn, {
              orgId: user.orgId,
              taskId: task.id,
              kind: "plan",
              title: "Plan created",
              data: plan,
            }),
          );
          return { taskId: task.id, status: task.status, steps: plan.steps.map((s) => s.title) };
        },
      },
      {
        definition: {
          name: "remember",
          description: "Store a durable fact about the user for later conversations.",
          parameters: {
            type: "object",
            properties: { content: { type: "string" }, kind: { type: "string" } },
            required: ["content"],
          },
        },
        execute: async (args) => {
          const content = String(args.content ?? "").slice(0, 4000);
          if (!content) return { error: "content is required" };
          const memory = await deps.database.withTenant(user.orgId, user.id, (conn) =>
            createMemory(conn, {
              orgId: user.orgId,
              userId: user.id,
              kind: String(args.kind ?? "fact"),
              content,
              source: "chat",
            }),
          );
          return { memoryId: memory.id };
        },
      },
      ...calendarTools({
        google,
        store: credentialStore,
        orgId: user.orgId,
        userId: user.id,
      }),
      ...phoneTools({ phone }),
    ];

    const agent = new Agent(deps.models, tools);
    return streamSSE(c, async (stream) => {
      let assistantText = "";
      try {
        const result = await agent.run({
          messages,
          maxSteps: 6,
          signal: c.req.raw.signal,
          onEvent: async (event) => {
            if (event.type === "text_delta") {
              assistantText += event.text;
              await stream.writeSSE({ event: "text", data: event.text });
            } else if (event.type === "tool_start") {
              await stream.writeSSE({
                event: "tool",
                data: JSON.stringify({ phase: "start", name: event.name, args: event.args }),
              });
            } else if (event.type === "tool_end") {
              await stream.writeSSE({
                event: "tool",
                data: JSON.stringify({ phase: "end", name: event.name, ok: event.ok }),
              });
            }
          },
        });
        if (assistantText || result.result.text) {
          await deps.database.withTenant(user.orgId, user.id, (conn) =>
            addMessage(conn, {
              orgId: user.orgId,
              conversationId: id,
              role: "assistant",
              content: { text: result.result.text || assistantText },
            }),
          );
        }
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({ steps: result.steps }),
        });
      } catch (error) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        });
      }
    });
  });

  /* --------------------------------------------------------------- tasks */

  app.get("/api/tasks", async (c) => {
    const { user } = requireUser(c);
    const tasks = await deps.database.withTenant(user.orgId, user.id, (conn) =>
      listTasks(conn, user.orgId, user.id),
    );
    return c.json({ tasks });
  });

  app.post("/api/tasks", async (c) => {
    const body = taskBody.parse(await c.req.json());
    const { user } = requireUser(c);
    const plan = planGoal(body.goal, { seedUrls: body.seedUrls ?? [] });
    const task = await deps.database.withTenant(user.orgId, user.id, async (conn) => {
      if (body.conversationId) {
        const conversation = await getConversation(conn, body.conversationId, user.id);
        if (!conversation) throw errors.notFound("Conversation not found");
      }
      const created = await createTask(conn, {
        orgId: user.orgId,
        userId: user.id,
        conversationId: body.conversationId ?? null,
        title: body.title?.trim() || body.goal.slice(0, 120),
        goal: body.goal,
        plan,
      });
      await appendEvent(conn, {
        orgId: user.orgId,
        taskId: created.id,
        kind: "plan",
        title: "Plan created",
        data: plan,
      });
      return created;
    });
    await audit(deps, requireUser(c), "task.created", "task", task.id, { steps: plan.steps.length });
    return c.json({ task }, 201);
  });

  app.get("/api/tasks/:id", async (c) => {
    const { user } = requireUser(c);
    const id = param(c, "id");
    const detail = await deps.database.withTenant(user.orgId, user.id, async (conn) => {
      const task = await getTask(conn, id);
      if (!task || task.userId !== user.id) return null;
      // Sequential on one connection: a pg client runs one query at a time, and
      // overlapping them is deprecated in pg 8 and removed in pg 9.
      const steps = await listSteps(conn, id);
      const events = await listEvents(conn, id);
      const approvals = await listApprovals(conn, id);
      const artifacts = await listArtifacts(conn, id);
      return { task, steps, events, approvals, artifacts };
    });
    if (!detail) throw errors.notFound("Task not found");
    return c.json(detail);
  });

  const transition = async (
    c: AppContext,
    action: "pause" | "resume" | "cancel" | "retry",
  ) => {
    const { user } = requireUser(c);
    const id = param(c, "id");
    const task = await deps.database.withTenant(user.orgId, user.id, async (conn) => {
      const existing = await getTask(conn, id);
      if (!existing || existing.userId !== user.id) return null;
      let patch: Record<string, unknown> = {};
      if (action === "pause") {
        if (!["queued", "running", "waiting_approval", "scheduled"].includes(existing.status)) {
          throw errors.conflict(`Cannot pause a ${existing.status} task`);
        }
        patch = { status: "paused" };
      } else if (action === "resume") {
        if (existing.status !== "paused") throw errors.conflict("Only a paused task can resume");
        patch = { status: "queued", error: null, leaseOwner: null, leaseUntil: null, attempts: 0 };
      } else if (action === "cancel") {
        if (isTerminal(existing.status)) throw errors.conflict("Task is already finished");
        patch = { status: "cancelled", finishedAt: new Date(), leaseOwner: null, leaseUntil: null };
      } else {
        if (!["failed", "cancelled"].includes(existing.status)) {
          throw errors.conflict("Only a failed or cancelled task can be retried");
        }
        patch = {
          status: "queued",
          error: null,
          progress: 0,
          result: null,
          attempts: 0,
          finishedAt: null,
          leaseOwner: null,
          leaseUntil: null,
        };
        const steps = await listSteps(conn, id);
        for (const step of steps) {
          if (step.status === "failed" || step.status === "cancelled") {
            await conn.query(
              "UPDATE task_steps SET status = 'pending', error = NULL, started_at = NULL, finished_at = NULL WHERE id = $1",
              [step.id],
            );
          }
        }
      }
      const updated = await updateTask(conn, id, patch);
      await appendEvent(conn, {
        orgId: user.orgId,
        taskId: id,
        kind: "status",
        title: action[0]!.toUpperCase() + action.slice(1),
      });
      return updated;
    });
    if (!task) throw errors.notFound("Task not found");
    await audit(deps, requireUser(c), `task.${action}`, "task", id);
    return c.json({ task });
  };

  app.post("/api/tasks/:id/pause", (c) => transition(c, "pause"));
  app.post("/api/tasks/:id/resume", (c) => transition(c, "resume"));
  app.post("/api/tasks/:id/cancel", (c) => transition(c, "cancel"));
  app.post("/api/tasks/:id/retry", (c) => transition(c, "retry"));

  app.get("/api/tasks/:id/events", async (c) => {
    const { user } = requireUser(c);
    const id = param(c, "id");
    const task = await taskForUser(deps, c, id);
    if (!task) throw errors.notFound("Task not found");
    let cursor = c.req.query("after") ?? "0";
    let closed = false;

    // Serverless clients poll a JSON snapshot instead of holding an SSE stream
    // open for the lifetime of a function invocation.
    if (c.req.query("format") === "json") {
      const snapshot = await deps.database.withTenant(user.orgId, user.id, async (conn) => {
        const events = await listEvents(conn, id, cursor);
        const current = await getTask(conn, id);
        return {
          events,
          status: current?.status ?? "failed",
          cursor: events.at(-1)?.seq ?? cursor,
        };
      });
      return c.json(snapshot);
    }

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        closed = true;
      });
      while (!closed) {
        const snapshot = await deps.database.withTenant(user.orgId, user.id, async (conn) => {
          const events = await listEvents(conn, id, cursor);
          const current = await getTask(conn, id);
          return { events, status: current?.status ?? "failed" };
        });
        for (const event of snapshot.events) {
          cursor = event.seq;
          await stream.writeSSE({ event: "task", id: event.seq, data: JSON.stringify(event) });
        }
        if (isTerminal(snapshot.status)) {
          await stream.writeSSE({
            event: "end",
            data: JSON.stringify({ status: snapshot.status }),
          });
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    });
  });

  /**
   * Runs one bounded slice of a task in this request. This is how a serverless
   * deployment executes work: each call is short, progress is committed per step,
   * and the lease hands the task to the next call when time runs out.
   */
  app.post("/api/tasks/:id/run", async (c) => {
    const { user } = requireUser(c);
    const id = param(c, "id");
    const task = await taskForUser(deps, c, id);
    if (!task) throw errors.notFound("Task not found");
    if (!deps.engine) {
      throw errors.unavailable("This deployment has no executor; run the worker process.");
    }
    const claimed = await deps.engine.claimById(user.orgId, user.id, id);
    if (!claimed) {
      const current = await taskForUser(deps, c, id);
      return c.json({
        ran: false,
        reason: "Task is already running, waiting for approval, or finished.",
        task: current,
      });
    }
    const { outcome } = await deps.engine.runClaimed(claimed, {
      budgetMs: deps.config.maxRunMs,
    });
    const current = await taskForUser(deps, c, id);
    return c.json({ ran: true, outcome, task: current });
  });

  /* ------------------------------------------------- machine endpoints */

  const cronAuthorized = (c: AppContext): boolean => {
    const expected = deps.config.cronSecret;
    // Fail closed: with no secret configured the endpoint does not exist.
    if (!expected) return false;
    const provided =
      bearerToken(c.req.header("authorization")) ??
      c.req.header("x-cron-secret") ??
      c.req.query("secret");
    if (!provided) return false;
    const given = Buffer.from(provided);
    const wanted = Buffer.from(expected);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  };

  app.all("/api/internal/migrate", async (c) => {
    if (!cronAuthorized(c)) throw errors.forbidden("Invalid cron secret");
    await applySchema(deps.database.driver);
    return c.json({ ok: true, migratedAt: new Date().toISOString() });
  });

  /** Drains queued tasks within one invocation's time budget. */
  app.all("/api/internal/tick", async (c) => {
    if (!cronAuthorized(c)) throw errors.forbidden("Invalid cron secret");
    if (!deps.engine) throw errors.unavailable("This deployment has no executor");
    const startedAt = Date.now();
    const budget = deps.config.maxRunMs;
    const results: Array<{ taskId: string; outcome: string }> = [];
    const orgIds = await listOrgIds(deps.database.driver);
    for (const orgId of orgIds) {
      if (Date.now() - startedAt >= budget) break;
      while (Date.now() - startedAt < budget) {
        const task = await deps.engine.claim(orgId);
        if (!task) break;
        const remaining = Math.max(1000, budget - (Date.now() - startedAt));
        const { outcome } = await deps.engine.runClaimed(task, { budgetMs: remaining });
        results.push({ taskId: task.id, outcome });
      }
    }
    return c.json({
      ok: true,
      ran: results.length,
      results,
      durationMs: Date.now() - startedAt,
    });
  });

  /* ----------------------------------------------------------- approvals */

  app.post("/api/approvals/:id/decision", async (c) => {
    const body = decisionBody.parse(await c.req.json());
    const { user } = requireUser(c);
    const id = param(c, "id");
    const result = await deps.database.withTenant(user.orgId, user.id, async (conn) => {
      const approval = await getApproval(conn, id);
      if (!approval) return null;
      const task = await getTask(conn, approval.taskId);
      if (!task || task.userId !== user.id) return null;
      const decided = await decideApproval(conn, id, body.decision, user.id);
      if (!decided) throw errors.conflict("Approval was already decided");
      if (body.decision === "approved") {
        await updateTask(conn, approval.taskId, {
          status: "queued",
          error: null,
          attempts: 0,
          leaseOwner: null,
          leaseUntil: null,
        });
        if (approval.stepId) {
          await conn.query(
            "UPDATE task_steps SET status = 'pending', error = NULL, started_at = NULL, finished_at = NULL WHERE id = $1",
            [approval.stepId],
          );
        }
        await appendEvent(conn, {
          orgId: user.orgId,
          taskId: approval.taskId,
          kind: "approval",
          title: "Approved",
          detail: approval.summary,
        });
      } else {
        await updateTask(conn, approval.taskId, {
          status: "failed",
          error: "The user denied the requested action",
          finishedAt: new Date(),
          leaseOwner: null,
          leaseUntil: null,
        });
        if (approval.stepId) {
          await conn.query("UPDATE task_steps SET status = 'failed', error = $2 WHERE id = $1", [
            approval.stepId,
            "Denied by the user",
          ]);
        }
        await appendEvent(conn, {
          orgId: user.orgId,
          taskId: approval.taskId,
          kind: "approval",
          title: "Denied",
          detail: approval.summary,
        });
      }
      return decided;
    });
    if (!result) throw errors.notFound("Approval not found");
    await audit(deps, requireUser(c), `approval.${body.decision}`, "approval", id);
    return c.json({ approval: result });
  });

  /* ----------------------------------------------------------- artifacts */

  app.get("/api/artifacts/:id", async (c) => {
    const { user } = requireUser(c);
    const id = param(c, "id");
    const artifact = await deps.database.withTenant(user.orgId, user.id, (conn) =>
      getArtifact(conn, id, user.id),
    );
    if (!artifact) throw errors.notFound("Artifact not found");
    const bytes = await deps.artifactStore.read(artifact.storagePath, user.orgId);
    const filename = artifact.name.replace(/["\r\n]/g, "_");
    return c.body(new Uint8Array(bytes), 200, {
      "content-type": artifact.mime,
      "content-length": String(bytes.byteLength),
      "content-disposition": `attachment; filename="${filename}"`,
      "x-content-sha256": artifact.sha256,
      "cache-control": "private, no-store",
    });
  });

  /* ------------------------------------------------------------ memories */

  app.get("/api/memories", async (c) => {
    const { user } = requireUser(c);
    const memories = await deps.database.withTenant(user.orgId, user.id, (conn) =>
      listMemories(conn, user.orgId, user.id),
    );
    return c.json({ memories });
  });

  app.post("/api/memories", async (c) => {
    const body = z
      .object({ content: z.string().min(1).max(4000), kind: z.string().max(40).default("fact") })
      .parse(await c.req.json());
    const { user } = requireUser(c);
    const memory = await deps.database.withTenant(user.orgId, user.id, (conn) =>
      createMemory(conn, {
        orgId: user.orgId,
        userId: user.id,
        kind: body.kind,
        content: body.content,
        source: "user",
      }),
    );
    return c.json({ memory }, 201);
  });

  app.delete("/api/memories/:id", async (c) => {
    const { user } = requireUser(c);
    const id = param(c, "id");
    const deleted = await deps.database.withTenant(user.orgId, user.id, (conn) =>
      deleteMemory(conn, id, user.id),
    );
    if (!deleted) throw errors.notFound("Memory not found");
    return c.json({ ok: true });
  });

  /* --------------------------------------------------------- connectors */

  const connectorOrigin = (c: AppContext): string => {
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
    if (!host) return new URL(deps.config.publicUrl).origin;
    const protocol =
      c.req.header("x-forwarded-proto") ?? new URL(deps.config.publicUrl).protocol.replace(":", "");
    return `${protocol}://${host}`;
  };

  app.get("/api/connectors", async (c) => {
    const { user } = requireUser(c);
    const connected = await credentialStore.has(user.orgId, user.id, "google");
    return c.json({
      encryption: credentialStore.configured,
      connectors: [
        {
          id: "google",
          name: "Google Calendar",
          configured: google.configured && credentialStore.configured,
          oauthConfigured: google.configured,
          encryption: credentialStore.configured,
          connected,
          scopes: google.scopes,
          tools: ["calendar_list_events", "calendar_create_event"],
        },
      ],
    });
  });

  app.get("/api/connectors/google/authorize", (c) => {
    const { user } = requireUser(c);
    if (!google.configured) {
      throw errors.unavailable(
        "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
      );
    }
    if (!credentialStore.configured) {
      throw errors.unavailable(
        "CREDENTIAL_ENCRYPTION_KEY is required before storing connector tokens.",
      );
    }
    if (!deps.config.sessionSecret) {
      throw errors.unavailable("SESSION_SECRET is required to sign an authorisation request.");
    }
    const redirectUri =
      deps.config.googleRedirectUri ?? `${connectorOrigin(c)}/api/connectors/google/callback`;
    const state = signState(deps.config.sessionSecret, {
      orgId: user.orgId,
      userId: user.id,
      redirectUri,
    });
    return c.json({ url: google.authorizeUrl({ redirectUri, state }) });
  });

  app.get("/api/connectors/google/callback", async (c) => {
    const failed = (status: string) => c.redirect(`/?connector=google&status=${status}`);
    if (c.req.query("error")) return failed("denied");
    const secret = deps.config.sessionSecret;
    const state = secret ? verifyState(secret, c.req.query("state")) : null;
    if (!state) throw errors.forbidden("Invalid or expired authorisation state");
    const code = c.req.query("code");
    if (!code) return failed("missing_code");
    const tokens = await google.exchangeCode(code, state.redirectUri);
    await credentialStore.save(state.orgId, state.userId, "google", tokens);
    await deps.database.withTenant(state.orgId, state.userId, (conn) =>
      recordAudit(conn, {
        orgId: state.orgId,
        actorUserId: state.userId,
        eventType: "connector.connected",
        targetType: "connector",
        targetId: "google",
      }),
    );
    return c.redirect("/?connector=google&status=connected");
  });

  app.post("/api/connectors/google/verify", async (c) => {
    const { user } = requireUser(c);
    const tokens = await credentialStore.load<GoogleTokens>(user.orgId, user.id, "google");
    if (!tokens) throw errors.conflict("Google Calendar is not connected");
    const { result, tokens: current } = await google.call(tokens, (token) =>
      google.listEvents(token, { maxResults: 3 }),
    );
    if (current !== tokens) {
      await credentialStore.save(user.orgId, user.id, "google", current);
    }
    await audit(deps, requireUser(c), "connector.verified", "connector", "google", {
      events: result.length,
    });
    return c.json({ ok: true, events: result.length, sample: result });
  });

  app.delete("/api/connectors/google", async (c) => {
    const { user } = requireUser(c);
    const removed = await credentialStore.remove(user.orgId, user.id, "google");
    if (removed) {
      await audit(deps, requireUser(c), "connector.disconnected", "connector", "google");
    }
    return c.json({ ok: true, removed });
  });

  return app;
}
