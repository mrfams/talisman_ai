import type { ModelEvent, ModelProvider, ModelRequest, ToolCall } from "../types.js";

export interface MockTurn {
  text?: string;
  toolCalls?: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  /** Throw instead of answering, to exercise routing and retries. */
  error?: Error;
}

/**
 * Deterministic provider. It is a test double, not a model: every turn is scripted
 * up front so tests can assert the orchestration around it. Production paths use a
 * real provider.
 */
export class MockProvider implements ModelProvider {
  readonly id = "mock";
  private index = 0;
  readonly requests: ModelRequest[] = [];

  constructor(private readonly script: MockTurn[] = []) {}

  supportsModel(): boolean {
    return true;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push({
      ...request,
      messages: request.messages.map((message) => ({ ...message })),
    });
    const turn = this.script[this.index++] ?? { text: "Done." };
    if (turn.error) throw turn.error;
    if (turn.text) {
      // Split into deltas so streaming consumers are exercised.
      const pieces = turn.text.match(/.{1,24}/gs) ?? [turn.text];
      for (const piece of pieces) yield { type: "text_delta", text: piece };
    }
    for (const toolCall of turn.toolCalls ?? []) {
      yield { type: "tool_call", toolCall };
    }
    yield {
      type: "usage",
      inputTokens: turn.usage?.inputTokens ?? 10,
      outputTokens: turn.usage?.outputTokens ?? 10,
    };
    yield { type: "done", finishReason: turn.toolCalls?.length ? "tool_calls" : "stop" };
  }
}
