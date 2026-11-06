import { z } from "zod";

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === "") return fallback;
      return ["1", "true", "yes", "on"].includes(value.toLowerCase());
    });

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().optional(),
  TALISMAN_AUTO_MIGRATE: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  DATA_DIR: z.string().default(".data"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  ANTHROPIC_API_KEY: z.string().optional(),
  DEFAULT_MODEL: z.string().default("gpt-4.1-mini"),
  MODEL_FALLBACKS: z.string().default(""),
  TALISMAN_SEARCH_PROVIDER: z.enum(["searxng", "apinex"]).default("searxng"),
  TALISMAN_SEARCH_URL: z.string().optional(),
  TALISMAN_SEARCH_API_KEY: z.string().optional(),
  BROWSER_ALLOWED_HOSTS: z.string().default(""),
  BROWSER_ALLOW_PRIVATE: bool(false),
  /** auto: remote CDP if configured, HTTP reader on serverless, else Chromium. */
  TALISMAN_BROWSER_MODE: z.enum(["auto", "chromium", "cdp", "http", "none"]).default("auto"),
  BROWSER_WS_ENDPOINT: z.string().optional(),
  TALISMAN_BROWSER_CHANNEL: z.string().default("chrome"),
  /** Artifact bytes: filesystem for long-running hosts, Postgres on serverless. */
  TALISMAN_ARTIFACT_STORE: z.enum(["auto", "fs", "postgres"]).default("auto"),
  /** Shared secret for scheduled queue drains. Unset disables the endpoints. */
  CRON_SECRET: z.string().optional(),
  /** Wall-clock budget for one execution slice, in milliseconds. */
  TALISMAN_MAX_RUN_MS: z.coerce.number().int().positive().max(120_000).default(45_000),
  WORKER_ID: z.string().default("worker-1"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(16).default(2),
  VERCEL: z.string().optional(),
});

export type BrowserMode = "chromium" | "cdp" | "http" | "none";
export type ArtifactBackend = "fs" | "postgres";

export interface Config {
  nodeEnv: string;
  production: boolean;
  /** True when running as a serverless function: no persistent disk, no loop. */
  serverless: boolean;
  port: number;
  publicUrl: string;
  databaseUrl: string | undefined;
  autoMigrate: boolean;
  sessionSecret: string | null;
  credentialKey: string | null;
  dataDir: string;
  openaiApiKey: string | null;
  openaiBaseUrl: string;
  anthropicApiKey: string | null;
  defaultModel: string;
  modelFallbacks: string[];
  searchProvider: "searxng" | "apinex";
  searchUrl: string | null;
  searchApiKey: string | null;
  browserAllowedHosts: string[];
  browserAllowPrivate: boolean;
  browserMode: BrowserMode;
  browserWsEndpoint: string | null;
  browserChannel: string;
  artifactStore: ArtifactBackend;
  cronSecret: string | null;
  maxRunMs: number;
  workerId: string;
  workerConcurrency: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  const production = parsed.NODE_ENV === "production";
  const serverless = Boolean(parsed.VERCEL);
  if (production && !parsed.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is required when NODE_ENV=production");
  }
  if (production && parsed.BROWSER_ALLOW_PRIVATE) {
    throw new Error("BROWSER_ALLOW_PRIVATE must not be enabled in production");
  }

  const browserMode: BrowserMode =
    parsed.TALISMAN_BROWSER_MODE !== "auto"
      ? parsed.TALISMAN_BROWSER_MODE
      : parsed.BROWSER_WS_ENDPOINT
        ? "cdp"
        : serverless
          ? "http"
          : "chromium";

  const artifactStore: ArtifactBackend =
    parsed.TALISMAN_ARTIFACT_STORE === "auto"
      ? serverless
        ? "postgres"
        : "fs"
      : parsed.TALISMAN_ARTIFACT_STORE;

  const autoMigrate =
    parsed.TALISMAN_AUTO_MIGRATE === undefined || parsed.TALISMAN_AUTO_MIGRATE === ""
      ? !serverless
      : ["1", "true", "yes", "on"].includes(parsed.TALISMAN_AUTO_MIGRATE.toLowerCase());

  return {
    nodeEnv: parsed.NODE_ENV,
    production,
    serverless,
    port: parsed.PORT,
    publicUrl: parsed.PUBLIC_URL,
    databaseUrl: parsed.DATABASE_URL,
    autoMigrate,
    sessionSecret: parsed.SESSION_SECRET ?? null,
    credentialKey: parsed.CREDENTIAL_ENCRYPTION_KEY ?? null,
    dataDir: parsed.DATA_DIR,
    openaiApiKey: parsed.OPENAI_API_KEY ?? null,
    openaiBaseUrl: parsed.OPENAI_BASE_URL,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY ?? null,
    defaultModel: parsed.DEFAULT_MODEL,
    modelFallbacks: parsed.MODEL_FALLBACKS.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    searchProvider: parsed.TALISMAN_SEARCH_PROVIDER,
    searchUrl: parsed.TALISMAN_SEARCH_URL ?? null,
    searchApiKey: parsed.TALISMAN_SEARCH_API_KEY ?? parsed.OPENAI_API_KEY ?? null,
    browserAllowedHosts: parsed.BROWSER_ALLOWED_HOSTS.split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
    browserAllowPrivate: parsed.BROWSER_ALLOW_PRIVATE,
    browserMode,
    browserWsEndpoint: parsed.BROWSER_WS_ENDPOINT ?? null,
    browserChannel: parsed.TALISMAN_BROWSER_CHANNEL,
    artifactStore,
    cronSecret: parsed.CRON_SECRET ?? null,
    maxRunMs: parsed.TALISMAN_MAX_RUN_MS,
    workerId: parsed.WORKER_ID,
    workerConcurrency: parsed.WORKER_CONCURRENCY,
  };
}
