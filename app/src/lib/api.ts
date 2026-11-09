/** Typed client for the Talisman API. One place that knows the wire format. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: "owner" | "admin" | "member";
  orgId: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: { text?: string } | string | null;
  createdAt: string;
}

export type TaskStatus =
  | "queued"
  | "scheduled"
  | "running"
  | "waiting_approval"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  conversationId: string | null;
  title: string;
  goal: string;
  status: TaskStatus;
  plan: { steps: { title: string; kind: string; input?: Record<string, unknown> }[] } | null;
  progress: number;
  error: string | null;
  result: unknown;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskStep {
  id: string;
  position: number;
  title: string;
  kind: string;
  status: string;
  input: Record<string, unknown> | null;
  output: unknown;
  error: string | null;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Approval {
  id: string;
  taskId: string;
  kind: string;
  summary: string;
  payload: unknown;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  decidedAt: string | null;
}

export interface Artifact {
  id: string;
  taskId: string | null;
  name: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface TaskEvent {
  id: string;
  seq: string;
  kind: string;
  title: string;
  detail: string | null;
  createdAt: string;
}

export interface TaskDetail {
  task: Task;
  steps: TaskStep[];
  events: TaskEvent[];
  approvals: Approval[];
  artifacts: Artifact[];
}

export interface ApprovalWithTask extends Approval {
  taskTitle: string;
}

export interface AuditEntry {
  id: string;
  actorUserId: string | null;
  eventType: string;
  targetType: string;
  targetId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: "owner" | "admin" | "member";
  createdAt: string;
}

export type PhonePlatform = "android" | "ios" | "bridge";
export type PhoneDeviceStatus = "active" | "paused" | "revoked";

export interface PhoneStatus {
  kind: "cloud" | "bridge" | "companion";
  label: string;
  ready: boolean;
  detail: string;
  ops?: string[];
}

export interface PhoneDevice {
  id: string;
  name: string;
  platform: PhonePlatform;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  status: PhoneDeviceStatus;
  capabilities: Record<string, unknown>;
  settings: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  lastSeenAt: string | null;
  createdAt: string;
  online: boolean;
}

export interface PhonePairing {
  code: string;
  expiresAt: string;
  qr: string;
  server: string;
}

export interface PhoneApproval {
  id: string;
  deviceId: string;
  op: "act" | "flow" | "task";
  args: Record<string, unknown>;
  summary: string;
  status: "pending" | "approved" | "denied" | "expired" | "completed";
  expiresAt: string;
  createdAt: string;
  decidedAt: string | null;
  plan?: string[] | null;
  /** True for one approved goal that runs as a live observe/act loop. */
  task?: boolean;
}

export interface PhoneActionDecision {
  approval: PhoneApproval;
  command: {
    id: string;
    status: string;
    result: unknown;
    error: string | null;
  } | null;
  task: { id: string; goal: string; maxSteps: number } | null;
}

export interface DevicesResponse {
  configured: boolean;
  devices: PhoneDevice[];
  ops: string[];
  protocol: string;
  minApp: string;
  legacy: PhoneStatus | null;
  hint?: string;
}

export interface Connector {
  id: string;
  name: string;
  connected: boolean;
  configured: boolean;
  oauthConfigured: boolean;
  scopes?: string[];
  account?: string | null;
}

export interface ConnectorState {
  encryption: boolean;
  connectors: Connector[];
}

