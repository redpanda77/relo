// The observed wire (EDGE.2): one phase snapshot per transition (or heartbeat), queued in the outbox
// and sent with the harness credential. The body is built from a whitelist only; prompts, tool names,
// tool input/output and transcript paths cannot reach it because normalize() never returns them.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const OBSERVED_ROUTE = "/api/agent-sessions/observed";

/** The wire body for a state that was just marked sent. */
function observedBody(state, labels = {}) {
  const body = {
    session: state.session,
    harness: state.harness,
    phase: state.phase,
    phaseSince: state.phaseSince,
    lastSeenAt: state.lastSeenAt,
    openToolSince: state.openToolSince ?? null,
    seq: state.seq,
  };
  // Context use (whole percent) and session cost (cents): present only once the status line wrapper has read them.
  if (Number.isInteger(state.contextPct)) body.contextPct = state.contextPct;
  if (Number.isFinite(state.costUsd)) body.costUsd = state.costUsd;
  // Tokens in the context window, read by a hook from the transcript (the only reading where no status line runs).
  if (Number.isInteger(state.contextTokens)) body.contextTokens = state.contextTokens;
  // The Relo MCP server's heartbeat of a session at a permission prompt: proves it is alive, repeats the phase.
  if (state.heartbeat === true && state.phase === "waiting") body.heartbeat = true;
  if (state.phase === "ended") body.endReason = state.endReason === "gone" || state.endReason === "mcp" ? state.endReason : "hook";
  for (const key of ["project", "computer", "account"]) {
    if (typeof labels[key] === "string" && labels[key]) body[key] = labels[key];
  }
  return body;
}

/**
 * The outbox entry for a snapshot. `meta.names` (handle → name, local only) and `meta.title` (the
 * session's name) let the flusher seal them for the phones at send time, which needs the network; they
 * are never part of the request in the clear.
 */
export function observedEntry(state, labels, names, title) {
  return {
    route: OBSERVED_ROUTE,
    method: "POST",
    body: observedBody(state, labels),
    idempotencyKey: `obs-${createHash("sha256").update(`${state.session}:${state.seq}`).digest("base64url").slice(0, 32)}`,
    credential: "harness",
    sessionKey: state.session,
    ...(state.phase !== "ended" && ((names && Object.keys(names).length > 0) || title)
      ? { meta: { ...(names && Object.keys(names).length > 0 ? { names } : {}), ...(title ? { title } : {}) } } : {}),
  };
}

/** How often a session whose names are already delivered looks for recipients that appeared since (a newly linked browser). */
export const RECIPIENT_RECHECK_MS = 10 * 60_000;

/**
 * Called by the flusher right before sending an observed entry: seals the session's names for the
 * phones and linked browsers once per session, again when they change and when the recipients do (a
 * browser linked after the session began; checked at most every RECIPIENT_RECHECK_MS). Returns
 * { body, after } where `after()` records the names as delivered once the server took them.
 */
export async function prepareObserved(entry, { client, config, dependencies }) {
  const names = entry.meta?.names ?? {};
  const title = entry.meta?.title;
  const body = { ...entry.body };
  if ((Object.keys(names).length === 0 && !title) || !config?.apiUrl) return { body, after: async () => {} };
  const session = body.session;
  // A renamed session seals again: the title is part of what was delivered.
  const digest = createHash("sha256").update(JSON.stringify([Object.entries(names).sort(), title ?? null])).digest("hex");
  const directory = dependencies.hookStateDirectory;
  const marker = join(directory, `names-${String(session).slice(0, 24)}`);
  const now = dependencies.now?.() ?? Date.now();
  const record = (recipients) => async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => {});
    await writeFile(marker, `${digest} ${recipients ?? ""} ${now}`, { mode: 0o600 }).catch(() => {});
  };
  let delivered = [];
  try {
    delivered = (await readFile(marker, "utf8")).split(" ");
  } catch { /* not sent yet */ }
  const [sentDigest, sentRecipients, checkedAt] = delivered;
  const same = sentDigest === digest;
  if (same && now - Number(checkedAt) < RECIPIENT_RECHECK_MS) return { body, after: async () => {} };
  let sealed = null;
  try {
    // Sealing loads only here, in the flusher: a hook queuing a snapshot never pays for it.
    const { sealSessionNames } = await import("../../crypto/seal-notice.mjs");
    sealed = await sealSessionNames({ names, title, session, client, config: { apiUrl: config.apiUrl }, dependencies,
      unlessRecipients: same ? sentRecipients : undefined });
  } catch { /* names stay handles until the next snapshot */ }
  if (!sealed) return { body, after: async () => {} };
  // The recipients are unchanged: only the time of this check moves on.
  if (!sealed.envelope) { await record(sealed.recipients)(); return { body, after: async () => {} }; }
  return { body: { ...body, sealedNames: sealed.envelope }, after: record(sealed.recipients) };
}
