import { z } from "zod";

/**
 * Agent sessions: a signal channel separate from cards and questions. Hooks report facts about a
 * running harness session (it started, is working, stopped, ended); they never carry card content.
 * Every field is a bounded label or identifier. The session id is a hash the CLI computes, so the
 * server never learns the harness's own session id.
 */
export const AGENT_SESSION_EVENTS = ["start", "prompt", "tool", "stop", "wait", "end"] as const;
export const agentSessionEventNameSchema = z.enum(AGENT_SESSION_EVENTS);
export type AgentSessionEventName = z.infer<typeof agentSessionEventNameSchema>;

export const AGENT_SESSION_STATES = ["active", "idle", "ended", "lost"] as const;
export const agentSessionStateSchema = z.enum(AGENT_SESSION_STATES);
export type AgentSessionState = z.infer<typeof agentSessionStateSchema>;

export const AGENT_SESSION_PRESENCES = ["working", "quiet", "no_card", "ended", "lost"] as const;
export const agentSessionPresenceSchema = z.enum(AGENT_SESSION_PRESENCES);
export type AgentSessionPresence = z.infer<typeof agentSessionPresenceSchema>;

/**
 * What the owner sees, derived from the stored state, the last event and its age (the same rule on
 * the server, the phone and the Dashboard, so a list read a while ago settles on its own):
 *  - working: mid-turn (prompt or tool events; the hook reports one tool event a minute). A session
 *    that only started (opened, never prompted) is idle.
 *  - waiting: needs the owner now. A permission or input prompt ("wait", up to an hour) or a turn
 *    that just ended ("stop", for five minutes).
 *  - idle: open between turns, nothing new for the owner. A Desktop session left open for hours.
 *  - ended / lost: SessionEnd arrived, or the session went silent past its lost threshold.
 */
export const AGENT_SESSION_PHASES = ["working", "waiting", "idle", "ended", "lost"] as const;
export const agentSessionPhaseSchema = z.enum(AGENT_SESSION_PHASES);
export type AgentSessionPhase = z.infer<typeof agentSessionPhaseSchema>;
/** A turn that ended this recently still reads as waiting for the owner. */
export const AGENT_SESSION_WAITING_AFTER_STOP_SECONDS = 5 * 60;
/** A permission or input prompt reads as waiting this long, then as idle. */
export const AGENT_SESSION_WAITING_ON_PROMPT_SECONDS = 60 * 60;

/**
 * The phase of a session whose `state` is already settled (silent sessions read as lost). An
 * unknown or missing last event of an idle session reads as idle.
 */
export function agentSessionPhase(
  session: { state: string; lastEvent?: string | null; lastEventAt: string | Date },
  now: number | Date = Date.now(),
): AgentSessionPhase {
  if (session.state === "ended" || session.state === "lost") return session.state;
  // Open but not prompted yet (SessionStart only): nothing is running.
  if (session.state === "active") return session.lastEvent === "start" ? "idle" : "working";
  const age = (Number(now) - new Date(session.lastEventAt).valueOf()) / 1000;
  if (session.lastEvent === "wait" && age <= AGENT_SESSION_WAITING_ON_PROMPT_SECONDS) return "waiting";
  if (session.lastEvent === "stop" && age <= AGENT_SESSION_WAITING_AFTER_STOP_SECONDS) return "waiting";
  return "idle";
}

const NO_CONTROL_CHARACTERS = /^[^\u0000-\u001f\u007f]+$/;
const label = (max: number) => z.string().trim().min(1).max(max).regex(NO_CONTROL_CHARACTERS);

/** sha256 hex (64) or base64url of a hash (43); any 16..128 characters of those alphabets. */
export const agentSessionHashSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const agentSessionHarnessSchema = z.string().trim().min(1).max(40).regex(/^[a-z0-9][a-z0-9._-]*$/);

export const agentSessionEventRequestSchema = z.object({
  session: agentSessionHashSchema,
  harness: agentSessionHarnessSchema,
  event: agentSessionEventNameSchema,
  at: z.iso.datetime({ offset: true }).optional(),
  project: label(120).optional(),
  computer: label(120).optional(),
  account: label(40).optional(),
  /** The activity key the CLI derives for this session's card (session-<agent>-<hash>). */
  cardKey: label(100).optional(),
  /**
   * End-to-end sealed names for the handles above (kind "names"); only the account's phones can
   * open it. The server checks its shape and stores it as is.
   */
  sealedNames: z.unknown().optional(),
}).strict();
export type AgentSessionEventRequest = z.infer<typeof agentSessionEventRequestSchema>;

export const agentSessionEventResponseSchema = z.object({
  ok: z.literal(true),
  state: agentSessionStateSchema,
}).strict();
export type AgentSessionEventResponse = z.infer<typeof agentSessionEventResponseSchema>;

export const agentSessionSummarySchema = z.object({
  id: z.string().regex(/^ags_[0-9a-f-]{36}$/),
  harness: z.string().max(40),
  computer: z.string().max(120).nullable(),
  account: z.string().max(40).nullable(),
  project: z.string().max(120).nullable(),
  state: agentSessionStateSchema,
  /** The phase at the time of reading (see agentSessionPhase). */
  phase: agentSessionPhaseSchema,
  lastEvent: agentSessionEventNameSchema,
  startedAt: z.iso.datetime({ offset: true }),
  lastEventAt: z.iso.datetime({ offset: true }),
  card: z.object({
    id: z.string().regex(/^act_[0-9a-f-]{36}$/),
    state: z.enum(["active", "ended", "expired", "replaced"]),
    quietForSeconds: z.number().int().nonnegative(),
  }).strict().nullable(),
  presence: agentSessionPresenceSchema,
  /** The sealed names for this session's handles, in the phone's snapshot only. */
  sealedNames: z.unknown().nullable().optional(),
}).strict();
export type AgentSessionSummary = z.infer<typeof agentSessionSummarySchema>;

/** The live and recent sessions (last 24 hours, at most 20). */
export const AGENT_SESSION_LIST_MAX = 20;
export const agentSessionListSchema = z.array(agentSessionSummarySchema).max(AGENT_SESSION_LIST_MAX);

export const agentSessionCountsSchema = z.object(
  Object.fromEntries(AGENT_SESSION_PHASES.map((phase) => [phase, z.number().int().nonnegative()])) as
    Record<AgentSessionPhase, z.ZodNumber>,
).strict();
export type AgentSessionCounts = z.infer<typeof agentSessionCountsSchema>;

/** `GET /api/agent-sessions?phase=working,waiting`: only those phases are listed; counts cover every phase. */
export const agentSessionListQuerySchema = z.object({
  phase: z.string().max(100).optional().transform((value, context) => {
    if (value === undefined || value.trim() === "") return undefined;
    const phases = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
    for (const phase of phases) {
      if (!(AGENT_SESSION_PHASES as readonly string[]).includes(phase)) {
        context.addIssue({ code: "custom", message: `unknown phase ${phase}` });
        return z.NEVER;
      }
    }
    return phases as AgentSessionPhase[];
  }),
}).strict();

export const agentSessionListResponseSchema = z.object({
  sessions: agentSessionListSchema,
  /** Sessions with an event in the list window, by phase, whatever the filter. */
  counts: agentSessionCountsSchema,
}).strict();
export type AgentSessionListResponse = z.infer<typeof agentSessionListResponseSchema>;
