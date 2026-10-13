import { UsageError } from "./errors.mjs";
import { optionHint } from "./suggest.mjs";

const BOOLEAN_OPTIONS = new Set([
  "help",
  "once",
  "notification-only",
  "new",
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
  "full",
  "clear",
  "next-step",
  "global",
  "dry-run",
  "remove",
  "move",
  "again",
  "check",
  "rollback",
  "hooks",
  "mcp",
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
  "since",
  "key",
  "name",
  "status",
  "detail",
  "progress",
  "progress-label",
  "step",
  "steps",
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
  "account",
  "source",
  "project",
  "topic",
  "thread-name",
  "task-title",
  "primary-label",
  "secondary-label",
  "option",
  "correlation-id",
  "callback-url",
  "callback-token-file",
  "api-url",
  "limit",
  "page-size",
  "secret-file",
  "notification",
  "cursor",
  "file",
  "agent",
  "dir",
  "profile",
  "version",
]);
const REPEATABLE_OPTIONS = new Set(["device", "scope", "step", "file", "option"]);
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
    // `relo setup --project` is a flag; everywhere else --project names the work's project.
    // `relo update --version X` names a release; everywhere else --version is the flag that prints this CLI's version.
    const valued = name === "version" && positionals[0] === "update";
    if ((BOOLEAN_OPTIONS.has(name) && !valued) || (name === "project" && positionals[0] === "setup")) {
      if (inlineValue !== undefined) throw new UsageError(`--${name} does not accept a value`);
      options[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) {
      const known = [...BOOLEAN_OPTIONS, ...VALUE_OPTIONS];
      throw new UsageError(`Unknown option: --${name}`, { hint: optionHint(name, positionals, known) });
    }
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

const PROGRESS_HINT = "Use 0.4, 40% or 2/5";

/** A progress fraction from 0.4, "40%" or "2/5". A bare number from 1 to 100 is ambiguous and rejected. */
export function progressFraction(value, name = "progress") {
  if (value === undefined || value === null) return value;
  const flag = `--${name}`;
  const text = String(value).trim();
  const round = (fraction) => Math.round(fraction * 1_000_000) / 1_000_000;
  let match = text.match(/^(\d+(?:\.\d+)?)\s*%$/u);
  if (match) {
    const percent = Number(match[1]);
    if (percent > 100) throw new UsageError(`${flag} ${text} is more than 100%`, { hint: PROGRESS_HINT });
    return round(percent / 100);
  }
  match = text.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/u);
  if (match) {
    const done = Number(match[1]);
    const total = Number(match[2]);
    if (total <= 0 || done > total) {
      throw new UsageError(`${flag} ${text} must be done/total with 0 <= done <= total`, { hint: PROGRESS_HINT });
    }
    return round(done / total);
  }
  const number = Number(text);
  if (text === "" || !Number.isFinite(number)) {
    throw new UsageError(`${flag} must be a number from 0 to 1, a percent like 40%, or a fraction like 2/5`, { hint: PROGRESS_HINT });
  }
  if (number >= 0 && number <= 1) return number;
  throw new UsageError(
    number > 1 && number <= 100 ? `${flag} ${text} is ambiguous` : `${flag} ${text} is out of range`,
    { hint: PROGRESS_HINT },
  );
}

/** "3/20" becomes "3 of 20" when the caller gave no label of their own; any other form has no automatic label. */
export function progressCountLabel(value) {
  const match = String(value ?? "").trim().match(/^(\d+)\s*\/\s*(\d+)$/u);
  return match ? `${Number(match[1])} of ${Number(match[2])}` : undefined;
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

/**
 * Where an answer callback may go: https anywhere, or http on a private network; never the
 * server's own localhost. Whether a private address is allowed is the server admin's setting.
 */
export function validateCallbackUrl(value, name) {
  let url;
  try { url = new URL(String(value)); } catch { throw new UsageError(`--${name} must be a URL`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UsageError(`--${name} must use https:// (or http:// on a private network)`);
  if (url.username || url.password || url.hash) throw new UsageError(`--${name} cannot carry credentials or a #fragment`);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || /^127\./u.test(host) || host === "::1" || host === "0.0.0.0"
    || /^169\.254\./u.test(host)) {
    throw new UsageError(`--${name} cannot be the server's own localhost or a link-local address`, {
      hint: "Use an address the Relo server can reach, for example your machine's Tailscale name",
    });
  }
  if (String(value).length > 2048) throw new UsageError(`--${name} is longer than 2,048 characters`);
  return url.toString();
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
