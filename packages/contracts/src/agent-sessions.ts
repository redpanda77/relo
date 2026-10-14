import { z } from "zod";
import { SESSION_PHASES, observedSessionPhaseSchema, sessionPhaseSchema, sessionWaitingForSchema, type SessionPhase } from "./owner-state.js";

/**
 * Agent sessions: a signal channel separate from cards and questions. The CLI turns a harness's
 * hook events into a phase locally (ADR 0008, the CLI is the edge) and reports only the resulting
 * snapshot: phase changes and a coarse heartbeat while working. No prompt, tool name or per-event
 * record ever reaches the server. Every field is a bounded label or identifier. The session id is
 * a hash the CLI computes, so the server never learns the harness's own session id.
 */

/** Presence of a session relative to its card: its card is moving, quiet, absent, or the session ended. */
export const AGENT_SESSION_PRESENCES = ["working", "quiet", "no_card", "ended"] as const;
export const agentSessionPresenceSchema = z.enum(AGENT_SESSION_PRESENCES);
export type AgentSessionPresence = z.infer<typeof agentSessionPresenceSchema>;

/** The owner-facing phases of a session (the server's session-row derivation; never computed by clients). */
export const AGENT_SESSION_PHASES = SESSION_PHASES;
export const agentSessionPhaseSchema = sessionPhaseSchema;
export type AgentSessionPhase = SessionPhase;

const NO_CONTROL_CHARACTERS = /^[^\u0000-\u001f\u007f]+$/;
const label = (max: number) => z.string().trim().min(1).max(max).regex(NO_CONTROL_CHARACTERS);

/** sha256 hex (64) or base64url of a hash (43); any 16..128 characters of those alphabets. */
export const agentSessionHashSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const agentSessionHarnessSchema = z.string().trim().min(1).max(40).regex(/^[a-z0-9][a-z0-9._-]*$/);

const timestamp = z.iso.datetime({ offset: true });

/**
 * `POST /api/agent-sessions/observed` (harness credential only): one snapshot of the CLI's local
 * session state machine, sent on a phase change and as a heartbeat (at most every 5 minutes) while
 * working. `seq` orders snapshots of one session: the server applies a snapshot only when its seq
 * is greater than the stored one, so retries and out-of-order deliveries change nothing.
 */
export const agentSessionObservedRequestSchema = z.object({
  session: agentSessionHashSchema,
  harness: agentSessionHarnessSchema,
  phase: observedSessionPhaseSchema,
  phaseSince: timestamp,
  lastSeenAt: timestamp,
  openToolSince: timestamp.nullable(),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  project: label(120).optional(),
  computer: label(120).optional(),
  account: label(40).optional(),
  /**
   * End-to-end sealed names for the handles above (kind "names"); only the account's phones can
   * open it. The server checks its shape and stores it as is.
   */
  sealedNames: z.unknown().optional(),
}).strict();
export type AgentSessionObservedRequest = z.infer<typeof agentSessionObservedRequestSchema>;

export const agentSessionObservedResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type AgentSessionObservedResponse = z.infer<typeof agentSessionObservedResponseSchema>;

export const agentSessionSummarySchema = z.object({
  id: z.string().regex(/^ags_[0-9a-f-]{36}$/),
  harness: z.string().max(40),
  computer: z.string().max(120).nullable(),
  account: z.string().max(40).nullable(),
  project: z.string().max(120).nullable(),
  /** The phase at the time of reading (the server's session-row derivation). */
  phase: agentSessionPhaseSchema,
  /** Why a waiting session waits; null unless waiting. */
  waitingFor: sessionWaitingForSchema.nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  /** The session's last observed activity (a phase change or a heartbeat). */
  lastSeenAt: z.iso.datetime({ offset: true }),
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
  /** Sessions seen in the list window, by phase, whatever the filter. */
  counts: agentSessionCountsSchema,
}).strict();
export type AgentSessionListResponse = z.infer<typeof agentSessionListResponseSchema>;

/**
 * Harness credentials: the hooks' own credential (kind "harness", scope `presence:write` only). It
 * can post observed session snapshots and nothing else; declared credentials can never post them.
 * Minted by an owner CLI credential with `services:write`; the token is shown once.
 */
export const harnessCredentialCreateRequestSchema = z.object({ name: label(120) }).strict();
export type HarnessCredentialCreateRequest = z.infer<typeof harnessCredentialCreateRequestSchema>;
export const harnessCredentialIdSchema = z.string().regex(/^hck_[0-9a-f-]{36}$/);
export const harnessCredentialCreateResponseSchema = z.object({
  id: harnessCredentialIdSchema,
  token: z.string().regex(/^relo_[A-Za-z0-9_-]{43}$/),
}).strict();
export type HarnessCredentialCreateResponse = z.infer<typeof harnessCredentialCreateResponseSchema>;
export const harnessCredentialSummarySchema = z.object({
  id: harnessCredentialIdSchema,
  name: z.string().max(120),
  prefix: z.string().max(20),
  createdAt: timestamp,
  lastUsedAt: timestamp.nullable(),
}).strict();
export type HarnessCredentialSummary = z.infer<typeof harnessCredentialSummarySchema>;
export const harnessCredentialListResponseSchema = z.object({
  credentials: z.array(harnessCredentialSummarySchema).max(50),
}).strict();
export type HarnessCredentialListResponse = z.infer<typeof harnessCredentialListResponseSchema>;
