import { z } from "zod";

/**
 * Agent sessions: a signal channel separate from cards and questions. Hooks report facts about a
 * running harness session (it started, is working, stopped, ended); they never carry card content.
 * Every field is a bounded label or identifier. The session id is a hash the CLI computes, so the
 * server never learns the harness's own session id.
 */
export const AGENT_SESSION_EVENTS = ["start", "prompt", "tool", "stop", "end"] as const;
export const agentSessionEventNameSchema = z.enum(AGENT_SESSION_EVENTS);
export type AgentSessionEventName = z.infer<typeof agentSessionEventNameSchema>;

export const AGENT_SESSION_STATES = ["active", "idle", "ended", "lost"] as const;
export const agentSessionStateSchema = z.enum(AGENT_SESSION_STATES);
export type AgentSessionState = z.infer<typeof agentSessionStateSchema>;

export const AGENT_SESSION_PRESENCES = ["working", "quiet", "no_card", "ended", "lost"] as const;
export const agentSessionPresenceSchema = z.enum(AGENT_SESSION_PRESENCES);
export type AgentSessionPresence = z.infer<typeof agentSessionPresenceSchema>;

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
  startedAt: z.iso.datetime({ offset: true }),
  lastEventAt: z.iso.datetime({ offset: true }),
  card: z.object({
    id: z.string().regex(/^act_[0-9a-f-]{36}$/),
    state: z.enum(["active", "ended", "expired", "replaced"]),
    quietForSeconds: z.number().int().nonnegative(),
  }).strict().nullable(),
  presence: agentSessionPresenceSchema,
}).strict();
export type AgentSessionSummary = z.infer<typeof agentSessionSummarySchema>;

/** The live and recent sessions (last 24 hours, at most 20). */
export const AGENT_SESSION_LIST_MAX = 20;
export const agentSessionListSchema = z.array(agentSessionSummarySchema).max(AGENT_SESSION_LIST_MAX);

export const agentSessionListResponseSchema = z.object({
  sessions: agentSessionListSchema,
}).strict();
export type AgentSessionListResponse = z.infer<typeof agentSessionListResponseSchema>;
