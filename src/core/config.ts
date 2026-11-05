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
  TALISMAN_AUTO_MIGRATE: bool(true),
  SESSION_SECRET: z.string().optional(),
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  DATA_DIR: z.string().default(".data"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  ANTHROPIC_API_KEY: z.string().optional(),
  DEFAULT_MODEL: z.string().default("gpt-4.1-mini"),
  MODEL_FALLBACKS: z.string().default(""),
  TALISMAN_SEARCH_URL: z.string().optional(),
  BROWSER_ALLOWED_HOSTS: z.string().default(""),
  BROWSER_ALLOW_PRIVATE: bool(false),
  WORKER_ID: z.string().default("worker-1"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(16).default(2),
});

export interface Config {
  nodeEnv: string;
  production: boolean;
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
  searchUrl: string | null;
  browserAllowedHosts: string[];
  browserAllowPrivate: boolean;
  workerId: string;
  workerConcurrency: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  const production = parsed.NODE_ENV === "production";
  if (production && !parsed.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is required when NODE_ENV=production");
  }
  if (production && parsed.BROWSER_ALLOW_PRIVATE) {
    throw new Error("BROWSER_ALLOW_PRIVATE must not be enabled in production");
  }
  return {
    nodeEnv: parsed.NODE_ENV,
    production,
    port: parsed.PORT,
    publicUrl: parsed.PUBLIC_URL,
    databaseUrl: parsed.DATABASE_URL,
    autoMigrate: parsed.TALISMAN_AUTO_MIGRATE,
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
    searchUrl: parsed.TALISMAN_SEARCH_URL ?? null,
    browserAllowedHosts: parsed.BROWSER_ALLOWED_HOSTS.split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
    browserAllowPrivate: parsed.BROWSER_ALLOW_PRIVATE,
    workerId: parsed.WORKER_ID,
    workerConcurrency: parsed.WORKER_CONCURRENCY,
  };
}
