// Canonical observed events (HA.2): every harness adapter maps its native hook events onto this list,
// and nothing past normalize() ever sees a native field. The core never branches on which adapter sent
// an event; it only reads the canonical shape below.
import { createHash } from "node:crypto";
import { sessionId, sessionKey } from "../../shared/session-key.mjs";

export const CANONICAL_EVENTS = Object.freeze([
  "start", "prompt", "tool_start", "tool_end", "wait", "stop", "end", "subagent_start", "subagent_stop", "compact",
]);

/** How a session (re)started, when the harness says so. Anything else is dropped. */
const START_SOURCES = Object.freeze(["startup", "resume", "clear", "compact", "fork"]);

/** Hook command names (`relo hook <name>`) for each canonical event: readable in settings files. */
export const EVENT_COMMANDS = Object.freeze(Object.fromEntries(CANONICAL_EVENTS.map((event) => [event.replace("_", "-"), event])));

const opaque = (session, kind, value) => createHash("sha256").update(`${session}:${kind}:${value}`).digest("base64url").slice(0, 22);
const text = (value) => (typeof value === "string" && value.trim() && value.length <= 500 ? value.trim() : undefined);

/**
 * The adapter's native input → one canonical event, or { drop: reason }. Whitelist only: the result holds
 *   event, harness, session (sessionKey), subagent (bool), agentKey?, toolKey? (opaque, local only),
 *   source?, reason? (a session end: clear|other), stopActive (bool), background (bool: a tool_end whose tool keeps running in the background),
 *   cwd? (local only: names the project, never sent)
 * Prompts, tool names, tool input or output, notification text and transcript paths are never read here:
 * the adapter's identity() reads only the fields it maps, and only those come back.
 * `named` is the canonical event from the hook command line (`relo hook tool-start`); the harness's own
 * event name on stdin wins when the adapter maps it.
 */
export function normalize({ adapter, input, named }) {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const native = typeof raw.hook_event_name === "string" ? adapter.events[raw.hook_event_name] : undefined;
  const event = native ?? (CANONICAL_EVENTS.includes(named) ? named : undefined);
  if (!event) return { drop: "unknown_event" };
  const fields = adapter.identity(raw) ?? {};
  const id = sessionId(fields.id);
  if (!id) return { drop: "no_session" };
  if (adapter.accept && !adapter.accept(event, raw)) return { drop: "not_accepted" };
  const session = sessionKey({ harness: adapter.id, id });
  const agent = text(fields.agent);
  const tool = text(fields.toolKey);
  const source = START_SOURCES.includes(fields.source) ? fields.source : undefined;
  // Why a session ended: only `clear` matters (its work is handed off); anything else is just "other".
  const reason = event === "end" && typeof fields.reason === "string" && fields.reason ? (fields.reason === "clear" ? "clear" : "other") : undefined;
  const cwd = typeof fields.cwd === "string" && fields.cwd.startsWith("/") && fields.cwd.length <= 4096 ? fields.cwd : undefined;
  return {
    event,
    harness: adapter.id,
    session,
    subagent: agent !== undefined,
    ...(agent ? { agentKey: opaque(session, "agent", agent) } : {}),
    ...(tool ? { toolKey: opaque(session, "tool", tool) } : {}),
    ...(source ? { source } : {}),
    ...(reason ? { reason } : {}),
    stopActive: fields.stopActive === true,
    ...(event === "tool_end" && fields.background === true ? { background: true } : {}),
    ...(cwd ? { cwd } : {}),
  };
}
