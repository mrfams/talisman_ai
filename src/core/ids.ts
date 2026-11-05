import { createHash, randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

/** Deterministic, URL-safe id derived from inputs (for idempotent operations). */
export function deterministicId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "org"
  );
}
