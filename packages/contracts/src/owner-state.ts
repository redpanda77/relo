import { z } from "zod";
import { sealedEnvelopeSchema } from "./sealed.js";

/**
 * The derived owner state (STATE-SPEC v2, sections 2.3 and 6). One server function, `derive()`,
 * turns a work's declared fields, its own session's observed phase and the time into one owner
 * state; everything the owner sees (Lock Screen, Dynamic Island, Now, History, alerts) is looked up
 * from that state in the fixed table below. Clients display the server's output: they keep no
 * timers, windows or phase rules of their own. The fixtures in `fixtures/owner-state-v1.json` pin
 * the derivation and the table byte for byte for the server, the iOS app and the Dashboard.
 *
 * Owner-facing name: "Session" (one agent conversation). "Agent" is only a source label.
 */

/** The four product constants, in seconds. Engineering constants (batching, hook budgets, question timeouts) are separate. */
export const OWNER_STATE_TIMING = Object.freeze({
  /** T_fresh: stale, staleDate, "your turn" on the Lock Screen, reminder threshold. */
  freshSeconds: 20 * 60,
  /** T_retire: retire a card, no signal, declared-waiting limit, failed on the Lock Screen. */
  retireSeconds: 60 * 60,
  /** T_done: done lingers on the Lock Screen, ended sessions hidden, session-ended grace. */
  doneSeconds: 15 * 60,
  /** T_history: left unfinished, "since you looked" window, waiting-on-you limit, ActivityKit card limit. */
  historySeconds: 8 * 60 * 60,
} as const);
/** T_fresh/2: "working quietly" evidence and the idle-session fold. */
export const OWNER_STATE_QUIET_SECONDS = OWNER_STATE_TIMING.freshSeconds / 2;
/** At most this many Relo cards per device, by relevance (a visibility rule, never an end). */
export const LOCK_SCREEN_MAX_CARDS = 3;

/**
 * Owner states in evaluation order: the first that matches wins (spec 6.1). Two clarifications of
 * the spec's numbered list, both following its own conflict table (6.3):
 *  - The time bands are disjoint: stale is [T_fresh, T_retire), no signal [T_retire, T_history),
 *    left unfinished from T_history; left unfinished (open or paused) is checked right after the
 *    terminal outcomes, and paused after it.
 *  - Stopped responding has two variants: "session ended, no write for T_done" (with hooks) is
 *    checked before moving; "turn was running, no evidence for T_fresh/2" after working quietly.
 */
export const OWNER_STATES = [
  "needs_you",
  "failed",
  "done",
  "dropped",
  "left_unfinished",
  "paused",
  "waiting_on_you",
  "moving",
  "working_quietly",
  "stopped_responding",
  "no_signal",
  "stale",
] as const;
export const ownerStateSchema = z.enum(OWNER_STATES);
export type OwnerState = z.infer<typeof ownerStateSchema>;
export const OWNER_STATE_EVALUATION_ORDER: readonly OwnerState[] = OWNER_STATES;

/** Where a work's card stands on the Lock Screen and Dynamic Island. "none" means retired (or never shown). */
export const LOCK_SCREEN_PLACEMENTS = ["top", "shown", "your_turn", "dimmed", "final", "none"] as const;
export const lockScreenPlacementSchema = z.enum(LOCK_SCREEN_PLACEMENTS);
export type LockScreenPlacement = z.infer<typeof lockScreenPlacementSchema>;

/** The Now sections; null means History only. "since_you_looked" is the top line and its recent list. */
export const NOW_SECTIONS = ["needs_you", "since_you_looked", "waiting_on_you", "running", "quiet", "paused"] as const;
export const nowSectionSchema = z.enum(NOW_SECTIONS);
export type NowSection = z.infer<typeof nowSectionSchema>;

/** APNs `interruption-level` values Relo uses; null is silent (no alert at all). */
export const INTERRUPTION_LEVELS = ["time-sensitive", "active", "passive"] as const;
export const interruptionLevelSchema = z.enum(INTERRUPTION_LEVELS);
export type InterruptionLevel = z.infer<typeof interruptionLevelSchema>;

/** Why a work needs the owner. */
export const NEEDS_YOU_REASONS = ["question", "missed_question", "permission"] as const;
export const needsYouReasonSchema = z.enum(NEEDS_YOU_REASONS);
export type NeedsYouReason = z.infer<typeof needsYouReasonSchema>;

