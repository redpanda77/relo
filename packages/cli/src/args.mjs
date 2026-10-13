import { UsageError } from "./errors.mjs";

const BOOLEAN_OPTIONS = new Set([
  "help",
  "json",
  "wait",
  "stdin",
  "open",
  "no-open",
  "clear-detail",
  "approval",
  "yes-no",
  "replace",
  "clear-progress",
  "version",
  "smoke",
  "markdown",
  "no-wait",
]);
const VALUE_OPTIONS = new Set([
  "client-name",
  "scope",
  "expires-in",
  "title",
  "summary",
  "format",
  "image",
  "url",
  "privacy",
  "privacy-mode",
  "device",
  "idempotency-key",
  "type",
  "timeout",
  "key",
  "name",
  "status",
  "detail",
  "progress",
  "progress-label",
  "step",
  "step-current",
  "style",
  "preset",
  "theme",
  "symbol",
  "accent-color",
  "stale-after",
  "if-sequence",
  "dismiss-after",
  "computer",
  "source",
  "project",
  "topic",
  "thread-name",
  "task-title",
  "primary-label",
  "secondary-label",
  "correlation-id",
  "callback-url",
  "callback-token-file",
  "api-url",
  "limit",
  "page-size",
  "secret-file",
  "notification",
  "cursor",
]);
const REPEATABLE_OPTIONS = new Set(["device", "scope", "step"]);
const FORBIDDEN_SECRET_OPTIONS = new Set(["token", "api-token", "secret", "authorization"]);

export function parseArgs(argv) {
  const positionals = [];
  const options = { device: [], scope: [] };
  let afterSeparator = false;
  let separatorAt;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!afterSeparator && argument === "--") {
      afterSeparator = true;
      separatorAt = positionals.length;
      continue;
    }
    if (afterSeparator || !argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const equalsAt = argument.indexOf("=");
    const name = argument.slice(2, equalsAt === -1 ? undefined : equalsAt);
    const inlineValue = equalsAt === -1 ? undefined : argument.slice(equalsAt + 1);
    if (FORBIDDEN_SECRET_OPTIONS.has(name)) {
      throw new UsageError(`--${name} is forbidden; credentials come from relo auth login (mode-0600 config file) or the RELO_TOKEN environment variable`);
    }
    if (BOOLEAN_OPTIONS.has(name)) {
      if (inlineValue !== undefined) throw new UsageError(`--${name} does not accept a value`);
      options[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new UsageError(`Unknown option: --${name}`);
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new UsageError(`--${name} requires a value`);
    }
    if (REPEATABLE_OPTIONS.has(name)) {
      const values = options[name] ?? [];
      values.push(value);
      options[name] = values;
    }
    else if (options[name] !== undefined) throw new UsageError(`--${name} may only be specified once`);
    else options[name] = value;
  }

  return { positionals, options, ...(separatorAt === undefined ? {} : { separatorAt }) };
}

export function parseDuration(
  value,
  { defaultSeconds, minimumSeconds = 1, maximumSeconds = 86_400 } = {},
) {
  if (value === undefined) return defaultSeconds;
  const match = String(value).match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/);
  if (!match) throw new UsageError(`Invalid duration: ${value}`);
  const multiplier =
    match[2] === "d" ? 86_400 : match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1;
  const seconds = Math.round(Number(match[1]) * multiplier);
  if (seconds < minimumSeconds || seconds > maximumSeconds) {
    throw new UsageError(`Duration must be between ${minimumSeconds}s and ${maximumSeconds}s`);
  }
  return seconds;
}

export function numberOption(value, name, { minimum, maximum, integer = false } = {}) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    throw new UsageError(`--${name} must be ${integer ? "an integer" : "a number"}`);
  }
  if (minimum !== undefined && parsed < minimum) throw new UsageError(`--${name} must be at least ${minimum}`);
  if (maximum !== undefined && parsed > maximum) throw new UsageError(`--${name} must be at most ${maximum}`);
  return parsed;
}

export function requireText(value, label, maximum = 2_000) {
  const text = String(value ?? "").trim();
  if (!text) throw new UsageError(`${label} is required`);
  if (Array.from(text).length > maximum) throw new UsageError(`${label} must be at most ${maximum} characters`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
    throw new UsageError(`${label} contains unsupported control characters`);
  }
  return text;
}

export function validateHttpsUrl(value, name) {
  if (value === undefined) return undefined;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new UsageError(`--${name} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") throw new UsageError(`--${name} must use HTTPS`);
  if (parsed.toString().length > 2_048) throw new UsageError(`--${name} must be at most 2048 characters`);
  return parsed.toString();
}

const BLOCKED_DESTINATION_SCHEMES = new Set([
  "http", "javascript", "vbscript", "data", "file", "blob", "about", "filesystem", "content",
]);

/** Tap destinations: https:// links, an app's own scheme (your-app://...), or shortcuts://. */
export function validateDestinationUrl(value, name) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new UsageError(`--${name} must be a valid URL`, {
      hint: "Use https://..., an app link such as your-app://path, or shortcuts://run-shortcut?name=...",
    });
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (!/^[a-z][a-z0-9+.-]{0,31}$/.test(scheme) || BLOCKED_DESTINATION_SCHEMES.has(scheme)
    || parsed.username || parsed.password || (scheme === "https" && !parsed.hostname)
    || text.length <= scheme.length + 1) {
    throw new UsageError(`--${name} cannot use ${scheme}: links`, {
      hint: "Use https://..., an app link such as your-app://path, or shortcuts://run-shortcut?name=...",
    });
  }
  if (text.length > 2_048) throw new UsageError(`--${name} must be at most 2048 characters`);
  return scheme === "https" ? parsed.toString() : text;
}

export function validatePublicHttpsUrl(value, name) {
  const normalized = validateHttpsUrl(value, name);
  if (normalized === undefined) return undefined;
  const hostname = new URL(normalized).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new UsageError(`--${name} must use a public HTTPS URL`);
  }
  const ipv4 = hostname.split(".").map(Number);
  if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [first, second, third] = ipv4;
    if (
      first === 0 || first === 10 || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 192 && second === 0)
      || (first === 198 && (second === 18 || second === 19))
      || (first === 198 && second === 51 && third === 100)
      || (first === 203 && second === 0 && third === 113)
      || first >= 224
    ) throw new UsageError(`--${name} must use a public HTTPS URL`);
  }
  if (
    hostname === "::" || hostname === "::1" || hostname.startsWith("fc")
    || hostname.startsWith("fd") || /^fe[89ab]/.test(hostname)
    || hostname.startsWith("ff") || hostname.startsWith("2001:db8:")
    || hostname.startsWith("::ffff:")
  ) throw new UsageError(`--${name} must use a public HTTPS URL`);
  return normalized;
}
