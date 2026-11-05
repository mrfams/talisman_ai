import {
  ProviderError,
  type ChatMessage,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
} from "../types.js";
import { sseEvents } from "./sse.js";

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  supports?: (model: string) => boolean;
}

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly supports: (model: string) => boolean;

  constructor(options: AnthropicProviderOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.supports = options.supports ?? ((model) => model.startsWith("claude"));
    this.apiKey = options.apiKey;
  }

  private readonly apiKey: string;

  supportsModel(model: string): boolean {
    return this.supports(model);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content ?? "")
      .join("\n\n");
    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        system: system || undefined,
        messages: toAnthropicMessages(request.messages.filter((m) => m.role !== "system")),
        tools: request.tools?.length
          ? request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            }))
          : undefined,
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature,
        stream: true,
      }),
      signal: request.signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new ProviderError(
        `Anthropic returned ${response.status}: ${detail.slice(0, 300)}`,
        this.id,
        response.status === 429 || response.status >= 500,
        response.status,
      );
    }

    const blocks = new Map<number, { id: string; name: string; json: string }>();
    let finishReason = "stop";
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of sseEvents(response.body)) {
      if (!event.data) continue;
      let payload: any;
      try {
        payload = JSON.parse(event.data);
      } catch {
        continue;
      }
      switch (payload.type) {
        case "message_start":
          inputTokens = Number(payload.message?.usage?.input_tokens ?? 0);
          break;
        case "content_block_start": {
          const block = payload.content_block;
          if (block?.type === "tool_use") {
            blocks.set(Number(payload.index), {
              id: String(block.id ?? ""),
              name: String(block.name ?? ""),
              json: "",
            });
          } else if (block?.type === "text" && block.text) {
            yield { type: "text_delta", text: String(block.text) };
          }
          break;
        }
        case "content_block_delta": {
          const delta = payload.delta;
          if (delta?.type === "text_delta" && delta.text) {
            yield { type: "text_delta", text: String(delta.text) };
          } else if (delta?.type === "input_json_delta") {
            const block = blocks.get(Number(payload.index));
            if (block) block.json += String(delta.partial_json ?? "");
          }
          break;
        }
        case "message_delta":
          if (payload.delta?.stop_reason) finishReason = String(payload.delta.stop_reason);
          if (payload.usage?.output_tokens) {
            outputTokens = Number(payload.usage.output_tokens);
          }
          break;
        case "error":
          throw new ProviderError(
            String(payload.error?.message ?? "anthropic error"),
            this.id,
            false,
          );
        default:
          break;
      }
    }

    for (const [, block] of [...blocks.entries()].sort(([a], [b]) => a - b)) {
      if (!block.name) continue;
      yield {
        type: "tool_call",
        toolCall: {
          id: block.id || `toolu_${Math.random().toString(36).slice(2)}`,
          name: block.name,
          arguments: parseArgs(block.json),
        },
      };
    }
    if (inputTokens || outputTokens) {
      yield { type: "usage", inputTokens, outputTokens };
    }
    yield {
      type: "done",
      finishReason: finishReason === "tool_use" ? "tool_calls" : finishReason,
    };
  }
}

function parseArgs(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { __invalidJson: value.slice(0, 2000) };
  }
}

function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const output: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const last = output.at(-1);
      const block = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content ?? "",
      };
      if (last?.role === "user") last.content.push(block);
      else output.push({ role: "user", content: [block] });
      continue;
    }
    if (message.role === "assistant") {
      const content: unknown[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      }
      output.push({ role: "assistant", content });
      continue;
    }
    output.push({ role: "user", content: [{ type: "text", text: message.content ?? "" }] });
  }
  return output;
}
