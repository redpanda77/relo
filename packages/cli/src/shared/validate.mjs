// Option and value checks shared by every command: identical rules for every caller type. No I/O.
import { UsageError } from "./errors.mjs";

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

export function requireText(value, label, maximum = 2_000) {
  const text = String(value ?? "").trim();
  if (!text) throw new UsageError(`${label} is required`);
  if (Array.from(text).length > maximum) throw new UsageError(`${label} must be at most ${maximum} characters`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
    throw new UsageError(`${label} contains unsupported control characters`);
  }
  return text;
}

export function assertNoExtra(positionals, expected, usage) {
  if (positionals.length !== expected) throw new UsageError(usage);
}

export function assertAtMostOne(positionals, usage) {
  if (positionals.length > 1) throw new UsageError(usage);
}

export function assertAllowedOptions(options, allowed) {
  const global = new Set(["help", "json", "full"]);
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

/** Cuts at the last word boundary that fits (hard cut when there is none) and ends with an ellipsis. */
export function shortenText(text, maximum) {
  const chars = Array.from(text);
  if (chars.length <= maximum) return text;
  const room = chars.slice(0, Math.max(1, maximum - 1));
  const boundary = /\s/u.test(chars[room.length] ?? "") ? room.length
    : room.findLastIndex((character) => /\s/u.test(character));
  const kept = boundary > 0 ? room.slice(0, boundary) : room;
  return `${kept.join("").replace(/[\s,;:.\-–—]+$/u, "")}…`;
}

/**
 * Display text (title, status, detail, labels, summaries) that is too long is shortened, never
 * refused: a failed round trip costs more than a trimmed line. `notes` collects what was shortened.
 */
export function fitText(value, label, maximum, notes) {
  if (value === undefined || value === null) return value;
  const text = requireText(value, label, 100_000);
  if (Array.from(text).length <= maximum) return text;
  notes?.push(`${label.replace(/^--/u, "").toLowerCase()} shortened to ${maximum} characters`);
  return shortenText(text, maximum);
}

export function fitRequiredText(value, label, maximum, notes) {
  requireText(value, label, 100_000);
  return fitText(value, label, maximum, notes);
}

export function shellQuote(value) {
  return `"${String(value).replace(/["\\$`]/gu, "\\$&")}"`;
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
