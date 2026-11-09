import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.js";
import {
  cancelPhoneApprovals,
  cancelQueuedCommands,
  claimCommand,
  claimPairingCode,
  completeCommand,
  completePhoneApproval,
  countPhoneApprovalCommands,
  createDevice,
  createPhoneApproval,
  decidePhoneApproval,
  enqueueCommand,
  getCommand,
  getDeviceById,
  getFrame,
  getPhoneApproval,
  insertPairingCode,
  listDevices,
  listPhoneApprovals,
  putFrame,
  touchDevice,
  updateDevice,
  type PhoneApproval,
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

export interface PublicPhoneApproval {
  id: string;
  deviceId: string;
  op: "act" | "flow" | "task";
  args: Record<string, unknown>;
  summary: string;
  status: PhoneApproval["status"];
  expiresAt: string;
  createdAt: string;
  decidedAt: string | null;
}

export interface PhoneActionDecision {
  approval: PublicPhoneApproval;
  command: {
    id: string;
    status: string;
    result: unknown;
    error: string | null;
  } | null;
  /** Present when the owner approved an autonomous task envelope. */
  task: {
    id: string;
    goal: string;
    maxSteps: number;
  } | null;
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
const APPROVAL_TTL_MS = 2 * 60_000;
const TASK_TTL_MS = 10 * 60_000;
const DEFAULT_TASK_STEPS = 20;
const MAX_TASK_STEPS = 30;
const PHONE_ACTIONS = [
  "launch",
  "deep_link",
  "tap",
  "tap_ref",
  "long_press",
  "type",
  "swipe",
  "scroll",
  "global",
] as const;

export function publicApproval(approval: PhoneApproval): PublicPhoneApproval {
  return {
    id: approval.id,
    deviceId: approval.deviceId,
    op: approval.op,
    args: approval.args,
    summary: approval.summary,
    status: approval.status,
    expiresAt: approval.expiresAt,
    createdAt: approval.createdAt,
    decidedAt: approval.decidedAt,
  };
}

function actionSummary(
  deviceName: string,
  op: "act" | "flow" | "task",
  args: Record<string, unknown>,
): string {
  if (op === "task") {
    return `Work on ${String(args.goal ?? "a phone task")} on ${deviceName}`;
  }
  if (op === "flow") {
    const steps = Array.isArray(args.steps) ? args.steps.length : 0;
    return `Run a ${steps}-step action flow on ${deviceName}`;
  }
  const action = String(args.action ?? "action");
  switch (action) {
    case "launch":
      return `Open ${String(args.package ?? "an app")} on ${deviceName}`;
    case "deep_link":
      return `Open ${String(args.uri ?? "a link")} on ${deviceName}`;
    case "tap":
      return `Tap (${Number(args.x ?? 0)}, ${Number(args.y ?? 0)}) on ${deviceName}`;
    case "tap_ref":
      return `Tap element ${String(args.ref ?? "")} on ${deviceName}`;
    case "long_press":
      return `Long-press on ${deviceName}`;
    case "type":
      return `Type ${String(args.text ?? "").length} characters on ${deviceName}`;
    case "swipe":
      return `Swipe on ${deviceName}`;
    case "scroll":
      return `Scroll ${String(args.direction ?? "down")} on ${deviceName}`;
    case "global":
      return `Press ${String(args.name ?? "a navigation button")} on ${deviceName}`;
    default:
      return `Run ${action} on ${deviceName}`;
  }
}

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
      await cancelPhoneApprovals(conn, deviceId);
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
      await cancelPhoneApprovals(conn, deviceId);
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

  /**
   * A human-readable, expiring request. Nothing is queued until the owner
   * approves it, and the queued command carries the approval id plus the hash of
   * these exact arguments.
   */
  async requestAction(
    orgId: string,
    userId: string,
    deviceId: string,
    input: { op: string; args: Record<string, unknown> },
  ): Promise<PublicPhoneApproval> {
    const device = await this.get(orgId, userId, deviceId);
    if (device.status !== "active") {
      throw errors.conflict(
        device.status === "revoked"
          ? "This phone has been revoked"
          : "This phone is paused. Resume it first.",
      );
    }
    if (input.op !== "act" && input.op !== "flow") {
      throw errors.invalid("Only act or flow needs an approval");
    }
    const args =
      input.args && typeof input.args === "object" && !Array.isArray(input.args)
        ? input.args
        : {};
    if (JSON.stringify(args).length > 32_000) throw errors.invalid("Phone action is too large");
    if (input.op === "act") {
      const action = String(args.action ?? "");
      if (!(PHONE_ACTIONS as readonly string[]).includes(action)) {
        throw errors.invalid(`Unsupported phone action: ${action || "missing"}`);
      }
    } else if (!Array.isArray(args.steps) || args.steps.length === 0) {
      throw errors.invalid("A flow needs at least one step");
    }
    const op: "act" | "flow" = input.op === "act" ? "act" : "flow";

    const approval = await this.database.withTenant(orgId, userId, (conn) =>
      createPhoneApproval(conn, {
        id: newId(),
        orgId,
        userId,
        deviceId: device.id,
        op,
        args,
        argsHash: hashArgs(args),
        summary: actionSummary(device.name, op, args).slice(0, 500),
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      }),
    );
    return publicApproval(approval);
  }

  /**
   * One approval for a goal, not for a guessed sequence. The phone is read
   * between actions, so the executor can adapt to what is actually on screen.
   */
  async requestTask(
    orgId: string,
    userId: string,
    deviceId: string,
    input: { goal: string; maxSteps?: number },
  ): Promise<PublicPhoneApproval> {
    const goal = input.goal.trim().slice(0, 1_000);
    if (goal.length < 3) throw errors.invalid("A phone task needs a goal");
    const requestedSteps = Number(input.maxSteps ?? DEFAULT_TASK_STEPS);
    const maxSteps = Number.isFinite(requestedSteps)
      ? Math.max(1, Math.min(MAX_TASK_STEPS, Math.trunc(requestedSteps)))
      : DEFAULT_TASK_STEPS;
    const device = await this.get(orgId, userId, deviceId);
    if (device.status !== "active") {
      throw errors.conflict(
        device.status === "revoked"
          ? "This phone has been revoked"
          : "This phone is paused. Resume it first.",
      );
    }
    const active = await this.activeTask(orgId, userId, deviceId);
    if (active) throw errors.conflict("This phone already has an approved task running");
    const pending = await this.listApprovals(orgId, userId, "pending");
    if (pending.some((approval) => approval.deviceId === deviceId && approval.op === "task")) {
      throw errors.conflict("This phone already has a task waiting for approval");
    }

    const args = { goal, max_steps: maxSteps };
    const approval = await this.database.withTenant(orgId, userId, (conn) =>
      createPhoneApproval(conn, {
        id: newId(),
        orgId,
        userId,
        deviceId: device.id,
        op: "task",
        args,
        argsHash: hashArgs(args),
        summary: actionSummary(device.name, "task", args).slice(0, 500),
        expiresAt: new Date(Date.now() + TASK_TTL_MS),
      }),
    );
    return publicApproval(approval);
  }

  async activeTask(
    orgId: string,
    userId: string,
    deviceId: string,
  ): Promise<PublicPhoneApproval | null> {
    const approvals = await this.database.withTenant(orgId, userId, (conn) =>
      listPhoneApprovals(conn, orgId, userId, "approved", 50),
    );
    const now = Date.now();
    return (
      approvals.find(
        (approval) =>
          approval.deviceId === deviceId &&
          approval.op === "task" &&
          new Date(approval.expiresAt).getTime() > now,
      ) ?? null
    );
  }

  async completeTask(
    orgId: string,
    userId: string,
    taskId: string,
  ): Promise<PublicPhoneApproval> {
    const completed = await this.database.withTenant(orgId, userId, (conn) =>
      completePhoneApproval(conn, taskId, orgId, userId),
    );
    if (!completed) throw errors.conflict("This phone task is no longer active");
    return publicApproval(completed);
  }

  async listApprovals(
    orgId: string,
    userId: string,
    status: PhoneApproval["status"] | "all" = "pending",
  ): Promise<PublicPhoneApproval[]> {
    const approvals = await this.database.withTenant(orgId, userId, (conn) =>
      listPhoneApprovals(conn, orgId, userId, status),
    );
    return approvals.map(publicApproval);
  }

  /** Approves or refuses exactly one pending action, then queues it if allowed. */
  async decideAction(
    orgId: string,
    userId: string,
    approvalId: string,
    decision: "approved" | "denied",
    waitMs = 45_000,
  ): Promise<PhoneActionDecision> {
    const approval = await this.database.withTenant(orgId, userId, (conn) =>
      getPhoneApproval(conn, approvalId, orgId, userId),
    );
    if (!approval) throw errors.notFound("Phone action not found");
    if (approval.status !== "pending") {
      throw errors.conflict("This phone action was already decided");
    }
    if (new Date(approval.expiresAt).getTime() <= Date.now()) {
      throw errors.conflict("This phone action has expired. Ask for it again.");
    }

    const decided = await this.database.withTenant(orgId, userId, (conn) =>
      decidePhoneApproval(conn, approvalId, orgId, userId, decision),
    );
    if (!decided) throw errors.conflict("This phone action was already decided");
    if (decision === "denied") {
      return { approval: publicApproval(decided), command: null, task: null };
    }

    if (approval.op === "task") {
      return {
        approval: publicApproval(decided),
        command: null,
        task: {
          id: approval.id,
          goal: String(approval.args.goal ?? ""),
          maxSteps: Number.isFinite(Number(approval.args.max_steps))
            ? Number(approval.args.max_steps)
            : DEFAULT_TASK_STEPS,
        },
      };
    }

    const device = await this.get(orgId, userId, approval.deviceId);
    const command = await this.enqueue(device, {
      op: approval.op,
      args: approval.args,
      phoneApprovalId: approval.id,
    });
    const outcome = await this.awaitCommand(device, command.id, waitMs);
    return {
      approval: publicApproval(decided),
      command: { id: command.id, ...outcome },
      task: null,
    };
  }

  /**
   * Executes one exact action inside an already approved task envelope. The
   * command still carries the phone-approval id and the hash of these exact
   * arguments, so the device refuses anything the server did not queue.
   */
  async executeApproved(
    device: PhoneDevice,
    taskId: string,
    args: Record<string, unknown>,
    timeoutMs = 20_000,
  ): Promise<{ status: string; result: unknown; error: string | null }> {
    const scope = await this.database.withTenant(device.orgId, device.userId, async (conn) => {
      const task = await getPhoneApproval(conn, taskId, device.orgId, device.userId);
      if (!task) return null;
      return { task, used: await countPhoneApprovalCommands(conn, taskId) };
    });
    if (
      !scope ||
      scope.task.op !== "task" ||
      scope.task.deviceId !== device.id ||
      scope.task.status !== "approved" ||
      new Date(scope.task.expiresAt).getTime() <= Date.now()
    ) {
      throw errors.conflict("This phone task is no longer active");
    }
    const requestedSteps = Number(scope.task.args.max_steps ?? DEFAULT_TASK_STEPS);
    const maxSteps = Number.isFinite(requestedSteps)
      ? Math.max(1, Math.min(MAX_TASK_STEPS, Math.trunc(requestedSteps)))
      : DEFAULT_TASK_STEPS;
    if (scope.used >= maxSteps) {
      throw errors.conflict(
        `This phone task has used all ${maxSteps} approved actions. Start a new task to continue.`,
      );
    }
    const command = await this.enqueue(device, {
      op: "act",
      args,
      phoneApprovalId: taskId,
    });
    return this.awaitCommand(device, command.id, timeoutMs);
  }

  async enqueue(
    device: PhoneDevice,
    input: {
      op: CompanionOp;
      args?: Record<string, unknown>;
      runId?: string | null;
      stepId?: string | null;
      approvalId?: string | null;
      phoneApprovalId?: string | null;
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
        phoneApprovalId: input.phoneApprovalId ?? null,
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

  /** Waits for one claimed command without throwing on a phone-side error. */
  private async awaitCommand(
    device: PhoneDevice,
    commandId: string,
    timeoutMs: number,
  ): Promise<{ status: string; result: unknown; error: string | null }> {
    const deadline = Date.now() + Math.max(1_000, Math.min(timeoutMs, 55_000));
    for (;;) {
      const current = await this.database.withTenant(device.orgId, device.userId, (conn) =>
        getCommand(conn, commandId, device.id),
      );
      if (!current) throw errors.unavailable("The phone command disappeared");
      if (["done", "error", "expired", "cancelled"].includes(current.status)) {
        return { status: current.status, result: current.result, error: current.error };
      }
      if (Date.now() >= deadline) {
        return {
          status: current.status,
          result: null,
          error:
            current.status === "queued"
              ? "The phone has not claimed the command yet"
              : "The phone is still working on it",
        };
      }
      await sleep(300);
    }
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
