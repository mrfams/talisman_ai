import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.js";
import {
  cancelQueuedCommands,
  claimCommand,
  claimPairingCode,
  completeCommand,
  createDevice,
  enqueueCommand,
  getCommand,
  getDeviceById,
  getFrame,
  insertPairingCode,
  listDevices,
  putFrame,
  touchDevice,
  updateDevice,
  type PhoneCommand,
  type PhoneDevice,
} from "../db/phone-repos.js";
import { errors } from "../core/errors.js";
import { newId } from "../core/ids.js";
import {
  COMMAND_TTL_MS,
  PAIRING_TTL_MS,
  hashArgs,
  hashPairingCode,
  isCompanionOp,
  isPhonePlatform,
  issueDeviceToken,
  newDeviceId,
  newPairingCode,
  normalizePairingCode,
  parseDeviceToken,
  secretsMatch,
  type CompanionOp,
  type PhonePlatform,
} from "./protocol.js";

export interface PairingStart {
  code: string;
  expiresAt: string;
  qr: string;
  server: string;
}

export interface PairingClaim {
  deviceId: string;
  token: string;
  name: string;
  platform: PhonePlatform;
}

export interface PublicPhoneDevice {
  id: string;
  name: string;
  platform: PhonePlatform;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  status: PhoneDevice["status"];
  capabilities: Record<string, unknown>;
  settings: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  lastSeenAt: string | null;
  createdAt: string;
  online: boolean;
}

const ONLINE_WINDOW_MS = 90_000;

