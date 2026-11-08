import type { Config } from "../core/config.js";
import type { Database } from "../db/database.js";
import {
  listMemoriesMissingEmbeddings,
  updateMemoryEmbedding,
} from "../db/repos.js";
import type { Memory } from "../core/types.js";
import { selectMemories } from "./context.js";

export interface Embedder {
  readonly model: string;
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
}

class GeminiEmbedder implements Embedder {
  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:embedContent?key=${encodeURIComponent(this.apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: `models/${this.model}`,
            content: { parts: [{ text }] },
            taskType: "SEMANTIC_SIMILARITY",
            outputDimensionality: 768,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 200);
        throw new Error(`Embedding request failed (${response.status})${detail ? `: ${detail}` : ""}`);
      }
      const body = (await response.json()) as {
        embedding?: { values?: unknown[] };
      };
      const values = Array.isArray(body.embedding?.values)
        ? body.embedding.values.map(Number).filter((value) => Number.isFinite(value))
        : [];
      if (values.length === 0) throw new Error("The embedding provider returned no vector");
      return values;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export function createEmbedder(config: Config): Embedder | null {
  if (!config.geminiApiKey) return null;
  return new GeminiEmbedder(config.geminiApiKey, config.geminiEmbeddingModel);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Recall prefers vector similarity when both sides have a vector. Memories that
 * were stored before embeddings existed still participate through keyword
 * overlap, so a missing provider degrades instead of breaking chat.
 */
export function selectMemoriesSemantic(
  memories: readonly Memory[],
  query: string,
  queryEmbedding: number[] | null,
  limit = 5,
): Memory[] {
  if (queryEmbedding && queryEmbedding.length > 0) {
    const scored = memories
      .filter((memory) => memory.embedding && memory.embedding.length > 0)
      .map((memory) => ({
        memory,
        score: cosineSimilarity(queryEmbedding, memory.embedding ?? []),
      }))
      .filter((entry) => entry.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.memory);
    if (scored.length > 0) {
      // Fill the remaining slots with keyword matches that lack a vector yet.
      const seen = new Set(scored.map((memory) => memory.id));
      const keyword = selectMemories(memories, query, limit) as Memory[];
      return [...scored, ...keyword.filter((memory) => !seen.has(memory.id))].slice(0, limit);
    }
  }
  return selectMemories(memories, query, limit) as Memory[];
}

/**
 * Lazily embed the newest unembedded memories. Called from chat so old rows are
 * upgraded without a migration that needs an external API, and bounded so one
 * message never embeds an entire history. Batches are concurrent but bounded.
 */
export async function backfillMemoryEmbeddings(input: {
  database: Database;
  embedder: Embedder;
  orgId: string;
  userId: string;
  limit?: number;
}): Promise<number> {
  const memories = await input.database.withTenant(input.orgId, input.userId, (conn) =>
    listMemoriesMissingEmbeddings(conn, input.orgId, input.userId, input.limit ?? 3),
  );
  let updated = 0;
  // Four concurrent provider calls keep an explicit index inside a serverless
  // request budget without flooding the embedding endpoint.
  for (let index = 0; index < memories.length; index += 4) {
    const batch = memories.slice(index, index + 4);
    const outcomes = await Promise.all(
      batch.map(async (memory) => {
        try {
          const vector = await input.embedder.embed(memory.content);
          await input.database.withTenant(input.orgId, input.userId, (conn) =>
            updateMemoryEmbedding(conn, memory.id, input.userId, vector, input.embedder.model),
          );
          return true;
        } catch {
          // A provider outage must not block the conversation or the rest of the batch.
          return false;
        }
      }),
    );
    updated += outcomes.filter(Boolean).length;
  }
  return updated;
}
