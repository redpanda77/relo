import { numberOption, requireText } from "./args.mjs";
import { ApiError, EXIT, NoDeliveryError, UsageError } from "./errors.mjs";

export const MAX_STDIN_INPUT_BYTES = 1024 * 1024;

export function result(command, data, { message } = {}) {
  return { exitCode: EXIT.OK, command, data, message };
}

export function assertNoExtra(positionals, expected, usage) {
  if (positionals.length !== expected) throw new UsageError(usage);
}

export function assertAtMostOne(positionals, usage) {
  if (positionals.length > 1) throw new UsageError(usage);
}

export function assertAllowedOptions(options, allowed) {
  const global = new Set(["help", "json"]);
  for (const [name, value] of Object.entries(options)) {
    if (global.has(name) || allowed.includes(name)) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value !== undefined && value !== false) throw new UsageError(`--${name} is not valid for this command`);
  }
}

export function joinedText(values) {
  return values.length === 0 ? undefined : values.join(" ");
}

export function validateIdempotencyKey(value, generate) {
  const candidate = value ?? `relo-cli:${generate()}`;
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(candidate)) {
    throw new UsageError("--idempotency-key must be 1-200 safe characters");
  }
  return candidate;
}

export function enumOption(value, name, allowed, defaultValue) {
  if (value === undefined) return defaultValue;
  if (!allowed.includes(value)) throw new UsageError(`--${name} must be one of: ${allowed.join(", ")}`);
  return value;
}

export function definedFields(value) {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

export function optionalText(value, label, maximum) {
  if (value === undefined || value === null) return value;
  return requireText(value, label, maximum);
}

export function booleanStdin(value, label, defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") throw new UsageError(`stdin ${label} must be a boolean`);
  return value;
}

export function shellQuote(value) {
  return `"${String(value).replace(/["\\$`]/gu, "\\$&")}"`;
}

export async function readStdinJson(stream = process.stdin) {
  let input = "";
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_STDIN_INPUT_BYTES) throw new UsageError("stdin JSON is too large");
    input += chunk;
  }
  try {
    return JSON.parse(input);
  } catch {
    throw new UsageError("stdin must contain valid JSON");
  }
}

export async function stdinObject(options, dependencies) {
  if (!options.stdin) return {};
  const value = await dependencies.readStdinJson();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError("stdin JSON must be an object");
  }
  return value;
}

export function stdinDeviceIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new UsageError("stdin deviceIds must be an array");
  return value;
}

export function nullableNumberOption(value, name, limits) {
  if (value === null) return null;
  return numberOption(value, name, limits);
}

export function deliveryGuard(payload) {
  const delivery = payload?.delivery ?? payload;
  if (
    !delivery ||
    !Number.isInteger(delivery.eligibleDevices) ||
    delivery.eligibleDevices < 0 ||
    !Number.isInteger(delivery.durableCommands) ||
    delivery.durableCommands < 0 ||
    !Number.isInteger(delivery.apnsJobs) ||
    delivery.apnsJobs < 0
  ) {
    throw new ApiError("Mutation response did not include a valid delivery summary.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  if (delivery.durableCommands === 0) {
    throw new NoDeliveryError(undefined, {
      eventId: payload?.event?.id ?? payload?.eventId ?? payload?.id,
      eligibleDevices: delivery.eligibleDevices,
      durableCommands: delivery.durableCommands,
    });
  }
  return payload;
}

export function validateDeviceId(value) {
  return typeof value === "string" && /^dev_[A-Za-z0-9_-]{12,}$/.test(value);
}

export function validateCanonicalId(value, prefix) {
  return typeof value === "string" && new RegExp(
    `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    "u",
  ).test(value);
}

export function isIsoTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && !Number.isNaN(Date.parse(value));
}

export async function getAuthenticated(dependencies) {
  const config = await dependencies.loadConfig(dependencies.configPath());
  const client = dependencies.clientFactory(config);
  return { config, client };
}
