import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { errors } from "../core/errors.js";
import type { Database } from "../db/database.js";

const SAFE_SEGMENT = /^[a-zA-Z0-9_-]{1,64}$/;

export function assertSegment(value: string, label = "path segment"): string {
  if (!SAFE_SEGMENT.test(value)) throw errors.invalid(`Invalid ${label}`);
  return value;
}

export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? "artifact";
  const cleaned = Array.from(base)
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join("")
    .replace(/[<>:"|?*]/g, "_")
    .slice(0, 120);
  return cleaned || "artifact";
}

/** A workspace rooted at one user's task directory. Never escapes its root. */
export class Workspace {
  /**
   * `writable` is false on hosts with no persistent disk (serverless). Tasks then
   * keep their outputs as artifacts instead of workspace files; nothing pretends
   * a file was written when it was not.
   */
  constructor(
    readonly root: string,
    readonly writable = true,
  ) {}

  static forTask(
    dataDir: string,
    orgId: string,
    userId: string,
    taskId: string,
    writable = true,
  ): Workspace {
    const root = resolve(
      dataDir,
      "workspaces",
      assertSegment(orgId, "organisation id"),
      assertSegment(userId, "user id"),
      assertSegment(taskId, "task id"),
    );
    return new Workspace(root, writable);
  }

  resolve(relativePath: string): string {
    const target = resolve(this.root, relativePath);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw errors.forbidden("Path escapes the workspace");
    }
    return target;
  }

  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  async write(relativePath: string, contents: string | Uint8Array): Promise<string> {
    if (!this.writable) return relativePath;
    await this.ensure();
    const target = this.resolve(relativePath);
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, contents, { mode: 0o600 });
    return target;
  }

  async read(relativePath: string): Promise<Buffer> {
    if (!this.writable) {
      throw errors.notFound("Workspace files are not persisted on this host");
    }
    return readFile(this.resolve(relativePath));
  }
}

export interface StoredArtifact {
  storagePath: string;
  sha256: string;
  sizeBytes: number;
}

export interface ArtifactStoreLike {
  put(input: {
    orgId: string;
    artifactId: string;
    name: string;
    bytes: Uint8Array;
  }): Promise<StoredArtifact>;
  read(storagePath: string, orgId: string): Promise<Buffer>;
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Filesystem artifacts. Suitable for a long-running host with a persistent disk;
 * the path is validated against the tenant prefix on every read.
 */
export class ArtifactStore implements ArtifactStoreLike {
  constructor(private readonly dataDir: string) {}

  async put(input: {
    orgId: string;
    artifactId: string;
    name: string;
    bytes: Uint8Array;
  }): Promise<StoredArtifact> {
    const directory = resolve(
      this.dataDir,
      "artifacts",
      assertSegment(input.orgId, "organisation id"),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, `${assertSegment(input.artifactId, "artifact id")}-${safeFileName(input.name)}`);
    await writeFile(path, input.bytes, { mode: 0o600 });
    return {
      storagePath: path,
      sha256: sha256Of(input.bytes),
      sizeBytes: input.bytes.byteLength,
    };
  }

  async read(storagePath: string, orgId: string): Promise<Buffer> {
    const expectedPrefix = resolve(this.dataDir, "artifacts", assertSegment(orgId, "organisation id")) + sep;
    const target = resolve(storagePath);
    if (!target.startsWith(expectedPrefix)) throw errors.forbidden("Artifact is outside the tenant store");
    return readFile(target);
  }
}

const PG_PREFIX = "pg:";

/**
 * Artifacts stored in Postgres. Serverless hosts have no writable persistent
 * disk, so the bytes live beside the row that describes them. Reads still run
 * under the tenant role, so row level security applies to the blob as well.
 */
export class PgArtifactStore implements ArtifactStoreLike {
  constructor(private readonly database: Database) {}

  async put(input: {
    orgId: string;
    artifactId: string;
    name: string;
    bytes: Uint8Array;
  }): Promise<StoredArtifact> {
    const sha256 = sha256Of(input.bytes);
    await this.database.withTenant(input.orgId, "service", async (conn) => {
      await conn.query(
        `INSERT INTO artifact_blobs (artifact_id, org_id, bytes, sha256)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (artifact_id) DO UPDATE
           SET bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256`,
        [input.artifactId, input.orgId, Buffer.from(input.bytes), sha256],
      );
    });
    return {
      storagePath: `${PG_PREFIX}${input.artifactId}`,
      sha256,
      sizeBytes: input.bytes.byteLength,
    };
  }

  async read(storagePath: string, orgId: string): Promise<Buffer> {
    if (!storagePath.startsWith(PG_PREFIX)) {
      throw errors.forbidden("Artifact is not stored in Postgres");
    }
    const artifactId = storagePath.slice(PG_PREFIX.length);
    const row = await this.database.withTenant(orgId, "service", async (conn) => {
      const { rows } = await conn.query<{ bytes: Buffer }>(
        "SELECT bytes FROM artifact_blobs WHERE artifact_id = $1 AND org_id = $2",
        [artifactId, orgId],
      );
      return rows[0] ?? null;
    });
    if (!row) throw errors.notFound("Artifact bytes not found");
    return Buffer.from(row.bytes);
  }
}

export function createArtifactStore(
  config: { artifactStore: "fs" | "postgres"; dataDir: string },
  database: Database,
): ArtifactStoreLike {
  return config.artifactStore === "postgres"
    ? new PgArtifactStore(database)
    : new ArtifactStore(config.dataDir);
}
