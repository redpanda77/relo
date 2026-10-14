// The observed wire (EDGE.2): one phase snapshot per transition (or heartbeat), queued in the outbox
// and sent with the harness credential. The body is built from a whitelist only; prompts, tool names,
// tool input/output and transcript paths cannot reach it because normalize() never returns them.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sealSessionNames } from "../../seal-notice.mjs";

export const OBSERVED_ROUTE = "/api/agent-sessions/observed";
export const OBSERVED_FIELDS = Object.freeze([
  "session", "harness", "phase", "phaseSince", "lastSeenAt", "openToolSince", "seq", "project", "computer", "account", "sealedNames",
]);

/** The wire body for a state that was just marked sent. */
export function observedBody(state, labels = {}) {
  const body = {
    session: state.session,
    harness: state.harness,
    phase: state.phase,
    phaseSince: state.phaseSince,
    lastSeenAt: state.lastSeenAt,
    openToolSince: state.openToolSince ?? null,
    seq: state.seq,
  };
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

/**
 * Called by the flusher right before sending an observed entry: seals the session's names for the
 * phones once per session (again only when they change). Returns { body, after } where `after()` records
 * the names as delivered once the server took them.
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
  try {
    if (await readFile(marker, "utf8") === digest) return { body, after: async () => {} };
  } catch { /* not sent yet */ }
  let envelope = null;
  try {
    envelope = await sealSessionNames({ names, title, session, client, config: { apiUrl: config.apiUrl }, dependencies });
  } catch { /* names stay handles until the next snapshot */ }
  if (!envelope) return { body, after: async () => {} };
  return {
    body: { ...body, sealedNames: envelope },
    after: async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => {});
      await writeFile(marker, digest, { mode: 0o600 }).catch(() => {});
    },
  };
}
