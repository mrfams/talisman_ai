import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAICompatibleProvider } from "../src/intelligence/providers/openai.js";
import { AnthropicProvider } from "../src/intelligence/providers/anthropic.js";
import { MockProvider } from "../src/intelligence/providers/mock.js";
import { ModelRouter } from "../src/intelligence/router.js";
import { createModelRouter } from "../src/intelligence/factory.js";
import type { Config } from "../src/core/config.js";
import { Agent, type AgentTool } from "../src/intelligence/agent.js";
import { buildContext, selectMemories } from "../src/intelligence/context.js";
import { cosineSimilarity, selectMemoriesSemantic } from "../src/intelligence/embedding.js";
import type { ModelEvent } from "../src/intelligence/types.js";

async function fakeServer(handler: (body: string) => string): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(handler(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("OpenAI-compatible provider streams text, tool calls and usage", async () => {
  let received: any;
  const { server, url } = await fakeServer((body) => {
    received = JSON.parse(body);
    return [
      'data: {"choices":[{"delta":{"content":"Hello "}}]}',
      'data: {"choices":[{"delta":{"content":"world"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"create_task","arguments":"{\\"goal\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"read docs\\"}"}}]},"finish_reason":"tool_calls"}]}',
      'data: {"usage":{"prompt_tokens":5,"completion_tokens":7}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
  });
  try {
    const provider = new OpenAICompatibleProvider({ apiKey: "test", baseUrl: url });
    const events = await collect(
      provider.stream({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "create_task",
            description: "create",
            parameters: { type: "object", properties: { goal: { type: "string" } } },
          },
        ],
      }),
    );
    const text = events
      .filter((event): event is Extract<ModelEvent, { type: "text_delta" }> => event.type === "text_delta")
      .map((event) => event.text)
      .join("");
    assert.equal(text, "Hello world");
    const tool = events.find((event) => event.type === "tool_call");
    assert.ok(tool && tool.type === "tool_call");
    assert.equal(tool.toolCall.name, "create_task");
    assert.deepEqual(tool.toolCall.arguments, { goal: "read docs" });
    const usage = events.find((event) => event.type === "usage");
    assert.ok(usage && usage.type === "usage" && usage.outputTokens === 7);
    assert.equal(received.tools[0].function.name, "create_task");
    assert.equal(received.stream, true);
  } finally {
    server.close();
  }
});

test("Anthropic provider converts tool_use blocks", async () => {
  const { server, url } = await fakeServer(() =>
    [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check."}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"remember"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"content\\":\\"likes tea\\"}"}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
      "",
    ].join("\n\n"),
  );
  try {
    const provider = new AnthropicProvider({ apiKey: "test", baseUrl: url });
    const events = await collect(
      provider.stream({ model: "claude-test", messages: [{ role: "user", content: "hi" }] }),
    );
    const tool = events.find((event) => event.type === "tool_call");
    assert.ok(tool && tool.type === "tool_call");
    assert.equal(tool.toolCall.id, "toolu_1");
    assert.deepEqual(tool.toolCall.arguments, { content: "likes tea" });
    const usage = events.find((event) => event.type === "usage");
    assert.ok(usage && usage.type === "usage" && usage.inputTokens === 4);
  } finally {
    server.close();
  }
});

test("direct Gemini is a distinct provider and is tried before gateway fallbacks", async () => {
  const config = {
    openaiApiKey: "gateway-key",
    openaiBaseUrl: "https://gateway.test/v1",
    geminiApiKey: "gemini-key",
    geminiBaseUrl: "https://gemini.test/v1beta/openai",
    geminiModel: "gemini-2.5-flash",
    anthropicApiKey: null,
    defaultModel: "free/gpt-6-luna",
    // loadConfig puts direct Gemini before the configured gateway fallbacks.
    modelFallbacks: ["gemini-2.5-flash", "free/gemini-3.8-flash"],
  } as unknown as Config;
  const router = createModelRouter(config);
  const candidates = router.candidates("");
  assert.equal(candidates[0]?.provider.id, "openai-compatible");
  assert.equal(candidates[1]?.provider.id, "gemini");
  assert.equal(candidates[1]?.model, "gemini-2.5-flash");
  assert.equal(candidates[2]?.provider.id, "openai-compatible");
});