export const ownerStateSurfaceSchema = z.object({
  /** Lock Screen / Dynamic Island placement while the state holds. */
  lockScreen: lockScreenPlacementSchema,
  /**
   * How long the placement lasts, in seconds, counted from `lockScreenFrom`; null while the state
   * holds. After it the card is retired (ActivityKit end).
   */
  lockScreenSeconds: z.number().int().positive().nullable(),
  /** The instant the window above counts from. */
  lockScreenFrom: z.enum(["finished", "turn_stopped"]).nullable(),
  /** How ActivityKit ends the card when this state retires it ("after" keeps the final content). */
  dismissal: z.enum(["immediate", "after"]).nullable(),
  /** The Now section, or null for History only. */
  now: nowSectionSchema.nullable(),
  /** Every work is in History; true marks the states shown only there. */
  historyOnly: z.boolean(),
  /** Notification `interruption-level` for an alert in this state; null is silent. */
  interruptionLevel: interruptionLevelSchema.nullable(),
  /** ActivityKit relevance score (0..1), ranks cards for the 3-card limit. */
  relevance: z.number().min(0).max(1),
  /** APNs priority for a card push in this state: 10 for questions and outcomes, 5 for progress. */
  apnsPriority: z.union([z.literal(5), z.literal(10)]),
  /** Only Needs you sets ActivityKit `alertConfiguration` (sound and expanded Dynamic Island once). */
  alertConfiguration: z.boolean(),
}).strict();
export type OwnerStateSurface = z.infer<typeof ownerStateSurfaceSchema>;

const silent = { interruptionLevel: null, apnsPriority: 5, alertConfiguration: false } as const;
/** The fixed state → surfaces table (spec 6.2). */
export const OWNER_STATE_SURFACES: Readonly<Record<OwnerState, OwnerStateSurface>> = Object.freeze({
  needs_you: { lockScreen: "top", lockScreenSeconds: null, lockScreenFrom: null, dismissal: null, now: "needs_you",
    historyOnly: false, interruptionLevel: "time-sensitive", relevance: 1, apnsPriority: 10, alertConfiguration: true },
  failed: { lockScreen: "final", lockScreenSeconds: OWNER_STATE_TIMING.retireSeconds, lockScreenFrom: "finished",
    dismissal: "after", now: "since_you_looked", historyOnly: false, interruptionLevel: "active", relevance: 0.9,
    apnsPriority: 10, alertConfiguration: false },
  done: { lockScreen: "final", lockScreenSeconds: OWNER_STATE_TIMING.doneSeconds, lockScreenFrom: "finished",
    dismissal: "after", now: "since_you_looked", historyOnly: false, interruptionLevel: "passive", relevance: 0.3,
    apnsPriority: 10, alertConfiguration: false },
  dropped: { lockScreen: "none", lockScreenSeconds: null, lockScreenFrom: null, dismissal: "immediate", now: null,
    historyOnly: true, relevance: 0, ...silent },
  left_unfinished: { lockScreen: "none", lockScreenSeconds: null, lockScreenFrom: null, dismissal: "immediate",
    now: "since_you_looked", historyOnly: false, relevance: 0, ...silent },
  paused: { lockScreen: "none", lockScreenSeconds: null, lockScreenFrom: null, dismissal: "immediate", now: "paused",
    historyOnly: false, relevance: 0, ...silent },
  waiting_on_you: { lockScreen: "your_turn", lockScreenSeconds: OWNER_STATE_TIMING.freshSeconds,
    lockScreenFrom: "turn_stopped", dismissal: "immediate", now: "waiting_on_you", historyOnly: false, relevance: 0.8,
    ...silent },
  moving: { lockScreen: "shown", lockScreenSeconds: null, lockScreenFrom: null, dismissal: null, now: "running",
    historyOnly: false, relevance: 0.7, ...silent },
  working_quietly: { lockScreen: "shown", lockScreenSeconds: null, lockScreenFrom: null, dismissal: null, now: "running",
    historyOnly: false, relevance: 0.5, ...silent },
  stopped_responding: { lockScreen: "none", lockScreenSeconds: null, lockScreenFrom: null, dismissal: "immediate",
    now: "quiet", historyOnly: false, relevance: 0, ...silent },
  no_signal: { lockScreen: "none", lockScreenSeconds: null, lockScreenFrom: null, dismissal: "immediate", now: "quiet",
    historyOnly: false, relevance: 0, ...silent },
  stale: { lockScreen: "dimmed", lockScreenSeconds: null, lockScreenFrom: null, dismissal: null, now: "quiet",
    historyOnly: false, relevance: 0.3, ...silent },
});

const timestamp = z.iso.datetime({ offset: true });

