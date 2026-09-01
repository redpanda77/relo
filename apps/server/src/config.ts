import { readFile } from "node:fs/promises";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8180),
  APP_URL: z.url().default("http://127.0.0.1:8180"),
  RELO_RELEASE_IDENTITY: z.string().trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/).optional(),
  BETTER_AUTH_SECRET_FILE: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  BOOTSTRAP_OWNER_HANDLE: z.string().min(1).default("owner"),
  BOOTSTRAP_OWNER_TOKEN_FILE: z.string().optional(),
  APNS_MODE: z.enum(["disabled", "production", "sandbox"]).default("disabled"),
  APNS_TEAM_ID: optionalTrimmed(z.string().regex(/^[A-Z0-9]{10}$/)),
  APNS_KEY_ID: optionalTrimmed(z.string().regex(/^[A-Z0-9]{10}$/)),
  APNS_KEY_FILE: optionalTrimmed(z.string().max(1024)),
  APNS_TOPIC: optionalTrimmed(z.string().min(3).max(255)),
  APNS_KEY_SCOPE: z.preprocess(
    emptyStringAsUndefined,
    z.enum(["team-scoped", "topic-specific"]).optional(),
  ),
  APNS_KEY_ENVIRONMENT: z.preprocess(
    emptyStringAsUndefined,
    z.enum(["sandbox", "production", "both"]).optional(),
  ),
  APNS_DUAL_ENVIRONMENT_CONFIRMED: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  ),
  APNS_ASSOCIATED_TOPICS: optionalTrimmed(z.string().max(2048)),
  APNS_CONFIGURATION_GENERATION: optionalTrimmed(
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
  ),
  APNS_LOCAL_CONCURRENCY_CAP: z.coerce.number().int().min(1).max(1024).default(32),
  APNS_CUTOVER_AT: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.iso.datetime().optional(),
  ),
  WORKER_POLL_MS: z.coerce.number().int().min(250).default(2000),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
});

export type Config = z.infer<typeof schema>;

function emptyStringAsUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

function optionalTrimmed(value: z.ZodString) {
  return z.preprocess(
    (input) => typeof input === "string" && input.trim() === "" ? undefined : input,
    value.trim().optional(),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}

export async function readSecretFile(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error(`Secret file is empty: ${path}`);
  return value;
}

export async function loadAccountAuthSecret(config: Config): Promise<string> {
  const secret = config.BETTER_AUTH_SECRET ?? await readSecretFile(config.BETTER_AUTH_SECRET_FILE);
  if (!secret || secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET or BETTER_AUTH_SECRET_FILE with at least 32 characters is required");
  }
  return secret;
}
