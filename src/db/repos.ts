import type { Conn } from "./database.js";
import { newId } from "../core/ids.js";
import type {
  Approval,
  ApprovalStatus,
  Artifact,
  Conversation,
  Memory,
  Notification,
  PlanStep,
  Role,
  Schedule,
  ScheduleKind,
  SessionInfo,
  StepStatus,
  StoredMessage,
  Task,
  TaskEvent,
  TaskEventKind,
  TaskPlan,
  TaskStatus,
  TaskStep,
  User,
  UserProfile,
} from "../core/types.js";

type Row = Record<string, unknown>;

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);
const isoOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : iso(value);
const num = (value: unknown): number => Number(value ?? 0);

/* ------------------------------------------------------------------ auth */

export async function createOrgWithOwner(
  conn: Conn,
  input: { orgName: string; slug: string; email: string; name: string | null; passwordHash: string },
): Promise<User> {
  const orgId = newId();
  const userId = newId();
  await conn.query("INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)", [
    orgId,
    input.orgName,
    input.slug,
  ]);
  const { rows } = await conn.query<Row>(
    "INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4) RETURNING *",
    [userId, input.email.toLowerCase(), input.name, input.passwordHash],
  );
  await conn.query(
    "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')",
    [orgId, userId],
  );
  return { ...mapUser(rows[0]!, orgId), role: "owner" };
}

export function mapUser(row: Row, orgId: string): User {
  return {
    id: String(row.id),
    email: String(row.email),
    name: row.name === null || row.name === undefined ? null : String(row.name),
    role: (row.role as Role | undefined) ?? "member",
    orgId,
    createdAt: iso(row.created_at),
  };
}

export async function findUserByEmail(
  conn: Conn,
  email: string,
): Promise<{ user: User; passwordHash: string } | null> {
  const { rows } = await conn.query<Row>(
    `SELECT u.id, u.email, u.name, u.password_hash, u.created_at, m.org_id, m.role
       FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE u.email = $1
      ORDER BY u.created_at LIMIT 1`,
    [email.toLowerCase()],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    user: mapUser(row, String(row.org_id)),
    passwordHash: String(row.password_hash),
  };
}

export async function findUserByIdentity(
  conn: Conn,
  userId: string,
  orgId: string,
): Promise<User | null> {
  const { rows } = await conn.query<Row>(
    `SELECT u.id, u.email, u.name, u.created_at, m.org_id, m.role
       FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE u.id = $1 AND m.org_id = $2`,
    [userId, orgId],
  );
  const row = rows[0];
  return row ? mapUser(row, String(row.org_id)) : null;
}

export async function orgExists(conn: Conn, orgId: string): Promise<boolean> {
  const { rows } = await conn.query("SELECT 1 FROM orgs WHERE id = $1", [orgId]);
  return rows.length > 0;
}

export async function listOrgIds(conn: Conn): Promise<string[]> {
  const { rows } = await conn.query<{ id: string }>("SELECT id FROM orgs ORDER BY created_at");
  return rows.map((row) => row.id);
}

export async function createSession(
  conn: Conn,
  input: { id: string; userId: string; orgId: string; expiresAt: Date },
): Promise<void> {
  await conn.query(
    "INSERT INTO sessions (id, user_id, org_id, expires_at) VALUES ($1, $2, $3, $4)",
    [input.id, input.userId, input.orgId, input.expiresAt],
  );
}

export async function findSession(
  conn: Conn,
  sessionId: string,
): Promise<{ info: SessionInfo; expiresAt: Date } | null> {
  const { rows } = await conn.query<Row>(
    `SELECT u.id, u.email, u.name, u.created_at, m.org_id, m.role, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN memberships m ON m.user_id = s.user_id AND m.org_id = s.org_id
      WHERE s.id = $1`,
    [sessionId],
  );
  const row = rows[0];
  if (!row) return null;
  const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(String(row.expires_at));
  if (expiresAt.getTime() <= Date.now()) return null;
  return {
    info: { user: mapUser(row, String(row.org_id)), expiresAt: expiresAt.toISOString() },
    expiresAt,
  };
}

export async function touchSession(conn: Conn, sessionId: string): Promise<void> {
  await conn.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [sessionId]);
}

export async function deleteSession(conn: Conn, sessionId: string): Promise<void> {
  await conn.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
}

export async function deleteExpiredSessions(conn: Conn): Promise<void> {
  await conn.query("DELETE FROM sessions WHERE expires_at <= now()");
}