/** Declared lifecycle of a work (agent-owned). Slice 1 maps today's card rows onto it. */
export const WORK_LIFECYCLES = ["open", "paused", "finished", "failed", "dropped"] as const;
export const workLifecycleSchema = z.enum(WORK_LIFECYCLES);
export type WorkLifecycle = z.infer<typeof workLifecycleSchema>;

/** A question referencing the work. "missed": unanswered in time, stays under Needs you until opened. */
export const QUESTION_STANDINGS = ["pending", "missed", "answered", "answered_late"] as const;
export const questionStandingSchema = z.enum(QUESTION_STANDINGS);

/**
 * The observed phase of a session, as the CLI's local session state machine reports it (ADR 0008:
 * the CLI is the edge). open: started, no turn yet; working: a turn is running; waiting: a
 * permission or input prompt is up; stopped: the turn ended (the owner's turn); ended: the session
 * closed. The server stores the last reported phase and never sees the harness events behind it.
 */
export const OBSERVED_SESSION_PHASES = ["open", "working", "waiting", "stopped", "ended"] as const;
export const observedSessionPhaseSchema = z.enum(OBSERVED_SESSION_PHASES);
export type ObservedSessionPhase = z.infer<typeof observedSessionPhaseSchema>;

/** Producer types (spec 11.1): each its own identity and evidence. Hooks only observe agent sessions. */
export const PRODUCER_TYPES = ["agent_session", "script", "service"] as const;
export const producerTypeSchema = z.enum(PRODUCER_TYPES);
export type ProducerType = z.infer<typeof producerTypeSchema>;

/** Agent session evidence: its declared writes (on the work) plus the observed state of that session key only. */
export const agentSessionEvidenceSchema = z.object({
  producer: z.literal("agent_session"),
  /** The session's own observed state; null without hooks. */
  session: z.object({
    phase: observedSessionPhaseSchema,
    /** When the session entered its phase (for stopped: when the turn stopped). */
    phaseSince: timestamp,
    /** The session's last observed activity (a phase change or a heartbeat). */
    lastSeenAt: timestamp,
    /** A tool started and not finished yet; null when none is open. */
    openToolSince: timestamp.nullable(),
  }).strict().nullable(),
}).strict();
/** Script or app evidence: declared writes plus its lease (slice 2; null until then). */
export const scriptEvidenceSchema = z.object({
  producer: z.literal("script"),
  leaseUntil: timestamp.nullable(),
}).strict();
/** Service evidence: declared writes plus its lease (slice 2; null until then). */
export const serviceEvidenceSchema = z.object({
  producer: z.literal("service"),
  leaseUntil: timestamp.nullable(),
}).strict();
export const producerEvidenceSchema = z.discriminatedUnion("producer", [
  agentSessionEvidenceSchema, scriptEvidenceSchema, serviceEvidenceSchema,
]);
export type ProducerEvidence = z.infer<typeof producerEvidenceSchema>;
export type AgentSessionEvidence = z.infer<typeof agentSessionEvidenceSchema>;

/** The input of derive() for one work. Pure data: the same input gives the same output everywhere. */
export const ownerStateInputSchema = z.object({
  now: timestamp,
  work: z.object({
    lifecycle: workLifecycleSchema,
    startedAt: timestamp,
    /** The work's last declared write (start, update, finish, ask, heartbeat), never a server write. */
    lastDeclaredAt: timestamp,
    finishedAt: timestamp.nullable(),
    /** Declared `--waiting` since (slice 2); null when not waiting. */
    waitingSince: timestamp.nullable(),
    /** When the owner opened the work's outcome; null while unseen. */
    seenAt: timestamp.nullable(),
  }).strict(),
  question: z.object({
    standing: questionStandingSchema,
    askedAt: timestamp,
    /** When the owner opened the question (a missed question leaves Needs you then). */
    openedAt: timestamp.nullable(),
    /**
     * When the owner dismissed the missed question (an owner decision that it no longer needs them):
     * it leaves Needs you at once and stays in History. Absent or null while not dismissed.
     */
    dismissedAt: timestamp.nullable().optional(),
  }).strict().nullable(),
  /** Evidence of liveness, typed by producer (spec 11.1a): never a mixed bag of nullable fields. */
  evidence: producerEvidenceSchema,
}).strict();
export type OwnerStateInput = z.infer<typeof ownerStateInputSchema>;

