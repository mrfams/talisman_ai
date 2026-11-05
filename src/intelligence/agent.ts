import type { ModelRouter } from "./router.js";
import {
  emptyResult,
  type ChatMessage,
  type ChatResult,
  type ModelEvent,
  type ToolCall,
  type ToolDefinition,
} from "./types.js";

export interface AgentTool {
  definition: ToolDefinition;
  requiresApproval?: boolean;
  execute(
    args: Record<string, unknown>,
    context: { signal: AbortSignal; callId: string },
  ): Promise<unknown>;
}

export interface ToolApprovalRequest {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
}

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_end"; id: string; name: string; ok: boolean; result: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; text: string; finishReason: string; steps: number };

export interface AgentRunOptions {
  messages: ChatMessage[];
  model?: string;
  signal?: AbortSignal;
  maxSteps?: number;
  temperature?: number;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  /**
   * Approval gate for tools marked `requiresApproval`. Returning false denies the
   * call. When omitted, such tools are denied: default deny.
   */
  approve?: (request: ToolApprovalRequest) => Promise<boolean>;
  maxToolResultChars?: number;
}

export interface AgentRunResult {
  messages: ChatMessage[];
  result: ChatResult;
  steps: number;
}

const MAX_TOOL_RESULT_CHARS = 20_000;

export class Agent {
  constructor(
    private readonly router: ModelRouter,
    private readonly tools: readonly AgentTool[],
  ) {}

  private toolByName(name: string): AgentTool | undefined {
    return this.tools.find((tool) => tool.definition.name === name);
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const maxSteps = options.maxSteps ?? 8;
    const messages = [...options.messages];
    let totalText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = "stop";
    let steps = 0;

    for (; steps < maxSteps; steps += 1) {
      if (options.signal?.aborted) throw new Error("Agent run aborted");
      const textParts: string[] = [];
      const toolCalls: ToolCall[] = [];

      const stream = this.router.stream({
        model: options.model ?? "",
        messages,
        tools: this.tools.map((tool) => tool.definition),
        temperature: options.temperature,
        signal: options.signal,
      });

      for await (const event of stream) {
        await this.dispatch(event, options, textParts, toolCalls, (tokens) => {
          inputTokens += tokens.input;
          outputTokens += tokens.output;
        });
      }

      const text = textParts.join("");
      totalText += text;
      messages.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });

      if (toolCalls.length === 0) {
        await options.onEvent?.({ type: "done", text: totalText, finishReason, steps: steps + 1 });
        return {
          messages,
          result: { text: totalText, toolCalls: [], usage: { inputTokens, outputTokens }, finishReason },
          steps: steps + 1,
        };
      }

      for (const call of toolCalls) {
        const tool = this.toolByName(call.name);
        await options.onEvent?.({
          type: "tool_start",
          id: call.id,
          name: call.name,
          args: call.arguments,
        });

        let ok = false;
        let payload: unknown;
        if (!tool) {
          payload = { error: `Unknown tool: ${call.name}` };
        } else if (
          tool.requiresApproval &&
          !(await this.isApproved(tool, call, options.approve))
        ) {
          payload = { error: "Denied: this action requires approval and none was granted." };
        } else {
          try {
            payload = await tool.execute(call.arguments, {
              signal: options.signal ?? new AbortController().signal,
              callId: call.id,
            });
            ok = true;
          } catch (error) {
            payload = { error: error instanceof Error ? error.message : String(error) };
          }
        }

        await options.onEvent?.({
          type: "tool_end",
          id: call.id,
          name: call.name,
          ok,
          result: payload,
        });
        const serialized = JSON.stringify(payload ?? null);
        const limit = options.maxToolResultChars ?? MAX_TOOL_RESULT_CHARS;
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content:
            serialized.length > limit
              ? `${serialized.slice(0, limit)}… (truncated)`
              : serialized,
        });
      }
    }

    await options.onEvent?.({
      type: "done",
      text: totalText,
      finishReason: "max_steps",
      steps,
    });
    return {
      messages,
      result: {
        ...emptyResult(),
        text: totalText,
        usage: { inputTokens, outputTokens },
        finishReason: "max_steps",
      },
      steps,
    };
  }

  private async isApproved(
    tool: AgentTool,
    call: ToolCall,
    approve: AgentRunOptions["approve"],
  ): Promise<boolean> {
    if (!approve) return false;
    try {
      return await approve({
        tool: call.name,
        args: call.arguments,
        summary: `${tool.definition.name} ${JSON.stringify(call.arguments).slice(0, 300)}`,
      });
    } catch {
      return false;
    }
  }

  private async dispatch(
    event: ModelEvent,
    options: AgentRunOptions,
    textParts: string[],
    toolCalls: ToolCall[],
    addUsage: (usage: { input: number; output: number }) => void,
  ): Promise<void> {
    if (event.type === "text_delta") {
      textParts.push(event.text);
      await options.onEvent?.({ type: "text_delta", text: event.text });
    } else if (event.type === "tool_call") {
      toolCalls.push(event.toolCall);
    } else if (event.type === "usage") {
      addUsage({ input: event.inputTokens, output: event.outputTokens });
      await options.onEvent?.({
        type: "usage",
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      });
    }
  }
}
