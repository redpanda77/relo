import { z } from "zod";
import { SESSION_PHASES, observedSessionPhaseSchema, sessionPhaseSchema, sessionWaitingForSchema, type SessionPhase } from "./owner-state.js";

/**
 * Agent sessions: a signal channel separate from cards and questions. The CLI turns a harness's
 * hook events into a phase locally (ADR 0008, the CLI is the edge) and reports only the resulting
 * snapshot: phase changes and a coarse heartbeat while working. No prompt, tool name or per-event
 * record ever reaches the server. Every field is a bounded label or identifier. The session id is
 * a hash the CLI computes, so the server never learns the harness's own session id.
 */

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
  session: agentSessionHashSchema.describe("Hash of the harness's session id, computed by the CLI; the server never sees the real id."),
  harness: agentSessionHarnessSchema.describe("Name of the harness the session runs in, such as claude-code."),
  phase: observedSessionPhaseSchema.describe("What the session is doing now, as the CLI's local state machine sees it."),
  phaseSince: timestamp.describe("When the session entered this phase."),
  lastSeenAt: timestamp.describe("When the session last showed activity."),
  openToolSince: timestamp.nullable().describe("When the tool call that is still running began; null when none is running."),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe("Orders snapshots of one session; a snapshot is applied only when this is higher than the stored one."),
  project: label(120).optional().describe("Name of the project the session works in."),
  computer: label(120).optional().describe("Name of the machine the session runs on."),
  account: label(40).optional().describe("Name of the account the session runs under."),
  contextPct: z.number().int().min(0).max(100).optional().describe("How full the session's context window is, in whole percent; present once the CLI's status line wrapper (relo setup --level optimize) has read it, and sent only after it moved by 5 points."),
  costUsd: z.number().min(0).max(1_000_000).optional().describe("What the session has cost so far in US dollars, rounded to the cent; present with contextPct, and sent only after it moved by 50 cents."),
  contextTokens: z.number().int().min(0).max(10_000_000).optional().describe("Tokens in the session's context window, read by the CLI's hooks from the session's transcript (where no status line runs, such as the Claude desktop app); sent first, then only after it moved by 10,000 tokens or 5%."),
  title: label(80).optional().describe("The session's readable name (the title the owner or the harness gave the conversation), one line. Sent only when the account is not encrypted; otherwise it travels sealed inside sealedNames."),
  heartbeat: z.boolean().optional().describe("True on a snapshot the Relo MCP server sends once a minute for a session at a permission prompt; it repeats the phase and only proves the session is still alive."),
  endReason: z.enum(["hook","gone","mcp"]).optional().describe("How the session ended, sent with phase ended: the harness's end hook, the CLI's dead-process sweep (gone) or the Relo MCP server (mcp). Logged with the phase change to measure how fast ended sessions clear."),
  /**
   * End-to-end sealed names for the handles above (kind "names"); only the account's phones can
   * open it. The server checks its shape and stores it as is.
   */
  sealedNames: z.unknown().optional().describe("End-to-end sealed names for project, computer and account, readable only on the account's phones."),
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
  contextPct: z.number().int().min(0).max(100).optional().describe("How full the session's context window is, in whole percent; absent until the CLI reports it. A display fact."),
  costUsd: z.number().min(0).optional().describe("What the session has cost so far in US dollars; absent until the CLI reports it. A display fact."),
  contextTokens: z.number().int().min(0).max(10_000_000).optional().describe("Tokens in the session's context window; absent until a hook reports it. A display fact."),
  card: z.object({
    id: z.string().regex(/^act_[0-9a-f-]{36}$/),
    state: z.enum(["active", "ended", "expired", "replaced"]),
  }).strict().nullable(),
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
export const harnessCredentialCreateRequestSchema = z.object({ name: label(120).describe("How the credential shows in lists.") }).strict();
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