export interface Memory {
  id: string;
  kind: string;
  content: string;
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfile {
  orgId: string;
  userId: string;
  displayName: string | null;
  timezone: string;
  locale: string;
  preferences: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ScheduleKind = "interval" | "daily";

export interface Schedule {
  id: string;
  title: string;
  goal: string;
  kind: ScheduleKind;
  intervalMinutes: number | null;
  hour: number | null;
  minute: number | null;
  timezone: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastTaskId: string | null;
  lastSkippedAt: string | null;
  lastSkipReason: string | null;
  createdAt: string;
}

export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  data: { taskId?: string; approvalId?: string; scheduleId?: string } | null;
  readAt: string | null;
  createdAt: string;
}

export interface Health {
  ok: boolean;
  runtime: string;
  database: string;
  schema: string;
  capabilities: {
    models: boolean;
    defaultModel: string;
    search: string | null;
    browser: string;
    artifacts: string;
    executor: string;
  };
}

export interface AuthResult {
  user: User;
  expiresAt: string;
}

async function errorFrom(response: Response): Promise<ApiError> {
  let message = `Request failed (${response.status})`;
  let code: string | undefined;
  try {
    const body = (await response.json()) as { error?: string; code?: string };
    if (body.error) message = body.error;
    code = body.code;
  } catch {
    // Non-JSON error body: keep the status message.
  }
  return new ApiError(message, response.status, code);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw await errorFrom(response);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const body = (value: unknown) => JSON.stringify(value);

export const api = {
  me: () => request<{ user: User }>("/api/me"),
  health: () => request<Health>("/api/health"),

  login: (email: string, password: string) =>
    request<AuthResult>("/api/auth/login", { method: "POST", body: body({ email, password }) }),
  signup: (input: { email: string; password: string; name?: string; orgName: string }) =>
    request<AuthResult>("/api/auth/signup", { method: "POST", body: body(input) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),

  conversations: () => request<{ conversations: Conversation[] }>("/api/conversations"),
  createConversation: (title = "New conversation") =>
    request<{ conversation: Conversation }>("/api/conversations", {
      method: "POST",
      body: body({ title }),
    }),
  messages: (id: string) =>
    request<{ messages: StoredMessage[] }>(`/api/conversations/${id}/messages`),

  tasks: () => request<{ tasks: Task[] }>("/api/tasks"),
  task: (id: string) => request<TaskDetail>(`/api/tasks/${id}`),
  createTask: (input: { goal: string; seedUrls?: string[]; title?: string; conversationId?: string }) =>
    request<{ task: Task }>("/api/tasks", { method: "POST", body: body(input) }),
  taskAction: (id: string, action: "pause" | "resume" | "cancel" | "retry" | "run") =>
    request<{ task?: Task; ran?: boolean; reason?: string }>(`/api/tasks/${id}/${action}`, {
      method: "POST",
    }),
  decide: (id: string, decision: "approved" | "denied") =>
    request<{ approval: Approval }>(`/api/approvals/${id}/decision`, {
      method: "POST",
      body: body({ decision }),
    }),

  artifacts: () => request<{ artifacts: Artifact[] }>("/api/artifacts"),
  approvals: (status: "pending" | "all" = "pending") =>
    request<{ approvals: ApprovalWithTask[] }>(`/api/approvals?status=${status}`),
  activity: () => request<{ events: AuditEntry[] }>("/api/activity"),
  team: () => request<{ members: Member[] }>("/api/team"),

  devices: () => request<DevicesResponse>("/api/devices"),
  startPhonePairing: (input: { platform: PhonePlatform; name: string }) =>
    request<PhonePairing>("/api/phone/pair/start", {
      method: "POST",
      body: body(input),
    }),
  pauseDevice: (id: string) =>
    request<{ device: PhoneDevice; cancelled: number }>(
      `/api/devices/${encodeURIComponent(id)}/pause`,
      { method: "POST" },
    ),
  resumeDevice: (id: string) =>
    request<{ device: PhoneDevice }>(`/api/devices/${encodeURIComponent(id)}/resume`, {
      method: "POST",
    }),
  revokeDevice: (id: string) =>
    request<{ ok: true; cancelled: number }>(`/api/devices/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  deviceDiagnostics: (id: string) =>
    request<{
      device: PhoneDevice;
      diagnostics: Record<string, unknown>;
      capabilities: Record<string, unknown>;
      settings: Record<string, unknown>;
    }>(`/api/devices/${encodeURIComponent(id)}/diagnostics`),
  deviceFrameUrl: (id: string, nonce = Date.now()) =>
    `/api/devices/${encodeURIComponent(id)}/frame?t=${nonce}`,
  companionOp: (id: string, op: "observe" | "apps" | "status", args: Record<string, unknown> = {}) =>
    request<{ result: unknown }>(`/api/devices/${encodeURIComponent(id)}/op`, {
      method: "POST",
      body: body({ op, args }),
    }),
  deviceOp: (op: string, kw: Record<string, unknown> = {}) =>
    request<{ png_b64?: string | null; bounds?: unknown; result?: unknown }>("/api/devices/op", {
      method: "POST",
      body: body({ op, kw }),
    }),
  requestPhoneAction: (
    id: string,
    op: "act" | "flow",
    args: Record<string, unknown> = {},
  ) =>
    request<{ approval: PhoneApproval }>(`/api/devices/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      body: body({ op, args }),
    }),
  phoneApprovals: (status: "pending" | "approved" | "denied" | "expired" | "all" = "pending") =>
    request<{ approvals: PhoneApproval[] }>(`/api/phone/approvals?status=${status}`),
  decidePhoneApproval: (id: string, decision: "approved" | "denied") =>
    request<PhoneActionDecision>(`/api/phone/approvals/${encodeURIComponent(id)}/decision`, {
      method: "POST",
      body: body({ decision }),
    }),

  memories: () => request<{ memories: Memory[] }>("/api/memories"),
  addMemory: (input: { content: string; kind?: string }) =>
    request<{ memory: Memory }>("/api/memories", { method: "POST", body: body(input) }),
  deleteMemory: (id: string) =>
    request<{ ok: true }>(`/api/memories/${encodeURIComponent(id)}`, { method: "DELETE" }),
  embedMemories: () =>
    request<{ updated: number; model: string }>("/api/memories/embed", { method: "POST" }),
  profile: () =>
    request<{ profile: UserProfile | null; user: { name: string | null; email: string } }>(
      "/api/profile",
    ),
  updateProfile: (input: {
    displayName?: string | null;
    timezone?: string;
    locale?: string;
    preferences?: Record<string, unknown>;
  }) =>
    request<{ profile: UserProfile }>("/api/profile", { method: "PATCH", body: body(input) }),
  schedules: () => request<{ schedules: Schedule[] }>("/api/schedules"),
  createSchedule: (input: {
    title: string;
    goal: string;
    kind: ScheduleKind;
    intervalMinutes?: number;
    hour?: number;
    minute?: number;
    timezone: string;
  }) =>
    request<{ schedule: Schedule }>("/api/schedules", { method: "POST", body: body(input) }),
  updateSchedule: (id: string, input: { enabled?: boolean }) =>
    request<{ schedule: Schedule }>(`/api/schedules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: body(input),
    }),
  deleteSchedule: (id: string) =>
    request<{ ok: true }>(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" }),
  runSchedule: (id: string) =>
    request<{ task: Task }>(`/api/schedules/${encodeURIComponent(id)}/run`, { method: "POST" }),
  notifications: () =>
    request<{ notifications: AppNotification[]; unread: number }>("/api/notifications"),
  readNotification: (id: string) =>
    request<{ notification: AppNotification }>(`/api/notifications/${encodeURIComponent(id)}/read`, {
      method: "POST",
    }),
  readAllNotifications: () =>
    request<{ updated: number }>("/api/notifications/read-all", { method: "POST" }),

  connectors: () => request<ConnectorState>("/api/connectors"),
  authorizeGoogle: () => request<{ url: string }>("/api/connectors/google/authorize"),
  verifyGoogle: () =>
    request<{ events: number; calendar?: string }>("/api/connectors/google/verify", { method: "POST" }),
  disconnectGoogle: () => request<{ ok: true }>("/api/connectors/google", { method: "DELETE" }),

  artifactUrl: (id: string) => `/api/artifacts/${id}`,
};

export interface StreamHandlers {
  onText: (text: string) => void;
  onTool: (event: {
    phase: "start" | "end";
    name: string;
    args?: unknown;
    ok?: boolean;
    task?: { id: string; status: string; progress: number };
  }) => void;
  onApproval?: (approval: {
    id: string;
    summary: string;
    expiresAt: string | null;
    deviceName: string | null;
    plan?: string[] | null;
    task?: boolean;
  }) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

/**
 * The chat endpoint is POST + SSE: the request carries the message, the response
 * streams text deltas and tool calls. Nothing here buffers the whole reply.
 */
export interface StreamMessageOptions {
  /** A continuation after an approval; the server does not store it as a user message. */
  internal?: boolean;
  /** Context for the continuation, such as the approved action's result. */
  context?: string;
}

export async function streamMessage(
  conversationId: string,
  content: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
  options: StreamMessageOptions = {},
): Promise<void> {
  const response = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: body({ content, ...options }),
    signal,
  });
  if (!response.ok) throw await errorFrom(response);
  if (!response.body) throw new ApiError("This browser cannot stream responses", 0);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  const dispatch = (block: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    const payload = data.join("\n");
    if (event === "text") handlers.onText(payload);
    else if (event === "tool") {
      try {
        handlers.onTool(
          JSON.parse(payload) as {
            phase: "start" | "end";
            name: string;
            task?: { id: string; status: string; progress: number };
          },
        );
      } catch {
        // A malformed tool frame should not kill the stream.
      }
    } else if (event === "approval") {
      try {
        handlers.onApproval?.(
          JSON.parse(payload) as {
            id: string;
            summary: string;
            expiresAt: string | null;
            deviceName: string | null;
            plan?: string[] | null;
          },
        );
      } catch {
        // A malformed approval frame should not kill the stream.
      }
    } else if (event === "done") {
      finished = true;
      handlers.onDone();
    } else if (event === "error") {
      try {
        handlers.onError((JSON.parse(payload) as { error?: string }).error ?? "The agent stopped.");
      } catch {
        handlers.onError("The agent stopped.");
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.search(/\r?\n\r?\n/);
    while (index >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + (buffer[index] === "\r" ? 4 : 2));
      if (block.trim()) dispatch(block);
      index = buffer.search(/\r?\n\r?\n/);
    }
  }
  if (buffer.trim()) dispatch(buffer);
  if (!finished) handlers.onDone();
}
