import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { errors } from "../core/errors.js";

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
  constructor(readonly root: string) {}

  static forTask(dataDir: string, orgId: string, userId: string, taskId: string): Workspace {
    const root = resolve(
      dataDir,
      "workspaces",
      assertSegment(orgId, "organisation id"),
      assertSegment(userId, "user id"),
      assertSegment(taskId, "task id"),
    );
    return new Workspace(root);
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
    await this.ensure();
    const target = this.resolve(relativePath);
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, contents, { mode: 0o600 });
    return target;
  }

  async read(relativePath: string): Promise<Buffer> {
    return readFile(this.resolve(relativePath));
  }
}

export interface StoredArtifact {
  storagePath: string;
  sha256: string;
  sizeBytes: number;
}

export class ArtifactStore {
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
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
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
