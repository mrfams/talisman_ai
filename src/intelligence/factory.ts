import type { Config } from "../core/config.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICompatibleProvider } from "./providers/openai.js";
import { ModelRouter } from "./router.js";
import type { ModelProvider } from "./types.js";

export function createModelRouter(config: Config): ModelRouter {
  const providers: ModelProvider[] = [];
  if (config.geminiApiKey) {
    providers.push(
      new OpenAICompatibleProvider({
        id: "gemini",
        apiKey: config.geminiApiKey,
        baseUrl: config.geminiBaseUrl,
        supports: (model) => model.startsWith("gemini"),
      }),
    );
  }
  if (config.openaiApiKey) {
    providers.push(
      new OpenAICompatibleProvider({
        apiKey: config.openaiApiKey,
        baseUrl: config.openaiBaseUrl,
        // A custom base URL serves whatever model it names; the public API serves
        // OpenAI-style names. Anthropic and Gemini have explicit routes.
        supports: (model) => !model.startsWith("claude") && !model.startsWith("gemini"),
      }),
    );
  }
  if (config.anthropicApiKey) {
    providers.push(new AnthropicProvider({ apiKey: config.anthropicApiKey }));
  }
  return new ModelRouter(providers, {
    defaultModel: config.defaultModel,
    fallbacks: config.modelFallbacks,
  });
}