export async function listOrgsForUser(
  conn: Conn,
  userId: string,
): Promise<Array<{ id: string; name: string; role: Role }>> {
  const { rows } = await conn.query<Row>(
    `SELECT o.id, o.name, m.role FROM memberships m
       JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = $1 ORDER BY o.created_at`,
    [userId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    role: row.role as Role,
  }));
}

/* --------------------------------------------------------- conversations */

export async function createConversation(
  conn: Conn,
  input: { orgId: string; userId: string; title: string },
): Promise<Conversation> {
  const { rows } = await conn.query<Row>(
    `INSERT INTO conversations (id, org_id, user_id, title) VALUES ($1, $2, $3, $4) RETURNING *`,
    [newId(), input.orgId, input.userId, input.title.slice(0, 200)],
  );
  return mapConversation(rows[0]!);
}

export function mapConversation(row: Row): Conversation {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    title: String(row.title),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function listConversations(
  conn: Conn,
  orgId: string,
  userId: string,
): Promise<Conversation[]> {
  const { rows } = await conn.query<Row>(
    `SELECT * FROM conversations WHERE org_id = $1 AND user_id = $2
      ORDER BY updated_at DESC LIMIT 100`,
    [orgId, userId],
  );
  return rows.map(mapConversation);
}

export async function getConversation(
  conn: Conn,
  id: string,
  userId: string,
): Promise<Conversation | null> {
  const { rows } = await conn.query<Row>(
    "SELECT * FROM conversations WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return rows[0] ? mapConversation(rows[0]) : null;
}

export async function addMessage(
  conn: Conn,
  input: {
    orgId: string;
    conversationId: string;
    role: StoredMessage["role"];
    content: unknown;
  },
): Promise<StoredMessage> {
  const { rows } = await conn.query<Row>(
    `INSERT INTO messages (id, org_id, conversation_id, role, content)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
    [newId(), input.orgId, input.conversationId, input.role, JSON.stringify(input.content ?? null)],
  );
  await conn.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [
    input.conversationId,
  ]);
  return mapMessage(rows[0]!);
}

function mapMessage(row: Row): StoredMessage {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    conversationId: String(row.conversation_id),
    role: row.role as StoredMessage["role"],
    content: row.content,
    createdAt: iso(row.created_at),
  };
}

export async function listMessages(
  conn: Conn,
  conversationId: string,
  limit = 100,
): Promise<StoredMessage[]> {
  const { rows } = await conn.query<Row>(
    `SELECT * FROM (
       SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2
     ) recent ORDER BY created_at ASC`,
    [conversationId, limit],
  );
  return rows.map(mapMessage);
}

/* ------------------------------------------------------------------ tasks */

export function mapTask(row: Row): Task {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    title: String(row.title),
    goal: String(row.goal),
    status: row.status as TaskStatus,
    plan: (row.plan as TaskPlan | null) ?? null,
    progress: num(row.progress),
    error: row.error === null ? null : String(row.error),
    result: row.result ?? null,
    attempts: num(row.attempts),
    maxAttempts: num(row.max_attempts),
    runAfter: isoOrNull(row.run_after),
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseUntil: isoOrNull(row.lease_until),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    startedAt: isoOrNull(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
  };
}

export async function createTask(
  conn: Conn,
  input: {
    orgId: string;
    userId: string;
    conversationId?: string | null;
    title: string;
    goal: string;
    plan?: TaskPlan | null;
    status?: TaskStatus;
    runAfter?: Date | null;
    maxAttempts?: number;
  },
): Promise<Task> {
  const { rows } = await conn.query<Row>(
    `INSERT INTO tasks (id, org_id, user_id, conversation_id, title, goal, plan, status, run_after, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10) RETURNING *`,
    [
      newId(),
      input.orgId,
      input.userId,
      input.conversationId ?? null,
      input.title.slice(0, 200),
      input.goal,
      input.plan ? JSON.stringify(input.plan) : null,
      input.status ?? "queued",
      input.runAfter ?? null,
      input.maxAttempts ?? 3,
    ],
  );
  return mapTask(rows[0]!);
}

export async function getTask(conn: Conn, id: string): Promise<Task | null> {
  const { rows } = await conn.query<Row>("SELECT * FROM tasks WHERE id = $1", [id]);
  return rows[0] ? mapTask(rows[0]) : null;
}

export async function listTasks(
  conn: Conn,
  orgId: string,
  userId: string,
  limit = 50,
): Promise<Task[]> {
  const { rows } = await conn.query<Row>(
    `SELECT * FROM tasks WHERE org_id = $1 AND user_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [orgId, userId, limit],
  );
  return rows.map(mapTask);
}

const TASK_COLUMNS: Record<string, string> = {
  status: "status",
  progress: "progress",
  error: "error",
  result: "result",
  plan: "plan",
  leaseOwner: "lease_owner",
  leaseUntil: "lease_until",
  attempts: "attempts",
  runAfter: "run_after",
  startedAt: "started_at",
  finishedAt: "finished_at",
};

export async function updateTask(
  conn: Conn,
  id: string,
  patch: Record<string, unknown>,
): Promise<Task | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = TASK_COLUMNS[key];
    if (!column) continue;
    values.push(
      key === "result" || key === "plan"
        ? value === null
          ? null
          : JSON.stringify(value)
        : value,
    );
    const cast = key === "result" || key === "plan" ? "::jsonb" : "";
    sets.push(`${column} = $${values.length}${cast}`);
  }
  if (sets.length === 0) return getTask(conn, id);
  values.push(id);
  const { rows } = await conn.query<Row>(
    `UPDATE tasks SET ${sets.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
    values,
  );
  return rows[0] ? mapTask(rows[0]) : null;
}

export async function claimNextTask(
  conn: Conn,
  workerId: string,
  leaseMs: number,
): Promise<Task | null> {
  const { rows } = await conn.query<Row>(
    `SELECT * FROM tasks
      WHERE status = 'queued'
         OR (status = 'scheduled' AND (run_after IS NULL OR run_after <= now()))
         OR (status = 'running' AND (lease_until IS NULL OR lease_until <= now()))
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  const { rows: updated } = await conn.query<Row>(
    `UPDATE tasks
        SET status = 'running', lease_owner = $2,
            lease_until = now() + ($3::text || ' milliseconds')::interval,
            attempts = attempts + 1,
            started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [String(row.id), workerId, String(leaseMs)],
  );
  return updated[0] ? mapTask(updated[0]) : null;
}

/**
 * Claims one named task under the same lease rules as `claimNextTask`. A claim
 * only counts as a retry when the previous slice recorded a failure, so running a
 * multi-step task as several short slices does not exhaust its retry budget.
 */
export async function claimTaskById(
  conn: Conn,
  taskId: string,
  workerId: string,
  leaseMs: number,
): Promise<Task | null> {
  const { rows } = await conn.query<Row>(
    `UPDATE tasks
        SET status = 'running', lease_owner = $2,
            lease_until = now() + ($3::text || ' milliseconds')::interval,
            attempts = attempts + CASE WHEN error IS NULL THEN 0 ELSE 1 END,
            started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = $1
        AND (status = 'queued'
             OR (status = 'scheduled' AND (run_after IS NULL OR run_after <= now()))
             OR (status = 'running' AND (lease_until IS NULL OR lease_until <= now())))
      RETURNING *`,
    [taskId, workerId, String(leaseMs)],
  );
  return rows[0] ? mapTask(rows[0]) : null;
}

export async function createStep(
  conn: Conn,
  input: {
    orgId: string;
    taskId: string;
    position: number;
    title: string;
    kind: string;
    input?: Record<string, unknown> | null;
  },
): Promise<TaskStep> {
  const { rows } = await conn.query<Row>(
    `INSERT INTO task_steps (id, org_id, task_id, position, title, kind, input)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (task_id, position) DO UPDATE
       SET title = EXCLUDED.title, kind = EXCLUDED.kind, input = EXCLUDED.input
     RETURNING *`,
    [
      newId(),
      input.orgId,
      input.taskId,
      input.position,
      input.title,
      input.kind,
      input.input ? JSON.stringify(input.input) : null,
    ],
  );
  return mapStep(rows[0]!);
}

function mapStep(row: Row): TaskStep {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    taskId: String(row.task_id),
    position: num(row.position),
    title: String(row.title),
    kind: String(row.kind),
    status: row.status as StepStatus,
    input: (row.input as Record<string, unknown> | null) ?? null,
    output: row.output ?? null,
    error: row.error === null ? null : String(row.error),
    attempts: num(row.attempts),
    startedAt: isoOrNull(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
  };
}

export async function updateStep(
  conn: Conn,
  id: string,
  patch: {
    status?: StepStatus;
    output?: unknown;
    error?: string | null;
    attempts?: number;
    startedAt?: Date | null;
    finishedAt?: Date | null;
  },
): Promise<TaskStep | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    values.push(patch.status);
    sets.push(`status = $${values.length}`);
  }
  if (patch.output !== undefined) {
    values.push(patch.output === null ? null : JSON.stringify(patch.output));
    sets.push(`output = $${values.length}::jsonb`);
  }
  if (patch.error !== undefined) {
    values.push(patch.error);
    sets.push(`error = $${values.length}`);
  }
  if (patch.attempts !== undefined) {
    values.push(patch.attempts);
    sets.push(`attempts = $${values.length}`);
  }
  if (patch.startedAt !== undefined) {
    values.push(patch.startedAt);
    sets.push(`started_at = $${values.length}`);
  }
  if (patch.finishedAt !== undefined) {
    values.push(patch.finishedAt);
    sets.push(`finished_at = $${values.length}`);
  }
  if (sets.length === 0) return null;
  values.push(id);
  const { rows } = await conn.query<Row>(
    `UPDATE task_steps SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
    values,
  );
  return rows[0] ? mapStep(rows[0]) : null;
}

export async function listSteps(conn: Conn, taskId: string): Promise<TaskStep[]> {
  const { rows } = await conn.query<Row>(
    "SELECT * FROM task_steps WHERE task_id = $1 ORDER BY position",
    [taskId],
  );
  return rows.map(mapStep);
}

export async function appendEvent(
  conn: Conn,
  input: {
    orgId: string;
    taskId: string;
    kind: TaskEventKind;
    title: string;
    detail?: string | null;
    data?: unknown;
  },
): Promise<TaskEvent> {
  const { rows } = await conn.query<Row>(
    `INSERT INTO task_events (id, org_id, task_id, kind, title, detail, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`,
    [
      newId(),
      input.orgId,
      input.taskId,
      input.kind,
      input.title.slice(0, 300),
      input.detail ?? null,
      input.data === undefined ? null : JSON.stringify(input.data),
    ],
  );
  return mapEvent(rows[0]!);
}

function mapEvent(row: Row): TaskEvent {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    taskId: String(row.task_id),
    seq: String(row.seq),
    kind: row.kind as TaskEventKind,
    title: String(row.title),
    detail: row.detail === null ? null : String(row.detail),
    data: row.data ?? null,
    createdAt: iso(row.created_at),
  };
}

