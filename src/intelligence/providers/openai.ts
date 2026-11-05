import { ProviderError, type ChatMessage, type ModelEvent, type ModelProvider, type ModelRequest } from "../types.js";
import { sseEvents } from "./sse.js";

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  supports?: (model: string) => boolean;
}

/** Works with OpenAI and any OpenAI-compatible endpoint (vLLM, Ollama, OpenRouter). */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly supports: (model: string) => boolean;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.supports = options.supports ?? (() => true);
  }

  supportsModel(model: string): boolean {
    return this.supports(model);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        messages: toOpenAIMessages(request.messages),
        tools: request.tools?.length
          ? request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            }))
          : undefined,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: request.signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new ProviderError(
        `OpenAI-compatible provider returned ${response.status}: ${detail.slice(0, 300)}`,
        this.id,
        response.status === 429 || response.status >= 500,
        response.status,
      );
    }

    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finishReason = "stop";
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of sseEvents(response.body)) {
      if (event.data === "[DONE]") break;
      let payload: any;
      try {
        payload = JSON.parse(event.data);
      } catch {
        continue;
      }
      if (payload.error) {
        throw new ProviderError(
          String(payload.error.message ?? "provider error"),
          this.id,
          false,
        );
      }
      if (payload.usage) {
        inputTokens = Number(payload.usage.prompt_tokens ?? 0);
        outputTokens = Number(payload.usage.completion_tokens ?? 0);
      }
      const choice = payload.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = String(choice.finish_reason);
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        yield { type: "text_delta", text: delta.content };
      }
      for (const call of (delta.tool_calls ?? []) as OpenAIToolCallDelta[]) {
        const index = call.index ?? 0;
        const current = pending.get(index) ?? { id: "", name: "", args: "" };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.args += call.function.arguments;
        pending.set(index, current);
      }
    }

    for (const [, call] of [...pending.entries()].sort(([a], [b]) => a - b)) {
      if (!call.name) continue;
      yield {
        type: "tool_call",
        toolCall: {
          id: call.id || `call_${Math.random().toString(36).slice(2)}`,
          name: call.name,
          arguments: safeParse(call.args),
        },
      };
    }
    if (inputTokens || outputTokens) {
      yield { type: "usage", inputTokens, outputTokens };
    }
    yield { type: "done", finishReason };
  }
}

function safeParse(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { __invalidJson: value.slice(0, 2000) };
  }
}

export function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content ?? "",
      };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content ?? null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      };
    }
    return { role: message.role, content: message.content ?? "" };
  });
}
