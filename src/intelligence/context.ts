import type { ChatMessage } from "./types.js";

export interface MemoryCandidate {
  kind: string;
  content: string;
}

/** Rough token estimate. Deliberately conservative; no tokenizer dependency. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 4;
}

const STOP_WORDS = new Set(
  "the a an and or of to for in on with is are was were be been it this that from as at by my me i you we".split(
    " ",
  ),
);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
    // Crude plural folding: "lives" and "live" should match.
    .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word));
}

/** Keyword overlap ranking. A real embedding store can replace this later. */
export function selectMemories(
  memories: readonly MemoryCandidate[],
  query: string,
  limit = 5,
): MemoryCandidate[] {
  const queryWords = new Set(words(query));
  return memories
    .map((memory) => {
      const overlap = words(memory.content).filter((word) => queryWords.has(word)).length;
      return { memory, score: overlap };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.memory);
}

export interface ContextInput {
  system: string;
  memories?: readonly MemoryCandidate[];
  history: readonly ChatMessage[];
  budgetTokens?: number;
}

/**
 * Builds the model context: system prompt, relevant memories, then as much recent
 * history as fits. Dropped history is replaced with an explicit notice so the
 * model knows it is missing context.
 */
export function buildContext(input: ContextInput): ChatMessage[] {
  const budget = input.budgetTokens ?? 12000;
  const memories = input.memories ?? [];
  const systemParts = [input.system];
  if (memories.length > 0) {
    systemParts.push(
      `Known facts about the user:\n${memories
        .map((memory) => `- (${memory.kind}) ${memory.content}`)
        .join("\n")}`,
    );
  }
  const system: ChatMessage = { role: "system", content: systemParts.join("\n\n") };
  let used = estimateTokens(system.content ?? "");
  const kept: ChatMessage[] = [];
  let dropped = 0;

  for (let index = input.history.length - 1; index >= 0; index -= 1) {
    const message = input.history[index]!;
    const cost =
      estimateTokens(message.content ?? "") +
      estimateTokens(JSON.stringify(message.toolCalls ?? [])) +
      4;
    if (used + cost > budget && kept.length > 0) {
      dropped = index + 1;
      break;
    }
    kept.unshift(message);
    used += cost;
  }

  if (dropped > 0) {
    kept.unshift({
      role: "system",
      content: `(${dropped} earlier messages omitted to fit the context window.)`,
    });
  }
  return [system, ...kept];
}