export async function listEvents(
  conn: Conn,
  taskId: string,
  afterSeq = "0",
  limit = 500,
): Promise<TaskEvent[]> {
  const { rows } = await conn.query<Row>(
    `SELECT * FROM task_events WHERE task_id = $1 AND seq > $2::bigint
      ORDER BY seq LIMIT $3`,
    [taskId, afterSeq, limit],
  );
  return rows.map(mapEvent);
}

/* -------------------------------------------------------------- approvals */

function mapApproval(row: Row): Approval {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    taskId: String(row.task_id),
    stepId: row.step_id === null ? null : String(row.step_id),
    kind: String(row.kind),
    summary: String(row.summary),
    payload: row.payload ?? null,
    status: row.status as ApprovalStatus,
    decidedBy: row.decided_by === null ? null : String(row.decided_by),
    decidedAt: isoOrNull(row.decided_at),
    expiresAt: isoOrNull(row.expires_at),
    createdAt: iso(row.created_at),
  };
}

export async function createApproval(
  conn: Conn,
  input: {
    orgId: string;
    taskId: string;
    stepId?: string | null;
    kind: string;
    summary: string;
    payload?: unknown;
    expiresAt?: Date | null;
  },
): Promise<Approval> {
  const { rows } = await conn.query<Row>(
    `INSERT INTO approvals (id, org_id, task_id, step_id, kind, summary, payload, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING *`,
    [
      newId(),
      input.orgId,
      input.taskId,
      input.stepId ?? null,
      input.kind,
      input.summary,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.expiresAt ?? null,
    ],
  );
  return mapApproval(rows[0]!);
}

