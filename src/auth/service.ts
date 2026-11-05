import { createHash, randomBytes } from "node:crypto";
import type { Database } from "../db/database.js";
import {
  createOrgWithOwner,
  createSession,
  deleteExpiredSessions,
  deleteSession,
  findSession,
  findUserByEmail,
  listOrgsForUser,
  touchSession,
} from "../db/repos.js";
import { errors } from "../core/errors.js";
import { recordAudit } from "../db/repos.js";
import { slugify } from "../core/ids.js";
import type { SessionInfo, User } from "../core/types.js";
import { hashPassword, verifyPassword } from "./password.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface LoginResult {
  token: string;
  session: SessionInfo;
}

/**
 * Session tokens are random 256-bit values. Only a peppered hash is stored, so a
 * database leak does not hand over usable sessions. The pepper comes from
 * SESSION_SECRET; development generates an ephemeral one.
 */
export class AuthService {
  private readonly pepper: string;
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly database: Database,
    sessionSecret: string | null,
  ) {
    if (!sessionSecret && process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET is required");
    }
    this.pepper = sessionSecret ?? randomBytes(32).toString("base64url");
  }

  private tokenId(token: string): string {
    return createHash("sha256").update(`${this.pepper}:${token}`).digest("hex");
  }

  private throttle(key: string): void {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
      return;
    }
    entry.count += 1;
    if (entry.count > 10) throw errors.rateLimited();
  }

  async signup(input: {
    email: string;
    password: string;
    name?: string;
    orgName: string;
  }): Promise<LoginResult> {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL.test(email)) throw errors.invalid("Enter a valid email address");
    if (input.password.length < 12) {
      throw errors.invalid("Password must be at least 12 characters");
    }
    const orgName = input.orgName.trim() || `${email.split("@")[0]}'s workspace`;
    const passwordHash = await hashPassword(input.password);

    let user: User;
    try {
      user = await createOrgWithOwner(this.database.driver, {
        orgName,
        slug: `${slugify(orgName)}-${randomBytes(3).toString("hex")}`,
        email,
        name: input.name?.trim() || null,
        passwordHash,
      });
    } catch (error) {
      if (String(error).includes("users_email_unique") || String(error).includes("duplicate key")) {
        throw errors.conflict("An account with that email already exists");
      }
      throw error;
    }

    await this.database.driver.transaction(async (conn) => {
      await recordAudit(conn, {
        orgId: user.orgId,
        actorUserId: user.id,
        eventType: "auth.signup",
        targetType: "user",
        targetId: user.id,
      });
    });

    return this.issue(user);
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const normalized = email.trim().toLowerCase();
    this.throttle(normalized);
    const found = await findUserByEmail(this.database.driver, normalized);
    // Always run a verification to keep timing similar for unknown accounts.
    const stored =
      found?.passwordHash ??
      "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const valid = await verifyPassword(password, stored);
    if (!found || !valid) throw errors.unauthorized("Email or password is incorrect");

    const orgs = await listOrgsForUser(this.database.driver, found.user.id);
    if (orgs.length === 0) throw errors.forbidden("No organisation membership");
    const session = await this.issue({ ...found.user, orgId: orgs[0]!.id, role: orgs[0]!.role });
    await this.database.driver.transaction(async (conn) => {
      await recordAudit(conn, {
        orgId: found.user.orgId,
        actorUserId: found.user.id,
        eventType: "auth.login",
        targetType: "user",
        targetId: found.user.id,
      });
    });
    return session;
  }

  private async issue(user: User): Promise<LoginResult> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await createSession(this.database.driver, {
      id: this.tokenId(token),
      userId: user.id,
      orgId: user.orgId,
      expiresAt,
    });
    return {
      token,
      session: { user, expiresAt: expiresAt.toISOString() },
    };
  }

  async authenticate(token: string | undefined): Promise<SessionInfo | null> {
    if (!token) return null;
    const id = this.tokenId(token);
    const found = await findSession(this.database.driver, id);
    if (!found) return null;
    void touchSession(this.database.driver, id).catch(() => undefined);
    return found.info;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await deleteSession(this.database.driver, this.tokenId(token));
  }

  async cleanup(): Promise<void> {
    await deleteExpiredSessions(this.database.driver);
  }
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice(7).trim();
  return token || undefined;
}
