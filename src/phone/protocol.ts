import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Protocol v1 shared with the Android companion.
 *
 * The companion is intentionally dumb: it claims one command at a time and
 * returns one result. Everything security-sensitive (pairing, expiry, approval
 * binding) happens here, where it can be tested without an emulator.
 */

export const PHONE_PLATFORMS = ["android", "ios", "bridge"] as const;
export type PhonePlatform = (typeof PHONE_PLATFORMS)[number];

export const COMPANION_OPS = ["observe", "act", "flow", "apps", "status"] as const;
export type CompanionOp = (typeof COMPANION_OPS)[number];

export const COMMAND_STATUSES = [
  "queued",
  "claimed",
  "done",
  "error",
  "expired",
  "cancelled",
] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

export const PROTOCOL_VERSION = 1;
export const MIN_APP_VERSION = "0.1.0";
export const PAIRING_TTL_MS = 5 * 60_000;
export const COMMAND_TTL_MS = 60_000;
export const MAX_FRAME_BYTES = 300 * 1024;

const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function isPhonePlatform(value: unknown): value is PhonePlatform {
  return typeof value === "string" && (PHONE_PLATFORMS as readonly string[]).includes(value);
}

export function isCompanionOp(value: string): value is CompanionOp {
  return (COMPANION_OPS as readonly string[]).includes(value);
}

/** Eight characters from an alphabet without 0/O or 1/I. */
export function newPairingCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Accepts lower case and the display hyphen; rejects anything else. */
export function normalizePairingCode(raw: string): string | null {
  const compact = raw.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(compact)) return null;
  return compact;
}

export function hashPairingCode(raw: string): string {
  const normalized = normalizePairingCode(raw);
  if (!normalized) throw new Error("Invalid pairing code");
  return createHash("sha256").update(`pair:${normalized}`).digest("hex");
}

export function newDeviceId(): string {
  return randomBytes(16).toString("hex");
}

export function hashDeviceSecret(secret: string): string {
  return createHash("sha256").update(`device:${secret}`).digest("hex");
}

/** The token returned to the phone exactly once. */
export function issueDeviceToken(deviceId: string): { token: string; tokenHash: string } {
  const secret = randomBytes(32).toString("base64url");
  return {
    token: `${deviceId}.${secret}`,
    tokenHash: hashDeviceSecret(secret),
  };
}

export function parseDeviceToken(raw: string | undefined): { deviceId: string; secret: string } | null {
  if (!raw) return null;
  const value = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw.trim();
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const deviceId = value.slice(0, dot);
  const secret = value.slice(dot + 1);
  if (!/^[a-f0-9]{32}$/.test(deviceId) || secret.length < 32) return null;
  return { deviceId, secret };
}

export function secretsMatch(storedHash: string, secret: string): boolean {
  const given = Buffer.from(hashDeviceSecret(secret), "hex");
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHash, "hex");
  } catch {
    return false;
  }
  return stored.length === given.length && timingSafeEqual(stored, given);
}

/** Stable JSON: object keys sorted at every depth, so args hashes are portable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function hashArgs(args: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(args)).digest("hex")}`;
}

export function publicCommand(row: {
  id: string;
  op: string;
  args: unknown;
  runId: string | null;
  stepId: string | null;
  approvalId: string | null;
  argsHash: string | null;
  expiresAt: string;
}): Record<string, unknown> {
  return {
    id: row.id,
    op: row.op,
    args: row.args,
    run_id: row.runId,
    step_id: row.stepId,
    approval_id: row.approvalId,
    args_hash: row.argsHash,
    expires_at: row.expiresAt,
  };
}