export async function getApproval(conn: Conn, id: string): Promise<Approval | null> {
  const { rows } = await conn.query<Row>("SELECT * FROM approvals WHERE id = $1", [id]);
  return rows[0] ? mapApproval(rows[0]) : null;
}

export async function decideApproval(
  conn: Conn,
  id: string,
  status: "approved" | "denied",
  userId: string,
): Promise<Approval | null> {
  const { rows } = await conn.query<Row>(
    `UPDATE approvals SET status = $2, decided_by = $3, decided_at = now()
      WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, status, userId],
  );
  return rows[0] ? mapApproval(rows[0]) : null;
}

export async function listApprovals(conn: Conn, taskId: string): Promise<Approval[]> {
  const { rows } = await conn.query<Row>(
    "SELECT * FROM approvals WHERE task_id = $1 ORDER BY created_at",
    [taskId],
  );
  return rows.map(mapApproval);
}

/* -------------------------------------------------------------- artifacts */

function mapArtifact(row: Row): Artifact {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    userId: String(row.user_id),
    name: String(row.name),
    mime: String(row.mime),
    sizeBytes: num(row.size_bytes),
    sha256: String(row.sha256),
    storagePath: String(row.storage_path),
    metadata: row.metadata ?? null,
    createdAt: iso(row.created_at),
  };
}

export async function createArtifact(
  conn: Conn,
  input: {
    id?: string;
    orgId: string;
    taskId: string | null;
    userId: string;
    name: string;
    mime: string;
    sizeBytes: number;
    sha256: string;
    storagePath: string;
    metadata?: unknown;
  },
): Promise<Artifact> {
  const { rows } = await conn.query<Row>(
    `INSERT INTO artifacts (id, org_id, task_id, user_id, name, mime, size_bytes, sha256, storage_path, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) RETURNING *`,
    [
      input.id ?? newId(),
      input.orgId,
      input.taskId,
      input.userId,
      input.name,
      input.mime,
      input.sizeBytes,
      input.sha256,
      input.storagePath,
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    ],
  );
  return mapArtifact(rows[0]!);
}

export async function getArtifact(
  conn: Conn,
  id: string,
  userId: string,
): Promise<Artifact | null> {
  const { rows } = await conn.query<Row>(
    "SELECT * FROM artifacts WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return rows[0] ? mapArtifact(rows[0]) : null;
}

export async function listArtifacts(conn: Conn, taskId: string): Promise<Artifact[]> {
  const { rows } = await conn.query<Row>(
    "SELECT * FROM artifacts WHERE task_id = $1 ORDER BY created_at",
    [taskId],
  );
  return rows.map(mapArtifact);
}

/* --------------------------------------------------------------- memories */

function embeddingOf(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const vector = value.map(Number).filter((entry) => Number.isFinite(entry));
  return vector.length > 0 ? vector : null;
}

function mapMemory(row: Row): Memory {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    kind: String(row.kind),
    content: String(row.content),
    source: row.source === null ? null : String(row.source),
    embedding: embeddingOf(row.embedding),
    embeddingModel:
      row.embedding_model === null || row.embedding_model === undefined
        ? null
        : String(row.embedding_model),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function createMemory(
  conn: Conn,
  input: {
    orgId: string;
    userId: string;
    kind: string;
    content: string;
    source?: string | null;
    embedding?: number[] | null;
    embeddingModel?: string | null;
  },
): Promise<Memory> {
  const { rows } = await conn.query<Row>(
    `INSERT INTO memories (id, org_id, user_id, kind, content, source, embedding, embedding_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING *`,
    [
      newId(),
      input.orgId,
      input.userId,
      input.kind,
      input.content.slice(0, 4000),
      input.source ?? null,
      input.embedding ? JSON.stringify(input.embedding) : null,
      input.embeddingModel ?? null,
    ],
  );
  return mapMemory(rows[0]!);
}

export async function updateMemoryEmbedding(
  conn: Conn,
  id: string,
  userId: string,
  embedding: number[],
  model: string,
): Promise<void> {
  await conn.query(
    "UPDATE memories SET embedding = $3::jsonb, embedding_model = $4, updated_at = now() WHERE id = $1 AND user_id = $2",
    [id, userId, JSON.stringify(embedding), model],
  );
}

export async function listMemoriesMissingEmbeddings(
  conn: Conn,
  orgId: string,
  userId: string,
  limit = 20,
): Promise<Memory[]> {
  const { rows } = await conn.query<Row>(
    `SELECT * FROM memories
      WHERE org_id = $1 AND user_id = $2 AND embedding IS NULL
      ORDER BY updated_at DESC LIMIT $3`,
    [orgId, userId, limit],
  );
  return rows.map(mapMemory);
}

/* --------------------------------------------------------------- profile */

function mapProfile(row: Row): UserProfile {
  return {
    orgId: String(row.org_id),
    userId: String(row.user_id),
    displayName: row.display_name === null ? null : String(row.display_name),
    timezone: String(row.timezone),
    locale: String(row.locale),
    preferences:
      row.preferences && typeof row.preferences === "object" && !Array.isArray(row.preferences)
        ? (row.preferences as Record<string, unknown>)
        : {},
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function getProfile(
  conn: Conn,
  orgId: string,
  userId: string,
): Promise<UserProfile | null> {
  const { rows } = await conn.query<Row>(
    "SELECT * FROM user_profiles WHERE org_id = $1 AND user_id = $2",
    [orgId, userId],
  );
  return rows[0] ? mapProfile(rows[0]) : null;
}

export async function upsertProfile(
  conn: Conn,
  input: {
    orgId: string;
    userId: string;
    displayName?: string | null;
    timezone?: string;
    locale?: string;
    preferences?: Record<string, unknown>;
  },
): Promise<UserProfile> {
  const { rows } = await conn.query<Row>(
    `INSERT INTO user_profiles (org_id, user_id, display_name, timezone, locale, preferences)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (org_id, user_id) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, user_profiles.display_name),
       timezone = EXCLUDED.timezone,
       locale = EXCLUDED.locale,
       preferences = EXCLUDED.preferences,
       updated_at = now()
     RETURNING *`,
    [
      input.orgId,
      input.userId,
      input.displayName ?? null,
      input.timezone ?? "UTC",
      input.locale ?? "en",
      JSON.stringify(input.preferences ?? {}),
    ],
  );
  return mapProfile(rows[0]!);
}

/* ------------------------------------------------------------- schedules */

function mapSchedule(row: Row): Schedule {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    title: String(row.title),
    goal: String(row.goal),
    kind: row.kind as ScheduleKind,
    intervalMinutes:
      row.interval_minutes === null || row.interval_minutes === undefined
        ? null
        : Number(row.interval_minutes),
    hour: row.hour === null || row.hour === undefined ? null : Number(row.hour),
    minute: row.minute === null || row.minute === undefined ? null : Number(row.minute),
    timezone: String(row.timezone),
    enabled: Boolean(row.enabled),
    nextRunAt: iso(row.next_run_at),
    lastRunAt: isoOrNull(row.last_run_at),
    lastTaskId: row.last_task_id === null ? null : String(row.last_task_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function createSchedule(
  conn: Conn,
  input: {
    id: string;
    orgId: string;
    userId: string;
    title: string;
    goal: string;
    kind: ScheduleKind;
    intervalMinutes?: number | null;
    hour?: number | null;
    minute?: number | null;
    timezone: string;
    enabled?: boolean;
    nextRunAt: Date;
  },
): Promise<Schedule> {
  const { rows } = await conn.query<Row>(
    `INSERT INTO schedules
       (id, org_id, user_id, title, goal, kind, interval_minutes, hour, minute, timezone, enabled, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      input.id,
      input.orgId,
      input.userId,
      input.title.slice(0, 200),
      input.goal.slice(0, 20_000),
      input.kind,
      input.intervalMinutes ?? null,
      input.hour ?? null,
      input.minute ?? null,
      input.timezone,
      input.enabled ?? true,
      input.nextRunAt,
    ],
  );
  return mapSchedule(rows[0]!);
}

