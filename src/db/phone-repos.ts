import type { Conn } from "./database.js";
import type { CommandStatus, PhonePlatform } from "../phone/protocol.js";

type Row = Record<string, unknown>;

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);
const isoOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : iso(value);
const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
const objectOrEmpty = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export interface PhonePairingCode {
  id: string;
  codeHash: string;
  orgId: string;
  userId: string;
  platform: PhonePlatform;
  name: string;
  expiresAt: string;
}

export interface PhoneDevice {
  id: string;
  orgId: string;
  userId: string;
  name: string;
  platform: PhonePlatform;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  tokenHash: string;
  status: "active" | "paused" | "revoked";
  capabilities: Record<string, unknown>;
  settings: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface PhoneApproval {
  id: string;
  orgId: string;
  userId: string;
  deviceId: string;
  op: "act" | "flow";
  args: Record<string, unknown>;
  argsHash: string;
  summary: string;
  status: "pending" | "approved" | "denied" | "expired";
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface PhoneCommand {
  id: string;
  orgId: string;
  userId: string;
  deviceId: string;
  runId: string | null;
  stepId: string | null;
  approvalId: string | null;
  idempotencyKey: string;
  op: string;
  args: Record<string, unknown>;
  argsHash: string | null;
  status: CommandStatus;
  expiresAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  result: unknown;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

function mapPairing(row: Row): PhonePairingCode {
  return {
    id: String(row.id),
    codeHash: String(row.code_hash),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    platform: row.platform as PhonePlatform,
    name: String(row.name),
    expiresAt: iso(row.expires_at),
  };
}

function mapDevice(row: Row): PhoneDevice {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    name: String(row.name),
    platform: row.platform as PhonePlatform,
    model: row.model === null || row.model === undefined ? null : String(row.model),
    osVersion:
      row.os_version === null || row.os_version === undefined ? null : String(row.os_version),
    appVersion:
      row.app_version === null || row.app_version === undefined ? null : String(row.app_version),
    tokenHash: String(row.token_hash),
    status: row.status as PhoneDevice["status"],
    capabilities: objectOrEmpty(row.capabilities),
    settings: objectOrEmpty(row.settings),
    diagnostics: objectOrEmpty(row.diagnostics),
    lastSeenAt: isoOrNull(row.last_seen_at),
    createdAt: iso(row.created_at),
    revokedAt: isoOrNull(row.revoked_at),
  };
}

function mapApproval(row: Row): PhoneApproval {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    deviceId: String(row.device_id),
    op: row.op as PhoneApproval["op"],
    args: objectOrEmpty(row.args),
    argsHash: String(row.args_hash),
    summary: String(row.summary),
    status: row.status as PhoneApproval["status"],
    decidedAt: isoOrNull(row.decided_at),
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
  };
}

function mapCommand(row: Row): PhoneCommand {
  const approvalId =
    row.phone_approval_id ?? row.approval_id;
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    deviceId: String(row.device_id),
    runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    stepId: row.step_id === null || row.step_id === undefined ? null : String(row.step_id),
    approvalId:
      approvalId === null || approvalId === undefined ? null : String(approvalId),
    idempotencyKey: String(row.idempotency_key),
    op: String(row.op),
    args: objectOrEmpty(row.args),
    argsHash: row.args_hash === null || row.args_hash === undefined ? null : String(row.args_hash),
    status: row.status as CommandStatus,
    expiresAt: iso(row.expires_at),
    claimedAt: isoOrNull(row.claimed_at),
    completedAt: isoOrNull(row.completed_at),
    result: row.result ?? null,
    error: row.error === null || row.error === undefined ? null : String(row.error),
    durationMs: numOrNull(row.duration_ms),
    createdAt: iso(row.created_at),
  };
}

/* --------------------------------------------------------------- pairing */

