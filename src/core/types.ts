/** Shared domain types for Talisman. No framework or model-provider types leak in here. */

export type Role = "owner" | "admin" | "member";

export interface Org {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  orgId: string;
  createdAt: string;
}

export interface SessionInfo {
  user: User;
  expiresAt: string;
}

export type ConversationRole = "user" | "assistant" | "tool" | "system";

export interface Conversation {
  id: string;
  orgId: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: string;
  orgId: string;
  conversationId: string;
  role: ConversationRole;
  content: unknown;
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

export type StepStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export interface PlanStep {
  title: string;
  kind: string;
  input?: Record<string, unknown>;
}

export interface TaskPlan {
  steps: PlanStep[];
}

export interface Task {
  id: string;
  orgId: string;
  userId: string;
  conversationId: string | null;
  title: string;
  goal: string;
  status: TaskStatus;
  plan: TaskPlan | null;
  progress: number;
  error: string | null;
  result: unknown;
  attempts: number;
  maxAttempts: number;
  runAfter: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskStep {
  id: string;
  orgId: string;
  taskId: string;
  position: number;
  title: string;
  kind: string;
  status: StepStatus;
  input: Record<string, unknown> | null;
  output: unknown;
  error: string | null;
  /** How many times execution started for this step, across slices and retries. */
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export type TaskEventKind =
  | "status"
  | "plan"
  | "step"
  | "progress"
  | "log"
  | "approval"
  | "artifact"
  | "error"
  | "done";

export interface TaskEvent {
  id: string;
  orgId: string;
  taskId: string;
  seq: string;
  kind: TaskEventKind;
  title: string;
  detail: string | null;
  data: unknown;
  createdAt: string;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface Approval {
  id: string;
  orgId: string;
  taskId: string;
  stepId: string | null;
  kind: string;
  summary: string;
  payload: unknown;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface Artifact {
  id: string;
  orgId: string;
  taskId: string | null;
  userId: string;
  name: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  metadata: unknown;
  createdAt: string;
}

export interface Memory {
  id: string;
  orgId: string;
  userId: string;
  kind: string;
  content: string;
  source: string | null;
  /** Optional dense vector used for semantic recall. */
  embedding: number[] | null;
  embeddingModel: string | null;
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
  orgId: string;
  userId: string;
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
  updatedAt: string;
}

export interface Notification {
  id: string;
  orgId: string;
  userId: string;
  kind: string;
  title: string;
  body: string | null;
  data: unknown;
  readAt: string | null;
  createdAt: string;
}

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}