export async function listSchedules(
  conn: Conn,
  orgId: string,
  userId: string,
  limit = 100,
): Promise<Schedule[]> {
  const { rows } = await conn.query<Row>(
    `SELECT * FROM schedules WHERE org_id = $1 AND user_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [orgId, userId, limit],
  );
  return rows.map(mapSchedule);
}

export async function getSchedule(
  conn: Conn,
  id: string,
  orgId: string,
  userId: string,
): Promise<Schedule | null> {
  const { rows } = await conn.query<Row>(
    "SELECT * FROM schedules WHERE id = $1 AND org_id = $2 AND user_id = $3",
    [id, orgId, userId],
  );
  return rows[0] ? mapSchedule(rows[0]) : null;
}

const SCHEDULE_COLUMNS: Record<string, string> = {
  title: "title",
  goal: "goal",
  kind: "kind",
  intervalMinutes: "interval_minutes",
  hour: "hour",
  minute: "minute",
  timezone: "timezone",
  enabled: "enabled",
  nextRunAt: "next_run_at",
  lastRunAt: "last_run_at",
  lastTaskId: "last_task_id",
};

export async function updateSchedule(
  conn: Conn,
  id: string,
  orgId: string,
  userId: string,
  patch: Record<string, unknown>,
): Promise<Schedule | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = SCHEDULE_COLUMNS[key];
    if (!column || value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length === 0) return getSchedule(conn, id, orgId, userId);
  values.push(id, orgId, userId);
  const { rows } = await conn.query<Row>(
    `UPDATE schedules SET ${sets.join(", ")}, updated_at = now()
      WHERE id = $${values.length - 2} AND org_id = $${values.length - 1} AND user_id = $${values.length}
      RETURNING *`,
    values,
  );
  return rows[0] ? mapSchedule(rows[0]) : null;
}

export async function deleteSchedule(
  conn: Conn,
  id: string,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const { rows } = await conn.query(
    "DELETE FROM schedules WHERE id = $1 AND org_id = $2 AND user_id = $3 RETURNING id",
    [id, orgId, userId],
  );
  return rows.length > 0;
}

/** Locks due schedules for one organisation so concurrent ticks cannot duplicate a run. */
export async function claimDueSchedules(
  conn: Conn,
  orgId: string,
  limit = 20,
): Promise<Schedule[]> {
  const { rows } = await conn.query<Row>(
    `SELECT * FROM schedules
      WHERE org_id = $1 AND enabled = true AND next_run_at <= now()
      ORDER BY next_run_at
      FOR UPDATE SKIP LOCKED
      LIMIT $2`,
    [orgId, limit],
  );
  return rows.map(mapSchedule);
}

/* --------------------------------------------------------- notifications */

function mapNotification(row: Row): Notification {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    kind: String(row.kind),
    title: String(row.title),
    body: row.body === null ? null : String(row.body),
    data: row.data ?? null,
    readAt: isoOrNull(row.read_at),
    createdAt: iso(row.created_at),
  };
}

export async function createNotification(
  conn: Conn,
  input: {
    orgId: string;
    userId: string;
    kind: string;
    title: string;
    body?: string | null;
    data?: unknown;
  },
): Promise<Notification> {
  const { rows } = await conn.query<Row>(
    `INSERT INTO notifications (id, org_id, user_id, kind, title, body, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`,
    [
      newId(),
      input.orgId,
      input.userId,
      input.kind,
      input.title.slice(0, 300),
      input.body?.slice(0, 2000) ?? null,
      input.data === undefined ? null : JSON.stringify(input.data),
    ],
  );
  return mapNotification(rows[0]!);
}

export async function listNotifications(
  conn: Conn,
  orgId: string,
  userId: string,
  limit = 50,
): Promise<Notification[]> {
  const { rows } = await conn.query<Row>(
    `SELECT * FROM notifications WHERE org_id = $1 AND user_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [orgId, userId, limit],
  );
  return rows.map(mapNotification);
}

export async function unreadNotificationCount(
  conn: Conn,
  orgId: string,
  userId: string,
): Promise<number> {
  const { rows } = await conn.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM notifications WHERE org_id = $1 AND user_id = $2 AND read_at IS NULL",
    [orgId, userId],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function markNotificationRead(
  conn: Conn,
  id: string,
  orgId: string,
  userId: string,
): Promise<Notification | null> {
  const { rows } = await conn.query<Row>(
    `UPDATE notifications SET read_at = COALESCE(read_at, now())
      WHERE id = $1 AND org_id = $2 AND user_id = $3 RETURNING *`,
    [id, orgId, userId],
  );
  return rows[0] ? mapNotification(rows[0]) : null;
}

export async function markAllNotificationsRead(
  conn: Conn,
  orgId: string,
  userId: string,
): Promise<number> {
  const { rows } = await conn.query<{ id: string }>(
    "UPDATE notifications SET read_at = now() WHERE org_id = $1 AND user_id = $2 AND read_at IS NULL RETURNING id",
    [orgId, userId],
  );
  return rows.length;
}

export async function listMemories(
  conn: Conn,
  orgId: string,
  userId: string,
  limit = 200,
): Promise<Memory[]> {
  const { rows } = await conn.query<Row>(
    `SELECT * FROM memories WHERE org_id = $1 AND user_id = $2
      ORDER BY updated_at DESC LIMIT $3`,
    [orgId, userId, limit],
  );
  return rows.map(mapMemory);
}

export async function deleteMemory(conn: Conn, id: string, userId: string): Promise<boolean> {
  const result = await conn.query(
    "DELETE FROM memories WHERE id = $1 AND user_id = $2 RETURNING id",
    [id, userId],
  );
  return result.rows.length > 0;
}

/* ------------------------------------------------------------------ audit */

export async function recordAudit(
  conn: Conn,
  input: {
    orgId: string;
    actorUserId: string | null;
    eventType: string;
    targetType: string;
    targetId?: string | null;
    payload?: unknown;
  },
): Promise<void> {
  await conn.query(
    `INSERT INTO audit_events (id, org_id, actor_user_id, event_type, target_type, target_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      newId(),
      input.orgId,
      input.actorUserId,
      input.eventType,
      input.targetType,
      input.targetId ?? null,
      input.payload === undefined ? null : JSON.stringify(input.payload),
    ],
  );
}

export async function listArtifactsForUser(
  conn: Conn,
  userId: string,
  limit = 100,
): Promise<Artifact[]> {
  const { rows } = await conn.query<Row>(
    "SELECT * FROM artifacts WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
    [userId, limit],
  );
  return rows.map(mapArtifact);
}

/* --------------------------------------------------------------- approvals */

export interface ApprovalWithTask extends Approval {
  taskTitle: string;
}

export async function listApprovalsForUser(
  conn: Conn,
  userId: string,
  status: ApprovalStatus | "all" = "pending",
  limit = 100,
): Promise<ApprovalWithTask[]> {
  const { rows } = await conn.query<Row>(
    `SELECT a.*, t.title AS task_title
       FROM approvals a
       JOIN tasks t ON t.id = a.task_id
      WHERE t.user_id = $1 AND ($2 = 'all' OR a.status = $2)
      ORDER BY a.created_at DESC LIMIT $3`,
    [userId, status, limit],
  );
  return rows.map((row) => ({ ...mapApproval(row), taskTitle: String(row.task_title) }));
}

/* ------------------------------------------------------------------ audit */

export interface AuditEntry {
  id: string;
  actorUserId: string | null;
  eventType: string;
  targetType: string;
  targetId: string | null;
  payload: unknown;
  createdAt: string;
}

export async function listAuditEvents(
  conn: Conn,
  orgId: string,
  limit = 100,
): Promise<AuditEntry[]> {
  const { rows } = await conn.query<Row>(
    `SELECT id, actor_user_id, event_type, target_type, target_id, payload, created_at
       FROM audit_events WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [orgId, limit],
  );
  return rows.map((row) => ({
    id: String(row.id),
    actorUserId: row.actor_user_id === null ? null : String(row.actor_user_id),
    eventType: String(row.event_type),
    targetType: String(row.target_type),
    targetId: row.target_id === null ? null : String(row.target_id),
    payload: row.payload ?? null,
    createdAt: iso(row.created_at),
  }));
}

/* ---------------------------------------------------------------- members */

export interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  createdAt: string;
}

export async function listMembers(conn: Conn, orgId: string): Promise<Member[]> {
  const { rows } = await conn.query<Row>(
    `SELECT m.user_id, u.email, u.name, m.role, m.created_at
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 ORDER BY m.created_at`,
    [orgId],
  );
  return rows.map((row) => ({
    userId: String(row.user_id),
    email: String(row.email),
    name: row.name === null ? null : String(row.name),
    role: String(row.role) as Role,
    createdAt: iso(row.created_at),
  }));
}

/* ------------------------------------------------------------ credentials */

export async function putCredential(
  conn: Conn,
  input: {
    orgId: string;
    provider: string;
    label: string;
    ciphertext: string;
    iv: string;
    tag: string;
  },
): Promise<void> {
  await conn.query(
    `INSERT INTO provider_credentials (id, org_id, provider, label, ciphertext, iv, tag)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (org_id, provider, label) DO UPDATE
       SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag`,
    [newId(), input.orgId, input.provider, input.label, input.ciphertext, input.iv, input.tag],
  );
}

export async function getCredential(
  conn: Conn,
  orgId: string,
  provider: string,
  label: string,
): Promise<{ ciphertext: string; iv: string; tag: string } | null> {
  const { rows } = await conn.query<Row>(
    `SELECT ciphertext, iv, tag FROM provider_credentials
      WHERE org_id = $1 AND provider = $2 AND label = $3`,
    [orgId, provider, label],
  );
  const row = rows[0];
  return row
    ? { ciphertext: String(row.ciphertext), iv: String(row.iv), tag: String(row.tag) }
    : null;
}

export async function hasCredential(
  conn: Conn,
  orgId: string,
  provider: string,
  label: string,
): Promise<boolean> {
  const { rows } = await conn.query(
    "SELECT 1 FROM provider_credentials WHERE org_id = $1 AND provider = $2 AND label = $3",
    [orgId, provider, label],
  );
  return rows.length > 0;
}

export async function deleteCredential(
  conn: Conn,
  orgId: string,
  provider: string,
  label: string,
): Promise<boolean> {
  const { rows } = await conn.query(
    `DELETE FROM provider_credentials
      WHERE org_id = $1 AND provider = $2 AND label = $3
      RETURNING id`,
    [orgId, provider, label],
  );
  return rows.length > 0;
}

/* --------------------------------------------------------------- planning */

export function planSteps(plan: TaskPlan): PlanStep[] {
  return plan.steps;
}