test("router falls back before emitting anything and honours an allowlist", async () => {
  const provider = new MockProvider([{ error: new Error("primary down") }, { text: "backup answer" }]);
  const router = new ModelRouter([provider], { defaultModel: "primary", fallbacks: ["backup"] });
  const events = await collect(router.stream({ model: "primary", messages: [] }));
  assert.equal(
    events.filter((event) => event.type === "text_delta").map((event) => (event as any).text).join(""),
    "backup answer",
  );
  assert.equal(router.lastUsed?.model, "backup");

  const denied = new ModelRouter([provider], {
    defaultModel: "primary",
    allowedModels: ["other"],
  });
  await assert.rejects(collect(denied.stream({ model: "primary", messages: [] })), /No configured provider/);
});

test("agent executes tools and enforces approval, default deny", async () => {
  let executed = 0;
  const echo: AgentTool = {
    definition: {
      name: "echo",
      description: "echo",
      parameters: { type: "object", properties: { value: { type: "string" } } },
    },
    requiresApproval: true,
    execute: async (args) => {
      executed += 1;
      return { echoed: args.value };
    },
  };
  const provider = new MockProvider([
    { toolCalls: [{ id: "c1", name: "echo", arguments: { value: "hi" } }] },
    { text: "finished" },
  ]);
  const router = new ModelRouter([provider], { defaultModel: "m" });

  const deniedEvents: string[] = [];
  const deniedResult = await new Agent(router, [echo]).run({
    messages: [{ role: "user", content: "go" }],
    onEvent: (event) => {
      deniedEvents.push(event.type);
    },
  });
  assert.equal(executed, 0);
  assert.equal(deniedResult.result.text, "finished");
  assert.ok(deniedEvents.includes("tool_end"));

  const allowedRouter = new ModelRouter(
    [
      new MockProvider([
        { toolCalls: [{ id: "c2", name: "echo", arguments: { value: "hi" } }] },
        { text: "finished" },
      ]),
    ],
    { defaultModel: "m" },
  );
  const allowed = await new Agent(allowedRouter, [echo]).run({
    messages: [{ role: "user", content: "go" }],
    approve: async () => true,
  });
  assert.equal(executed, 1);
  assert.equal(allowed.result.text, "finished");
});

test("semantic memory ranks by meaning and falls back to keywords", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  const memories = [
    {
      id: "a",
      orgId: "o",
      userId: "u",
      kind: "preference",
      content: "Prefers a short brief before 9am.",
      source: null,
      embedding: [1, 0, 0],
      embeddingModel: "test",
      createdAt: "",
      updatedAt: "",
    },
    {
      id: "b",
      orgId: "o",
      userId: "u",
      kind: "fact",
      content: "Lives in Lisbon.",
      source: null,
      embedding: [0, 1, 0],
      embeddingModel: "test",
      createdAt: "",
      updatedAt: "",
    },
  ];
  const semantic = selectMemoriesSemantic(memories, "anything", [0.95, 0.05, 0]);
  assert.equal(semantic[0]?.id, "a");

  const fallback = selectMemoriesSemantic(
    memories.map((memory) => ({ ...memory, embedding: null })),
    "Where does the user live?",
    null,
  );
  assert.equal(fallback[0]?.id, "b");
});

test("context keeps recent history and injects relevant memories", () => {
  const memories = selectMemories(
    [
      { kind: "preference", content: "The user prefers British spelling." },
      { kind: "fact", content: "The user lives in Lisbon." },
    ],
    "What is the weather where I live?",
  );
  assert.equal(memories.length, 1);
  assert.match(memories[0]!.content, /Lisbon/);

  const context = buildContext({
    system: "system",
    memories,
    history: Array.from({ length: 40 }, (_, index) => ({
      role: "user" as const,
      content: `message ${index} ${"x".repeat(200)}`,
    })),
    budgetTokens: 500,
  });
  assert.equal(context[0]!.role, "system");
  assert.match(String(context[0]!.content), /Lisbon/);
  assert.ok(context.some((message) => String(message.content).includes("omitted")));
  assert.ok(context.length < 10);
});
