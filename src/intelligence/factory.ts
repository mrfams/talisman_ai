import type { Config } from "../core/config.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICompatibleProvider } from "./providers/openai.js";
import { ModelRouter } from "./router.js";
import type { ModelProvider } from "./types.js";

export function createModelRouter(config: Config): ModelRouter {
  const providers: ModelProvider[] = [];
  if (config.openaiApiKey) {
    providers.push(
      new OpenAICompatibleProvider({
        apiKey: config.openaiApiKey,
        baseUrl: config.openaiBaseUrl,
        // A custom base URL serves whatever model it names; the public API serves
        // OpenAI-style names. Anthropic models are routed to Anthropic explicitly.
        supports: (model) => !model.startsWith("claude"),
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
