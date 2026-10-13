import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { authorizationRateLimitBuckets, limitedAcrossBuckets } from "./device-authorization.js";

/**
 * Sign-up and sign-in answer anyone who can reach the server, so they are bounded per client
 * address and overall, like the CLI sign-in start. In-memory: one server process serves them.
 *
 * Sign-in also backs off per account (docs/HARDENING.md, gap 2): after a few wrong passwords for one
 * email, the next attempt waits longer each time. A browser that has signed in to that account before
 * carries a known-device cookie and skips both the account backoff and the overall limit, so someone
 * guessing (or filling the limits on purpose) cannot lock the owner out of their own browser.
 */
const LIMITS = {
  "sign-up": { client: 5, global: 30 },
  "sign-in": { client: 10, global: 120 },
} as const;
const WINDOW_MS = 60_000;
const attempts = new Map<string, number[]>();

const FREE_FAILURES = 5;
const MAX_BACKOFF_MS = 15 * 60_000;
const MAX_TRACKED_ACCOUNTS = 10_000;
const failures = new Map<string, { count: number; last: number }>();

export const KNOWN_DEVICE_COOKIE = "relo_known_device";
const KNOWN_DEVICE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
// Per process, like the limits it relaxes: after a restart there is nothing to skip.
const knownDeviceKey = randomBytes(32);

const normalizedEmail = (email: string) => email.trim().toLowerCase();
const knownDeviceTag = (email: string) =>
  createHmac("sha256", knownDeviceKey).update(`relo known device\n${normalizedEmail(email)}`).digest("base64url");

export function authAttemptLimited(context: Context, kind: keyof typeof LIMITS, now = Date.now(), knownDevice = false): Response | null {
  const limits = LIMITS[kind];
  const buckets = authorizationRateLimitBuckets(context)
    .filter((bucket) => !(knownDevice && bucket === "global"))
    .map((bucket) => `${kind}:${bucket}`);
  if (!limitedAcrossBuckets(attempts, buckets, limits.client, limits.global, WINDOW_MS, now)) return null;
  return context.json({ error: "rate_limited", message: "Too many attempts. Wait a minute and try again.",
    retryAfterSeconds: WINDOW_MS / 1000 }, 429, { "retry-after": String(WINDOW_MS / 1000) });
}

/** Whether this browser has signed in to `email` before (since the server started). */
export function isKnownDevice(context: Context, email: string): boolean {
  const presented = getCookie(context, KNOWN_DEVICE_COOKIE);
  if (!presented) return false;
  const expected = Buffer.from(knownDeviceTag(email));
  const actual = Buffer.from(presented);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The account's wait after repeated wrong passwords: 1 s after the fifth, doubling, at most 15 minutes. */
export function accountBackoff(context: Context, email: string, now = Date.now()): Response | null {
  const entry = failures.get(normalizedEmail(email));
  if (!entry || entry.count < FREE_FAILURES) return null;
  const waitMs = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (entry.count - FREE_FAILURES));
  const remaining = entry.last + waitMs - now;
  if (remaining <= 0) return null;
  const seconds = Math.ceil(remaining / 1000);
  return context.json({ error: "rate_limited", message: "Too many wrong passwords for this account. Wait and try again.",
    retryAfterSeconds: seconds }, 429, { "retry-after": String(seconds) });
}

export function recordSignInFailure(email: string, now = Date.now()): void {
  const key = normalizedEmail(email);
  if (!failures.has(key) && failures.size >= MAX_TRACKED_ACCOUNTS) {
    for (const [tracked, entry] of failures) if (entry.last < now - MAX_BACKOFF_MS) failures.delete(tracked);
    if (failures.size >= MAX_TRACKED_ACCOUNTS) failures.delete(failures.keys().next().value!);
  }
  const entry = failures.get(key);
  failures.set(key, { count: (entry?.count ?? 0) + 1, last: now });
}

/** Clears the account's failures and returns the known-device cookie for this browser. */
export function recordSignInSuccess(email: string, secure: boolean): string {
  failures.delete(normalizedEmail(email));
  return `${KNOWN_DEVICE_COOKIE}=${knownDeviceTag(email)}; Path=/api/auth; Max-Age=${KNOWN_DEVICE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** For tests: start every case with no recorded attempts. */
export function resetAuthAttempts(): void {
  attempts.clear();
  failures.clear();
}
