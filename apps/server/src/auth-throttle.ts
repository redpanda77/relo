import type { Context } from "hono";
import { authorizationRateLimitBuckets } from "./device-authorization.js";

/**
 * Sign-up and sign-in answer anyone who can reach the server, so they are bounded per client
 * address and overall, like the CLI sign-in start. In-memory: one server process serves them.
 */
const LIMITS = {
  "sign-up": { client: 5, global: 30 },
  "sign-in": { client: 10, global: 120 },
} as const;
const WINDOW_MS = 60_000;
const attempts = new Map<string, number[]>();

export function authAttemptLimited(context: Context, kind: keyof typeof LIMITS, now = Date.now()): Response | null {
  const limits = LIMITS[kind];
  let rejected = false;
  for (const bucket of authorizationRateLimitBuckets(context)) {
    const key = `${kind}:${bucket}`;
    const recent = (attempts.get(key) ?? []).filter((at) => at > now - WINDOW_MS);
    recent.push(now);
    attempts.set(key, recent);
    if (recent.length > (bucket === "global" ? limits.global : limits.client)) rejected = true;
  }
  if (!rejected) return null;
  return context.json({ error: "rate_limited", message: "Too many attempts. Wait a minute and try again.",
    retryAfterSeconds: WINDOW_MS / 1000 }, 429, { "retry-after": String(WINDOW_MS / 1000) });
}

/** For tests: start every case with no recorded attempts. */
export function resetAuthAttempts(): void {
  attempts.clear();
}