export async function insertPairingCode(
  conn: Conn,
  input: {
    id: string;
    codeHash: string;
    orgId: string;
    userId: string;
    platform: PhonePlatform;
    name: string;
    expiresAt: Date;
  },
): Promise<void> {
  await conn.query(
    `INSERT INTO phone_pairing_codes
       (id, code_hash, org_id, user_id, platform, name, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.id,
      input.codeHash,
      input.orgId,
      input.userId,
      input.platform,
      input.name,
      input.expiresAt,
    ],
  );
}

/**
 * Claims a code exactly once. Expired or already-claimed codes return null; the
 * caller must not be able to tell which, so a probe cannot be used as an oracle.
 */
export async function claimPairingCode(conn: Conn, codeHash: string): Promise<PhonePairingCode | null> {
  const { rows } = await conn.query<Row>(
    `UPDATE phone_pairing_codes
        SET claimed_at = now(), attempts = attempts + 1
      WHERE code_hash = $1
        AND claimed_at IS NULL
        AND expires_at > now()
        AND attempts < 5
      RETURNING *`,
    [codeHash],
  );
  return rows[0] ? mapPairing(rows[0]) : null;
}

/* --------------------------------------------------------------- devices */

export async function createDevice(
  conn: Conn,
  input: {
    id: string;
    orgId: string;
    userId: string;
    name: string;
    platform: PhonePlatform;
    model?: string | null;
    osVersion?: string | null;
    appVersion?: string | null;
    tokenHash: string;
    capabilities?: Record<string, unknown>;
    settings?: Record<string, unknown>;
  },
): Promise<PhoneDevice> {
  const { rows } = await conn.query<Row>(
    `INSERT INTO phone_devices
       (id, org_id, user_id, name, platform, model, os_version, app_version, token_hash,
        capabilities, settings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
     RETURNING *`,
    [
      input.id,
      input.orgId,
      input.userId,
      input.name,
      input.platform,
      input.model ?? null,
      input.osVersion ?? null,
      input.appVersion ?? null,
      input.tokenHash,
      JSON.stringify(input.capabilities ?? {}),
      JSON.stringify(input.settings ?? { allow_all: true, screenshots: true }),
    ],
  );
  return mapDevice(rows[0]!);
}

export async function getDeviceById(conn: Conn, id: string): Promise<PhoneDevice | null> {
  const { rows } = await conn.query<Row>("SELECT * FROM phone_devices WHERE id = $1", [id]);
  return rows[0] ? mapDevice(rows[0]) : null;
}

export async function listDevices(
  conn: Conn,
  orgId: string,
  userId: string,
): Promise<PhoneDevice[]> {
  const { rows } = await conn.query<Row>(
    `SELECT * FROM phone_devices
      WHERE org_id = $1 AND user_id = $2
      ORDER BY created_at DESC`,
    [orgId, userId],
  );
  return rows.map(mapDevice);
}

export async function updateDevice(
  conn: Conn,
  id: string,
  orgId: string,
  userId: string,
  patch: {
    status?: PhoneDevice["status"];
    tokenHash?: string;
    appVersion?: string | null;
    model?: string | null;
    osVersion?: string | null;
    capabilities?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    diagnostics?: Record<string, unknown>;
    revokedAt?: Date | null;
  },
): Promise<PhoneDevice | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (column: string, value: unknown, cast = "") => {
    values.push(value);
    sets.push(`${column} = $${values.length}${cast}`);
  };
  if (patch.status !== undefined) push("status", patch.status);
  if (patch.tokenHash !== undefined) push("token_hash", patch.tokenHash);
  if (patch.appVersion !== undefined) push("app_version", patch.appVersion);
  if (patch.model !== undefined) push("model", patch.model);
  if (patch.osVersion !== undefined) push("os_version", patch.osVersion);
  if (patch.capabilities !== undefined)
    push("capabilities", JSON.stringify(patch.capabilities), "::jsonb");
  if (patch.settings !== undefined) push("settings", JSON.stringify(patch.settings), "::jsonb");
  if (patch.diagnostics !== undefined)
    push("diagnostics", JSON.stringify(patch.diagnostics), "::jsonb");
  if (patch.revokedAt !== undefined) push("revoked_at", patch.revokedAt);
  if (sets.length === 0) return getDeviceById(conn, id);
  values.push(id, orgId, userId);
  const { rows } = await conn.query<Row>(
    `UPDATE phone_devices SET ${sets.join(", ")}
      WHERE id = $${values.length - 2} AND org_id = $${values.length - 1} AND user_id = $${values.length}
      RETURNING *`,
    values,
  );
  return rows[0] ? mapDevice(rows[0]) : null;
}

/** Presence is written at most every 30 seconds, not on every long-poll. */
export async function touchDevice(conn: Conn, id: string): Promise<void> {
  await conn.query(
    `UPDATE phone_devices SET last_seen_at = now()
      WHERE id = $1
        AND (last_seen_at IS NULL OR last_seen_at < now() - interval '30 seconds')`,
    [id],
  );
}

/* ------------------------------------------------------------- approvals */

export async function createPhoneApproval(
  conn: Conn,
  input: {
    id: string;
    orgId: string;
    userId: string;
    deviceId: string;
    op: "act" | "flow";
    args: Record<string, unknown>;
    argsHash: string;
    summary: string;
    expiresAt: Date;
  },
): Promise<PhoneApproval> {
  const { rows } = await conn.query<Row>(
    `INSERT INTO phone_approvals
       (id, org_id, user_id, device_id, op, args, args_hash, summary, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     RETURNING *`,
    [
      input.id,
      input.orgId,
      input.userId,
      input.deviceId,
      input.op,
      JSON.stringify(input.args),
      input.argsHash,
      input.summary,
      input.expiresAt,
    ],
  );
  return mapApproval(rows[0]!);
}

export async function getPhoneApproval(
  conn: Conn,
  id: string,
  orgId: string,
  userId: string,
): Promise<PhoneApproval | null> {
  const { rows } = await conn.query<Row>(
    "SELECT * FROM phone_approvals WHERE id = $1 AND org_id = $2 AND user_id = $3",
    [id, orgId, userId],
  );
  return rows[0] ? mapApproval(rows[0]) : null;
}

export async function listPhoneApprovals(
  conn: Conn,
  orgId: string,
  userId: string,
  status: PhoneApproval["status"] | "all" = "pending",
  limit = 50,
): Promise<PhoneApproval[]> {
  await conn.query(
    "UPDATE phone_approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= now()",
  );
  const bounded = Math.max(1, Math.min(limit, 100));
  const { rows } =
    status === "all"
      ? await conn.query<Row>(
          `SELECT * FROM phone_approvals
            WHERE org_id = $1 AND user_id = $2
            ORDER BY created_at DESC LIMIT $3`,
          [orgId, userId, bounded],
        )
      : await conn.query<Row>(
          `SELECT * FROM phone_approvals
            WHERE org_id = $1 AND user_id = $2 AND status = $3
            ORDER BY created_at DESC LIMIT $4`,
          [orgId, userId, status, bounded],
        );
  return rows.map(mapApproval);
}

/** Only a pending, unexpired request can be decided. */
export async function decidePhoneApproval(
  conn: Conn,
  id: string,
  orgId: string,
  userId: string,
  decision: "approved" | "denied",
): Promise<PhoneApproval | null> {
  const { rows } = await conn.query<Row>(
    `UPDATE phone_approvals
        SET status = $4, decided_at = now()
      WHERE id = $1 AND org_id = $2 AND user_id = $3
        AND status = 'pending' AND expires_at > now()
      RETURNING *`,
    [id, orgId, userId, decision],
  );
  return rows[0] ? mapApproval(rows[0]) : null;
}

/** Pausing or revoking a phone must also kill its pending action requests. */
export async function cancelPhoneApprovals(
  conn: Conn,
  deviceId: string,
): Promise<number> {
  const { rows } = await conn.query<Row>(
    `UPDATE phone_approvals SET status = 'expired'
      WHERE device_id = $1 AND status = 'pending'
      RETURNING id`,
    [deviceId],
  );
  return rows.length;
}

/* -------------------------------------------------------------- commands */

export async function enqueueCommand(
  conn: Conn,
  input: {
    id: string;
    orgId: string;
    userId: string;
    deviceId: string;
    runId?: string | null;
    stepId?: string | null;
    approvalId?: string | null;
    phoneApprovalId?: string | null;
    idempotencyKey: string;
    op: string;
    args: Record<string, unknown>;
    argsHash?: string | null;
    expiresAt: Date;
  },
): Promise<PhoneCommand> {
  const { rows } = await conn.query<Row>(
    `INSERT INTO phone_commands
       (id, org_id, user_id, device_id, run_id, step_id, approval_id, phone_approval_id,
        idempotency_key, op, args, args_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
     ON CONFLICT (device_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [
      input.id,
      input.orgId,
      input.userId,
      input.deviceId,
      input.runId ?? null,
      input.stepId ?? null,
      input.approvalId ?? null,
      input.phoneApprovalId ?? null,
      input.idempotencyKey,
      input.op,
      JSON.stringify(input.args),
      input.argsHash ?? null,
      input.expiresAt,
    ],
  );
  if (rows[0]) return mapCommand(rows[0]);
  const existing = await conn.query<Row>(
    `SELECT * FROM phone_commands WHERE device_id = $1 AND idempotency_key = $2`,
    [input.deviceId, input.idempotencyKey],
  );
  if (!existing.rows[0]) throw new Error("Command insert conflicted but no row exists");
  return mapCommand(existing.rows[0]);
}

export async function getCommand(
  conn: Conn,
  id: string,
  deviceId?: string,
): Promise<PhoneCommand | null> {
  const { rows } = deviceId
    ? await conn.query<Row>("SELECT * FROM phone_commands WHERE id = $1 AND device_id = $2", [
        id,
        deviceId,
      ])
    : await conn.query<Row>("SELECT * FROM phone_commands WHERE id = $1", [id]);
  return rows[0] ? mapCommand(rows[0]) : null;
}

/**
 * Claims the oldest live command with SKIP LOCKED. A transaction is short and
 * contains no device I/O, so two serverless invocations cannot double-claim.
 */
export async function claimCommand(conn: Conn, deviceId: string): Promise<PhoneCommand | null> {
  await conn.query(
    `UPDATE phone_commands SET status = 'expired'
      WHERE device_id = $1 AND status = 'queued' AND expires_at <= now()`,
    [deviceId],
  );
  const { rows } = await conn.query<Row>(
    `UPDATE phone_commands
        SET status = 'claimed', claimed_at = now()
      WHERE id = (
        SELECT id FROM phone_commands
         WHERE device_id = $1 AND status = 'queued' AND expires_at > now()
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING *`,
    [deviceId],
  );
  return rows[0] ? mapCommand(rows[0]) : null;
}

export async function completeCommand(
  conn: Conn,
  deviceId: string,
  commandId: string,
  input: {
    status: "done" | "error";
    result: unknown;
    error: string | null;
    durationMs: number | null;
  },
): Promise<{ updated: boolean; command: PhoneCommand | null }> {
  const { rows } = await conn.query<Row>(
    `UPDATE phone_commands
        SET status = $3, result = $4::jsonb, error = $5,
            duration_ms = $6, completed_at = now()
      WHERE id = $1 AND device_id = $2 AND status = 'claimed'
      RETURNING *`,
    [
      commandId,
      deviceId,
      input.status,
      input.result === undefined ? null : JSON.stringify(input.result),
      input.error,
      input.durationMs,
    ],
  );
  if (rows[0]) {
    // Live view produces one observe every few seconds. Keep recent results for
    // the waiting request, but do not let read-only rows grow without bound.
    await conn.query(
      `DELETE FROM phone_commands
        WHERE device_id = $1 AND op = 'observe'
          AND status IN ('done', 'error', 'expired', 'cancelled')
          AND COALESCE(completed_at, created_at) < now() - interval '10 minutes'`,
      [deviceId],
    );
    return { updated: true, command: mapCommand(rows[0]) };
  }
  return { updated: false, command: await getCommand(conn, commandId, deviceId) };
}

export async function cancelQueuedCommands(conn: Conn, deviceId: string): Promise<number> {
  const { rows } = await conn.query<Row>(
    `UPDATE phone_commands SET status = 'cancelled'
      WHERE device_id = $1 AND status = 'queued'
      RETURNING id`,
    [deviceId],
  );
  return rows.length;
}

/* ---------------------------------------------------------------- frames */

export async function putFrame(
  conn: Conn,
  input: {
    deviceId: string;
    orgId: string;
    userId: string;
    seq: number;
    jpeg: Uint8Array;
    width?: number | null;
    height?: number | null;
  },
): Promise<void> {
  await conn.query(
    `INSERT INTO phone_frames (device_id, org_id, user_id, seq, jpeg, width, height, captured_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (device_id) DO UPDATE
       SET org_id = EXCLUDED.org_id,
           user_id = EXCLUDED.user_id,
           seq = EXCLUDED.seq,
           jpeg = EXCLUDED.jpeg,
           width = EXCLUDED.width,
           height = EXCLUDED.height,
           captured_at = now()
      WHERE phone_frames.seq < EXCLUDED.seq`,
    [input.deviceId, input.orgId, input.userId, input.seq, input.jpeg, input.width ?? null, input.height ?? null],
  );
}

export async function getFrame(
  conn: Conn,
  deviceId: string,
): Promise<{ seq: string; jpeg: Buffer; width: number | null; height: number | null; capturedAt: string } | null> {
  const { rows } = await conn.query<Row>(
    "SELECT seq, jpeg, width, height, captured_at FROM phone_frames WHERE device_id = $1",
    [deviceId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    seq: String(row.seq),
    jpeg: Buffer.from(row.jpeg as Uint8Array),
    width: numOrNull(row.width),
    height: numOrNull(row.height),
    capturedAt: iso(row.captured_at),
  };
}

export async function deleteExpiredPairingCodes(conn: Conn): Promise<void> {
  await conn.query(
    "DELETE FROM phone_pairing_codes WHERE expires_at < now() - interval '1 day'",
  );
}
