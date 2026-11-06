import type { Database } from "../db/database.js";
import {
  deleteCredential,
  getCredential,
  hasCredential,
  putCredential,
} from "../db/repos.js";
import { errors } from "../core/errors.js";
import type { SecretBox } from "../security/secrets.js";

/**
 * Per-user connector credentials, encrypted before they reach Postgres.
 *
 * Rows are keyed by (org, provider, user), so two users in one organisation never
 * share a token, and row level security keeps other organisations out entirely.
 */
export class CredentialStore {
  constructor(
    private readonly database: Database,
    private readonly box: SecretBox | null,
  ) {}

  get configured(): boolean {
    return this.box !== null;
  }

  private require(): SecretBox {
    if (!this.box) {
      throw errors.unavailable(
        "Credential storage is disabled: CREDENTIAL_ENCRYPTION_KEY is not configured.",
      );
    }
    return this.box;
  }

  private context(orgId: string, provider: string, userId: string): string {
    return `${orgId}:${provider}:${userId}`;
  }

  async save(orgId: string, userId: string, provider: string, payload: unknown): Promise<void> {
    const sealed = this.require().seal(JSON.stringify(payload), this.context(orgId, provider, userId));
    await this.database.withTenant(orgId, userId, (conn) =>
      putCredential(conn, {
        orgId,
        provider,
        label: userId,
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        tag: sealed.tag,
      }),
    );
  }

  async load<T>(orgId: string, userId: string, provider: string): Promise<T | null> {
    const box = this.require();
    const row = await this.database.withTenant(orgId, userId, (conn) =>
      getCredential(conn, orgId, provider, userId),
    );
    if (!row) return null;
    const plaintext = box.open(row, this.context(orgId, provider, userId));
    try {
      return JSON.parse(plaintext) as T;
    } catch {
      throw errors.forbidden("Stored credential is not readable JSON");
    }
  }

  async has(orgId: string, userId: string, provider: string): Promise<boolean> {
    if (!this.box) return false;
    return this.database.withTenant(orgId, userId, (conn) =>
      hasCredential(conn, orgId, provider, userId),
    );
  }

  async remove(orgId: string, userId: string, provider: string): Promise<boolean> {
    return this.database.withTenant(orgId, userId, (conn) =>
      deleteCredential(conn, orgId, provider, userId),
    );
  }
}
