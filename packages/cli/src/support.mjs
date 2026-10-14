import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { numberOption, requireText } from "./args.mjs";
import { CALLER_TYPES } from "./caller.mjs";
import { ApiError, EXIT, NoDeliveryError, UsageError } from "./errors.mjs";
import { skillAdvice } from "./skill.mjs";
import { isTrustNote } from "./trust.mjs";

export const MAX_STDIN_INPUT_BYTES = 1024 * 1024;

export function result(command, data, { message, notes } = {}) {
  return { exitCode: EXIT.OK, command, data, message, ...(notes?.length ? { notes } : {}) };
}

/** `--dry-run` outcome: what would be sent, validated locally, with no request made. */
export function dryRunResult(command, body, notes) {
  return result("dry-run", { dryRun: true, would: { command, body } }, { notes });
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

// Once per session (DOGFOOD #1, #2): an agent session sees each trust note once per change and the
// skill-vs-CLI version warning once; `relo keys status` and `relo doctor` always show everything.
// The seen-set is local: <state>/relo/seen-notes.json, { sessionKey: { noteHash: seenAtMs } }.
const SEEN_DAYS = 7;
const ALWAYS_EVERYTHING = new Set(["help", "version", "schema", "doctor", "keys.status", "skill.status", "skill.install",
  "skill.remove", "update", "setup", "dry-run"]);

export function seenNotesPath(env = process.env) {
  if (env.RELO_SEEN_NOTES_PATH) return env.RELO_SEEN_NOTES_PATH;
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "relo", "seen-notes.json");
}

const noteHash = (note) => createHash("sha256").update(note).digest("base64url").slice(0, 22);

/** The installed skill differs from this CLI: one line, or undefined (missing is not drift; doctor says that). */
export function skillDriftNote(dependencies) {
  try {
    const advice = skillAdvice({ env: dependencies.env ?? {}, home: dependencies.home, cliVersion: dependencies.version });
    return advice.state === "outdated" ? advice.hint : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The command's output with trust notes this agent session has already seen removed and, the first
 * time, the skill version warning added. Other callers (the owner's shell, scripts) are unchanged.
 */
export async function withSessionNotes(output, dependencies) {
  const caller = dependencies.caller;
  if (caller?.type !== CALLER_TYPES.AGENT_SESSION || !caller.sessionKey || ALWAYS_EVERYTHING.has(output?.command)) return output;
  const drift = skillDriftNote(dependencies);
  const candidates = [...(output.notes ?? []).filter(isTrustNote), ...(drift ? [drift] : [])];
  if (candidates.length === 0) return output;
  const path = seenNotesPath({ ...process.env, ...dependencies.env });
  let seen = {};
  try { seen = JSON.parse(await readFile(path, "utf8")); } catch { seen = {}; }
  if (!seen || typeof seen !== "object" || Array.isArray(seen)) seen = {};
  const now = dependencies.now?.() ?? Date.now();
  for (const [scope, entries] of Object.entries(seen)) {
    const kept = Object.fromEntries(Object.entries(entries ?? {}).filter(([, at]) => now - at < SEEN_DAYS * 86_400_000));
    if (Object.keys(kept).length) seen[scope] = kept; else delete seen[scope];
  }
  const mine = seen[caller.sessionKey] ??= {};
  const fresh = new Set(candidates.filter((note) => mine[noteHash(note)] === undefined));
  for (const note of fresh) mine[noteHash(note)] = now;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(seen), { mode: 0o600 });
    await rename(temporary, path);
  } catch {
    // A read-only state directory means notes repeat; never a failed command.
  }
  const notes = [...(output.notes ?? []).filter((note) => !isTrustNote(note) || fresh.has(note)),
    ...(drift && fresh.has(drift) ? [drift] : [])];
  const { notes: _old, ...rest } = output;
  return { ...rest, ...(notes.length ? { notes } : {}) };
}