/** The output of derive() for one work. */
export const ownerStateResultSchema = z.object({
  state: ownerStateSchema,
  needsYou: needsYouReasonSchema.nullable(),
  /** Evidence clock: max(last declared write, last observed activity of this session). */
  evidenceAt: timestamp,
  evidenceSource: z.enum(["declared", "observed"]),
  /** ActivityKit staleDate: evidence + T_fresh. */
  staleDate: timestamp,
  lockScreen: lockScreenPlacementSchema,
  /** When the Lock Screen placement ends on its own (a final card, "your turn"); null while the state holds. */
  lockScreenUntil: timestamp.nullable(),
  now: nowSectionSchema.nullable(),
  interruptionLevel: interruptionLevelSchema.nullable(),
  relevance: z.number().min(0).max(1),
  apnsPriority: z.union([z.literal(5), z.literal(10)]),
  /** The next instant the derivation changes by time alone; null when only a write can change it. */
  nextChangeAt: timestamp.nullable(),
}).strict();
export type OwnerStateResult = z.infer<typeof ownerStateResultSchema>;

/** Sessions view (owner-facing "Sessions"): one row per session. */
export const SESSION_PHASES = ["working", "waiting", "idle", "ended"] as const;
export const sessionPhaseSchema = z.enum(SESSION_PHASES);
export type SessionPhase = z.infer<typeof sessionPhaseSchema>;

/** Why a waiting session waits: a permission or input prompt, or its turn stopped (the owner's turn). */
export const SESSION_WAITING_FOR = ["input", "turn"] as const;
export const sessionWaitingForSchema = z.enum(SESSION_WAITING_FOR);
export type SessionWaitingFor = z.infer<typeof sessionWaitingForSchema>;

/**
 * The input of the session-row derivation: the session's own observed phase (null without hooks)
 * and its last relo command (null when it has none).
 */
export const sessionRowInputSchema = z.object({
  now: timestamp,
  observed: z.object({ phase: observedSessionPhaseSchema, phaseSince: timestamp, lastSeenAt: timestamp }).strict().nullable(),
  lastDeclaredAt: timestamp.nullable(),
}).strict().refine((value) => value.observed !== null || value.lastDeclaredAt !== null, "A session needs some evidence");
export type SessionRowInput = z.infer<typeof sessionRowInputSchema>;

/**
 * With hooks: working (turn running, evidence within T_fresh/2), waiting (permission prompt up to
 * T_history, or a turn that stopped within T_fresh), ended (hidden after T_done), else idle (folded
 * into "Idle (n)" after T_fresh/2, hidden after T_history). Without hooks: no phase, "last seen"
 * from its relo commands, hidden after T_retire.
 */
export const sessionRowDerivedSchema = z.object({
  phase: sessionPhaseSchema.nullable(),
  /** Set only while the phase is waiting. */
  waitingFor: sessionWaitingForSchema.nullable(),
  lastSeenAt: timestamp,
  fold: z.literal("idle").nullable(),
  hidden: z.boolean(),
  /** The next instant the row changes by time alone; null when only a report can change it. */
  nextChangeAt: timestamp.nullable(),
}).strict();
export type SessionRowDerived = z.infer<typeof sessionRowDerivedSchema>;

export const sessionRowSchema = z.object({
  /** `ags_…` for a session hooks report; `act_…` (its card) for a session known only from its relo commands. */
  id: z.string().regex(/^(ags|act)_[0-9a-f-]{36}$/),
  /** Source label (claude-code, codex, …), never a view of its own. */
  source: z.string().max(40).nullable(),
  project: z.string().max(120).nullable(),
  computer: z.string().max(120).nullable(),
  /** Observed phase with hooks; null without hooks (show "last seen"). */
  phase: sessionPhaseSchema.nullable(),
  observed: z.boolean(),
  /** Why a waiting session waits ("needs your input" or "your turn"); null unless waiting. */
  waitingFor: sessionWaitingForSchema.nullable(),
  /** Last evidence for this session: its last observed activity, or its last relo command without hooks. */
  lastSeenAt: timestamp,
  /** "idle": folded into "Idle (n)". */
  fold: z.literal("idle").nullable(),
  /** The session's open card, if any. */
  workId: z.string().regex(/^act_[0-9a-f-]{36}$/).nullable(),
  /** Sealed session names (phones only). */
  sealedNames: z.unknown().nullable().optional(),
  /** The next instant this row changes by time alone. */
  nextChangeAt: timestamp.nullable(),
}).strict();
export type SessionRow = z.infer<typeof sessionRowSchema>;

