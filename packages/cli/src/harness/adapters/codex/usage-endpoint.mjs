// Codex's account endpoint as a second source of plan limits for `relo usage`, for when the newest session log holds no
// live window (a new session, a quiet week, the desktop app that writes none). Codex-only, so it lives with the Codex
// adapter: the config file name, the binary and the host are facts of Codex. It borrows the access token Codex wrote
// in auth.json (read-only: never refreshed, never rewritten, never printed or cached) and asks once per 5 minutes per
// Codex home; a failed attempt is cached too and a rate limit backs off. A local reading, not Relo state.
import descriptor from "./descriptor.mjs";
import { cachedReading, retryAfterMs, windowLabel } from "../../../shared/usage-cache.mjs";

export const ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
export const TTL_MS = 5 * 60_000;
const SIGN_IN = `Sign in with "${descriptor.installation.binaries[0]} login".`;
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined);

/** { accessToken, accountId } from the parsed auth.json, or undefined. Never refreshes or writes. */
export function credentialOf(auth) {
  const accessToken = text(auth?.tokens?.access_token);
  const accountId = text(auth?.tokens?.account_id);
  return accessToken && accountId ? { accessToken, accountId } : undefined;
}

/** Whether the access token's own `exp` claim (decoded, never verified) is already past. */
export function tokenExpired(accessToken, now) {
  try {
    const exp = JSON.parse(Buffer.from(String(accessToken).split(".")[1], "base64url").toString("utf8")).exp;
    return typeof exp === "number" && exp * 1000 <= now;
  } catch { return false; }
}

/** The main windows of a /wham/usage body: [{ kind, minutes, label, usedPercent, resetsAt }]. One unreadable window never drops its sibling. */
export function windowsOf(body, now) {
  const windows = [];
  for (const kind of ["primary", "secondary"]) {
    const window = body?.rate_limit?.[`${kind}_window`];
    const used = number(window?.used_percent);
    if (used === undefined) continue;
    const reset = number(window.reset_at);
    const after = number(window.reset_after_seconds);
    const resetsAt = reset ?? (after === undefined ? undefined : Math.round(now / 1000 + after));
    if (resetsAt === undefined) continue;
    const seconds = number(window.limit_window_seconds);
    const minutes = seconds && seconds > 0 ? Math.round(seconds / 60) : null;
    windows.push({ kind, minutes, label: windowLabel(minutes) ?? (kind === "primary" ? "Session" : "Longer"), usedPercent: Math.min(100, Math.max(0, used)), resetsAt });
  }
  return windows;
}

/**
 * The endpoint's reading for one Codex home: { windows, planName, readAt, hint } (windows may be an older reading kept
 * through a failure). `auth` is the parsed auth.json (or undefined), `stateDirectory` the CLI's state folder, `now` ms,
 * `fetcher(url, { headers, timeoutMs })` -> { status, retryAfter, json } is required (owner/usage/io.mjs has the real one). Never throws.
 */
export async function codexEndpointReading({ folder, folderKey, auth, stateDirectory, now, fetcher }) {
  const credential = credentialOf(auth);
  if (!credential) return { windows: [], planName: null, readAt: null, hint: SIGN_IN };
  if (tokenExpired(credential.accessToken, now)) return { windows: [], planName: null, readAt: null, hint: `Codex's sign-in expired. ${SIGN_IN}` };
  const reading = await cachedReading({
    stateDirectory, name: `codex-endpoint-${folderKey}`, now, ttlMs: TTL_MS,
    attempt: async () => {
      const response = await fetcher(ENDPOINT, { headers: {
        Authorization: `Bearer ${credential.accessToken}`, "ChatGPT-Account-Id": credential.accountId, Accept: "application/json", "Cache-Control": "no-cache, no-store",
      }, timeoutMs: 15_000 });
      if (response.status === 401 || response.status === 403) return { hint: SIGN_IN };
      if (response.status === 429) return { hint: "Codex asked to slow down; trying again later.", rateLimitedMs: retryAfterMs(response.retryAfter, now) };
      if (response.status < 200 || response.status >= 300) return { hint: response.status === 0 ? "Codex could not be reached; trying again later." : `Codex answered ${response.status}; trying again later.` };
      const windows = windowsOf(response.json, now);
      if (windows.length === 0) return { hint: "Codex reported no usage windows for this plan." };
      return { data: { windows, planName: text(response.json?.plan_type) } };
    },
  });
  const live = (reading.data?.windows ?? []).filter((window) => window.resetsAt * 1000 > now);
  return { windows: live, planName: reading.data?.planName ?? null, readAt: live.length > 0 ? reading.readAt : null, hint: live.length > 0 && !reading.hint ? null : reading.hint };
}