export function publicDevice(device: PhoneDevice): PublicPhoneDevice {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    model: device.model,
    osVersion: device.osVersion,
    appVersion: device.appVersion,
    status: device.status,
    capabilities: device.capabilities,
    settings: device.settings,
    diagnostics: device.diagnostics,
    lastSeenAt: device.lastSeenAt,
    createdAt: device.createdAt,
    online:
      device.status === "active" &&
      device.lastSeenAt !== null &&
      Date.now() - new Date(device.lastSeenAt).getTime() < ONLINE_WINDOW_MS,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Owns the phone queue. The device only ever sees commands for itself, and only
 * while its token is live; browser actions always go through the tenant context.
 */
export class PhoneService {
  constructor(
    private readonly database: Database,
    private readonly publicUrl: string,
  ) {}

  async startPairing(
    orgId: string,
    userId: string,
    input: { platform: string; name: string },
  ): Promise<PairingStart> {
    if (!isPhonePlatform(input.platform)) throw errors.invalid("Unsupported phone platform");
    const name = input.name.trim().slice(0, 80);
    if (!name) throw errors.invalid("Give the phone a name");

    const code = newPairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await insertPairingCode(this.database.driver, {
      id: newId(),
      codeHash: hashPairingCode(code),
      orgId,
      userId,
      platform: input.platform,
      name,
      expiresAt,
    });
    const server = this.publicUrl.replace(/\/$/, "");
    return {
      code,
      expiresAt: expiresAt.toISOString(),
      // The app scans this, checks the host against the QR payload, and reads
      // the code from the fragment. Fragments never reach an HTTP server log.
      qr: `${server}/phone/pair#code=${encodeURIComponent(code)}`,
      server,
    };
  }

  async claimPairing(input: {
    code: string;
    platform: string;
    model?: string;
    osVersion?: string;
    appVersion?: string;
    capabilities?: Record<string, unknown>;
  }): Promise<PairingClaim> {
    if (!isPhonePlatform(input.platform)) throw errors.invalid("Unsupported phone platform");
    const normalized = normalizePairingCode(input.code);
    if (!normalized) throw errors.invalid("That pairing code is not valid");
    const codeHash = hashPairingCode(normalized);

    const claimed = await this.database.driver.transaction(async (conn) => {
      const pairing = await claimPairingCode(conn, codeHash);
      if (!pairing) return null;
      if (pairing.platform !== input.platform) {
        throw errors.invalid("This code was created for a different platform");
      }
      const deviceId = newDeviceId();
      const { token, tokenHash } = issueDeviceToken(deviceId);
      const device = await createDevice(conn, {
        id: deviceId,
        orgId: pairing.orgId,
        userId: pairing.userId,
        name: pairing.name,
        platform: pairing.platform,
        model: input.model?.trim().slice(0, 80) || null,
        osVersion: input.osVersion?.trim().slice(0, 40) || null,
        appVersion: input.appVersion?.trim().slice(0, 40) || null,
        tokenHash,
        capabilities:
          input.capabilities && typeof input.capabilities === "object"
            ? input.capabilities
            : {},
      });
      return { device, token };
    });

    if (!claimed) throw errors.invalid("That pairing code is invalid or has expired");
    return {
      deviceId: claimed.device.id,
      token: claimed.token,
      name: claimed.device.name,
      platform: claimed.device.platform,
    };
  }

  /** Returns null for a missing, revoked, or forged token. */
  async authenticate(authorization: string | undefined): Promise<PhoneDevice | null> {
    const parsed = parseDeviceToken(authorization);
    if (!parsed) return null;
    const device = await getDeviceById(this.database.driver, parsed.deviceId);
    if (!device || device.status === "revoked") return null;
    if (!secretsMatch(device.tokenHash, parsed.secret)) return null;
    return device;
  }

  async activeDevice(orgId: string, userId: string): Promise<PhoneDevice | null> {
    const devices = await this.list(orgId, userId);
    return devices.find((device) => device.status === "active") ?? null;
  }

  async list(orgId: string, userId: string): Promise<PhoneDevice[]> {
    return this.database.withTenant(orgId, userId, (conn) =>
      listDevices(conn, orgId, userId),
    );
  }

  async get(orgId: string, userId: string, deviceId: string): Promise<PhoneDevice> {
    const device = await this.database.withTenant(orgId, userId, (conn) =>
      getDeviceById(conn, deviceId),
    );
    if (!device || device.orgId !== orgId || device.userId !== userId) {
      throw errors.notFound("Phone not found");
    }
    return device;
  }

  async pause(
    orgId: string,
    userId: string,
    deviceId: string,
  ): Promise<{ device: PhoneDevice; cancelled: number }> {
    const device = await this.get(orgId, userId, deviceId);
    if (device.status === "revoked") throw errors.conflict("This phone has been revoked");
    const result = await this.database.withTenant(orgId, userId, async (conn) => {
      const updated = await updateDevice(conn, deviceId, orgId, userId, { status: "paused" });
      const cancelled = await cancelQueuedCommands(conn, deviceId);
      return { updated, cancelled };
    });
    if (!result.updated) throw errors.notFound("Phone not found");
    return { device: result.updated, cancelled: result.cancelled };
  }

  async resume(orgId: string, userId: string, deviceId: string): Promise<PhoneDevice> {
    return this.database.withTenant(orgId, userId, async (conn) => {
      const updated = await updateDevice(conn, deviceId, orgId, userId, { status: "active" });
      if (!updated) throw errors.notFound("Phone not found");
      if (updated.revokedAt) throw errors.conflict("This phone has been revoked");
      return updated;
    });
  }

  async revoke(
    orgId: string,
    userId: string,
    deviceId: string,
  ): Promise<{ device: PhoneDevice; cancelled: number }> {
    await this.get(orgId, userId, deviceId);
    const result = await this.database.withTenant(orgId, userId, async (conn) => {
      // A fresh token hash that was never issued makes the old token unusable
      // even if a later bug accidentally skips the status check.
      const updated = await updateDevice(conn, deviceId, orgId, userId, {
        status: "revoked",
        tokenHash: issueDeviceToken(deviceId).tokenHash,
        revokedAt: new Date(),
      });
      const cancelled = await cancelQueuedCommands(conn, deviceId);
      return { updated, cancelled };
    });
    if (!result.updated) throw errors.notFound("Phone not found");
    return { device: result.updated, cancelled: result.cancelled };
  }

  async rotateToken(
    orgId: string,
    userId: string,
    deviceId: string,
  ): Promise<{ token: string; device: PhoneDevice }> {
    await this.get(orgId, userId, deviceId);
    const { token, tokenHash } = issueDeviceToken(deviceId);
    const updated = await this.database.withTenant(orgId, userId, (conn) =>
      updateDevice(conn, deviceId, orgId, userId, { tokenHash }),
    );
    if (!updated) throw errors.notFound("Phone not found");
    return { token, device: updated };
  }

  async updateSettings(
    orgId: string,
    userId: string,
    deviceId: string,
    settings: Record<string, unknown>,
  ): Promise<PhoneDevice> {
    if (JSON.stringify(settings).length > 16_000) throw errors.invalid("Settings are too large");
    const updated = await this.database.withTenant(orgId, userId, (conn) =>
      updateDevice(conn, deviceId, orgId, userId, { settings }),
    );
    if (!updated) throw errors.notFound("Phone not found");
    return updated;
  }

  async enqueue(
    device: PhoneDevice,
    input: {
      op: CompanionOp;
      args?: Record<string, unknown>;
      runId?: string | null;
      stepId?: string | null;
      approvalId?: string | null;
      idempotencyKey?: string;
      ttlMs?: number;
    },
  ): Promise<PhoneCommand> {
    if (device.status !== "active") {
      throw errors.conflict(
        device.status === "revoked"
          ? "This phone has been revoked"
          : "This phone is paused. Resume it first.",
      );
    }
    if (!isCompanionOp(input.op)) throw errors.invalid(`Unsupported phone op: ${input.op}`);
    const args =
      input.args && typeof input.args === "object" && !Array.isArray(input.args)
        ? input.args
        : {};
    if (JSON.stringify(args).length > 32_000) throw errors.invalid("Phone command is too large");
    const ttl = Math.max(5_000, Math.min(input.ttlMs ?? COMMAND_TTL_MS, 5 * 60_000));
    const idempotencyKey = (input.idempotencyKey ?? randomUUID()).slice(0, 128);
    if (!idempotencyKey) throw errors.invalid("idempotencyKey is required");

    return this.database.withTenant(device.orgId, device.userId, (conn) =>
      enqueueCommand(conn, {
        id: newId(),
        orgId: device.orgId,
        userId: device.userId,
        deviceId: device.id,
        runId: input.runId ?? null,
        stepId: input.stepId ?? null,
        approvalId: input.approvalId ?? null,
        idempotencyKey,
        op: input.op,
        args,
        argsHash: hashArgs(args),
        expiresAt: new Date(Date.now() + ttl),
      }),
    );
  }

  /** Long-poll: one indexed claim per second, then a clean 204 to the device. */
  async poll(device: PhoneDevice, waitMs: number, signal?: AbortSignal): Promise<PhoneCommand | null> {
    if (device.status !== "active") return null;
    await this.database.driver
      .transaction((conn) => touchDevice(conn, device.id))
      .catch(() => undefined);

    const deadline = Date.now() + Math.max(0, Math.min(waitMs, 25_000));
    for (;;) {
      const claimed = await this.database.withTenant(device.orgId, device.userId, (conn) =>
        claimCommand(conn, device.id),
      );
      if (claimed) {
        await this.database.driver
          .transaction((conn) => touchDevice(conn, device.id))
          .catch(() => undefined);
        return claimed;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal?.aborted) return null;
      await sleep(Math.min(750, remaining));
    }
  }

  async complete(
    device: PhoneDevice,
    input: {
      commandId: string;
      status: "done" | "error";
      result: unknown;
      error: string | null;
      durationMs: number | null;
    },
  ): Promise<{ updated: boolean; status: string | null }> {
    const outcome = await this.database.withTenant(device.orgId, device.userId, (conn) =>
      completeCommand(conn, device.id, input.commandId, input),
    );
    if (outcome.updated) return { updated: true, status: input.status };
    if (!outcome.command) throw errors.notFound("Command not found");
    // A retry after a lost response is success, not an error.
    if (outcome.command.status === input.status) {
      return { updated: false, status: outcome.command.status };
    }
    return { updated: false, status: outcome.command.status };
  }

  async heartbeat(
    device: PhoneDevice,
    input: Record<string, unknown>,
  ): Promise<PhoneDevice> {
    const allowed = ["battery", "charging", "screen", "a11y", "locked", "warnings", "network"];
    const patch: Record<string, unknown> = {};
    for (const key of allowed) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    const appVersion =
      typeof input.app_version === "string" ? input.app_version.slice(0, 40) : undefined;
    const diagnostics = {
      ...device.diagnostics,
      ...patch,
      at: new Date().toISOString(),
    };
    const updated = await this.database.withTenant(device.orgId, device.userId, (conn) =>
      updateDevice(conn, device.id, device.orgId, device.userId, {
        diagnostics,
        ...(appVersion ? { appVersion } : {}),
      }),
    );
    if (!updated) throw errors.notFound("Phone not found");
    return updated;
  }

  async putFrame(
    device: PhoneDevice,
    input: { seq: number; jpeg: Uint8Array; width?: number | null; height?: number | null },
  ): Promise<void> {
    await this.database.withTenant(device.orgId, device.userId, (conn) =>
      putFrame(conn, {
        deviceId: device.id,
        orgId: device.orgId,
        userId: device.userId,
        seq: input.seq,
        jpeg: input.jpeg,
        width: input.width ?? null,
        height: input.height ?? null,
      }),
    );
  }

  async frame(
    orgId: string,
    userId: string,
    deviceId: string,
  ): Promise<Awaited<ReturnType<typeof getFrame>>> {
    await this.get(orgId, userId, deviceId);
    return this.database.withTenant(orgId, userId, (conn) => getFrame(conn, deviceId));
  }

  /**
   * Synchronous façade for the chat tools: queue a command and wait for the
   * companion to finish it. The task runner will use the queue directly instead
   * of holding a request open, but chat already is request/response.
   */
  async execute(
    device: PhoneDevice,
    op: CompanionOp,
    args: Record<string, unknown>,
    timeoutMs = 45_000,
  ): Promise<unknown> {
    const command = await this.enqueue(device, { op, args });
    const deadline = Date.now() + Math.max(1_000, Math.min(timeoutMs, 55_000));
    for (;;) {
      const current = await this.database.withTenant(device.orgId, device.userId, (conn) =>
        getCommand(conn, command.id, device.id),
      );
      if (!current) throw errors.unavailable("The phone command disappeared");
      if (current.status === "done") return current.result;
      if (current.status === "error") {
        throw errors.unavailable(`The phone could not complete that: ${current.error ?? "unknown"}`);
      }
      if (["expired", "cancelled"].includes(current.status)) {
        throw errors.unavailable(
          current.status === "expired"
            ? "The phone did not claim that command in time"
            : "The phone command was cancelled",
        );
      }
      if (Date.now() >= deadline) {
        throw errors.unavailable(
          "The phone is paired but not responding. Open Talisman on the phone and check the companion status.",
        );
      }
      await sleep(400);
    }
  }
}
