// Shared plumbing for `relo usage` readings that cost a network call or a process: one small cache file per account in
// <state>/usage/, so the Mac app's 30-second poll never turns into 30-second requests. A failed attempt is cached too
// (the next try waits for the interval), and a rate-limit answer backs off, doubling per consecutive hit. The last good
// reading is kept through failures. A local reading, not Relo state: no outbox, no server. Never throws.
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.mjs";

export const BACKOFF_FLOOR_MS = 60_000;
export const BACKOFF_CEILING_MS = 15 * 60_000;

/** "Claude" or "Claude · work": the name a person sees for an account. */
export const displayName = (product, profile) => (profile ? `${product} · ${profile}` : product);

/** A readable slug plus a short stable hash of a path: the cache file name key. */
export function folderKey(folder) {
  const slug = (String(folder).split(/[\\/]/u).filter(Boolean).pop() ?? "x").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 24) || "x";
  return `${slug}-${createHash("sha256").update(String(folder)).digest("hex").slice(0, 8)}`;
}

/** "5-hour", "Week", "Month", "3-day", "45-minute" for a window length in minutes; null when unknown. */
export function windowLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes < 60) return `${Math.round(minutes)}-minute`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}-hour`;
  const days = Math.round(minutes / 1440);
  return days === 7 ? "Week" : days >= 28 && days <= 31 ? "Month" : `${days}-day`;
}

/** A Retry-After header (seconds or an HTTP date) as milliseconds from `now`; 0 when absent or unreadable. */
export function retryAfterMs(header, now) {
  const value = String(header ?? "").trim();
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/u.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * One cached attempt. `attempt()` resolves `{ data }` on success, or `{ hint, rateLimitedMs? }` on failure (rateLimitedMs:
 * the server's Retry-After in ms, 0 when none, set only for a rate limit); a throw counts as a failure. Within `ttlMs` of the
 * last attempt, or before a rate-limit deadline, the cached file answers and `attempt` does not run. Resolves
 * `{ data, readAt, hint }`: the last good data (undefined before the first), when it was read, and why the newest attempt failed.
 */
export async function cachedReading({ stateDirectory, name, now, ttlMs, attempt }) {
  const directory = join(stateDirectory, "usage");
  const path = join(directory, `${name}.json`);
  let cached;
  try { cached = JSON.parse(await readFile(path, "utf8")); } catch { cached = undefined; }
  if (!cached || typeof cached !== "object") cached = undefined;
  const answer = (from) => ({ data: from?.data ?? undefined, readAt: isNumber(from?.readAt) ? from.readAt : null, hint: typeof from?.hint === "string" ? from.hint : null });
  const tried = isNumber(cached?.attemptedAt) ? cached.attemptedAt : -Infinity;
  const waitingUntil = isNumber(cached?.retryAt) ? cached.retryAt : -Infinity;
  if (cached && tried <= now && (now - tried < ttlMs || now < waitingUntil)) return answer(cached);
  let outcome;
  try { outcome = await attempt(); } catch { outcome = { hint: "Could not read this right now; it will retry." }; }
  const next = outcome && "data" in outcome && outcome.data !== undefined
    ? { attemptedAt: now, readAt: now, data: outcome.data, hint: null, retryAt: null, strikes: 0 }
    : { attemptedAt: now, readAt: cached?.readAt ?? null, data: cached?.data ?? null, hint: outcome?.hint ?? "Could not read this right now; it will retry.", ...limited(outcome, cached, now) };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFileAtomic(path, JSON.stringify(next));
  } catch { /* the reading still counts */ }
  return answer(next);
}

function limited(outcome, cached, now) {
  if (!isNumber(outcome?.rateLimitedMs)) return { retryAt: null, strikes: 0 };
  const strikes = (isNumber(cached?.strikes) ? cached.strikes : 0) + 1;
  const wait = Math.min(BACKOFF_CEILING_MS, Math.max(BACKOFF_FLOOR_MS * 2 ** Math.min(strikes - 1, 4), outcome.rateLimitedMs));
  return { retryAt: now + wait, strikes };
}
