import { ProviderError, type ModelEvent, type ModelProvider, type ModelRequest } from "./types.js";

export interface RouteTarget {
  provider: ModelProvider;
  model: string;
}

export interface RouterOptions {
  defaultModel: string;
  fallbacks?: string[];
  /** When set, no other model may be used. Default-deny for model access. */
  allowedModels?: string[] | null;
}

/**
 * Chooses a provider for a model, then walks the fallback chain. A fallback only
 * happens before any event has been yielded, so a consumer never sees two
 * different answers spliced together.
 */
export class ModelRouter {
  lastUsed: { provider: string; model: string } | null = null;

  constructor(
    private readonly providers: ModelProvider[],
    private readonly options: RouterOptions,
  ) {}

  candidates(requested?: string): RouteTarget[] {
    const chain = [requested?.trim(), this.options.defaultModel, ...(this.options.fallbacks ?? [])]
      .filter((value): value is string => Boolean(value))
      .filter((value, index, all) => all.indexOf(value) === index);
    const allowed = this.options.allowedModels;
    const targets: RouteTarget[] = [];
    for (const model of chain) {
      if (allowed && !allowed.includes(model)) continue;
      const provider = this.providers.find((entry) => entry.supportsModel(model));
      if (!provider) continue;
      targets.push({ provider, model });
    }
    return targets;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const targets = this.candidates(request.model);
    if (targets.length === 0) {
      throw new ProviderError(
        `No configured provider serves model "${request.model}"`,
        "router",
        false,
      );
    }

    const failures: string[] = [];
    for (const target of targets) {
      let emitted = false;
      try {
        for await (const event of target.provider.stream({ ...request, model: target.model })) {
          if (!emitted) {
            emitted = true;
            this.lastUsed = { provider: target.provider.id, model: target.model };
          }
          yield event;
        }
        return;
      } catch (error) {
        if (emitted || request.signal?.aborted) throw error;
        failures.push(
          `${target.provider.id}/${target.model}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    throw new ProviderError(
      `Every model provider failed. ${failures.join(" | ")}`,
      "router",
      false,
    );
  }
}