export const SESSIONS_VIEW_MAX = 20;
export const sessionsViewSchema = z.object({
  /** Live sessions first (working, waiting, idle, ended), folded rows included with `fold` set. */
  sessions: z.array(sessionRowSchema).max(SESSIONS_VIEW_MAX),
  folds: z.object({ idle: z.number().int().nonnegative() }).strict(),
}).strict();
export type SessionsView = z.infer<typeof sessionsViewSchema>;

/** The Now top line: "Since 18:40: 3 finished, 1 failed, 2 waiting on you, 1 stopped without finishing". */
export const sinceYouLookedSchema = z.object({
  /** The later of the owner's last look and now − T_history. */
  since: timestamp,
  finished: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  waitingOnYou: z.number().int().nonnegative(),
  stoppedWithoutFinishing: z.number().int().nonnegative(),
  needsYou: z.number().int().nonnegative(),
}).strict();
export type SinceYouLooked = z.infer<typeof sinceYouLookedSchema>;

export const nowItemSchema = z.object({
  /** The work's card. */
  id: z.string().regex(/^act_[0-9a-f-]{36}$/),
  /** Readable title and status; placeholders for sealed cards (open the sealed text by this id). */
  title: z.string().max(200),
  status: z.string().max(160).nullable(),
  sourceName: z.string().max(200).nullable(),
  project: z.string().max(160).nullable(),
  steps: z.object({
    done: z.number().int().nonnegative(), total: z.number().int().positive(),
    current: z.string().max(80).nullable(),
  }).strict().nullable(),
  producer: producerTypeSchema,
  /** The session row this work belongs to (agent sessions only), when known. */
  sessionId: z.string().regex(/^(ags|act)_[0-9a-f-]{36}$/).nullable(),
  /** The card's newest notification event (`ntf_…`), to open its detail; null when none is visible. */
  notificationId: z.string().regex(/^ntf_[0-9a-f-]{36}$/).nullable(),
  startedAt: timestamp,
  /** The work's last declared write. */
  declaredAt: timestamp,
  /** The question referencing the work, when one is pending, missed or recently answered. */
  question: z.object({
    id: z.string().regex(/^int_[0-9a-f-]{36}$/),
    standing: questionStandingSchema,
    askedAt: timestamp,
    openedAt: timestamp.nullable(),
  }).strict().nullable(),
  owner: ownerStateResultSchema,
  /**
   * End-to-end sealed text for this phone, which opens it in place of the placeholders above. Phones
   * only (device credential), never the Dashboard or the CLI; absent when neither envelope exists.
   * `card`: the card's current content envelope (kind "card", plaintext {title,status,steps?}), the
   * text its Live Activity pushes carry. `question`: the pending or missed question's content
   * envelope (kind "question") when `question` is set and sealed.
   */
  sealed: z.object({
    card: sealedEnvelopeSchema.nullable(),
    question: sealedEnvelopeSchema.nullable(),
  }).strict().optional(),
}).strict();
export type NowItem = z.infer<typeof nowItemSchema>;

export const nowSummarySchema = z.object({
  serverTime: timestamp,
  sinceYouLooked: sinceYouLookedSchema,
  needsYou: z.array(nowItemSchema),
  /** Failed, done and left unfinished since the owner looked, newest first. */
  recent: z.array(nowItemSchema),
  waitingOnYou: z.array(nowItemSchema),
  running: z.array(nowItemSchema),
  quiet: z.array(nowItemSchema),
  paused: z.array(nowItemSchema),
  /** Fold counts, for the one-line rows. */
  folds: z.object({
    waitingOnYou: z.number().int().nonnegative(),
    quiet: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
  }).strict(),
  /** What each phone's Lock Screen shows: at most LOCK_SCREEN_MAX_CARDS cards by relevance. */
  lockScreen: z.object({
    cards: z.array(z.string().regex(/^act_[0-9a-f-]{36}$/)).max(LOCK_SCREEN_MAX_CARDS),
    /** Dynamic Island compact/minimal: the needs-you count when > 0, else the focus card's step. */
    needsYouCount: z.number().int().nonnegative(),
    focus: z.string().regex(/^act_[0-9a-f-]{36}$/).nullable(),
  }).strict(),
  sessions: sessionsViewSchema,
  /** The earliest nextChangeAt over items and session rows: clients refetch then (no client timers). */
  refreshAt: timestamp.nullable(),
}).strict();
export type NowSummary = z.infer<typeof nowSummarySchema>;

/** `GET /api/now?since=<ISO>`: since is the owner's last look on this device (a device fact). */
export const nowQuerySchema = z.object({ since: timestamp.optional() }).strict();
