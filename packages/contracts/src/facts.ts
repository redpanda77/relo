import { OWNER_STATE_TIMING } from "./owner-state.js";
import {
  PLAN_ROUNDS_WITH_STEPS, WORK_DETAIL_MAX, WORK_GOAL_MAX, WORK_LABEL_MAX, WORK_OUTCOME_MAX, WORK_PLAN_MAX_DEPTH, WORK_PLAN_MAX_NODES, WORK_PLAN_MAX_STEPS, WORK_STATUS_MAX, WORK_WAITING_MAX,
} from "./works.js";

/**
 * The numbers Relo promises (plan 10 M6): every limit, lifetime, window and schedule a user can read in the docs,
 * the CLI's help or the skill. The server imports them, the CLI gets a generated copy
 * (packages/cli/src/shared/facts.generated.mjs), and the docs embed them (`{{fact question.defaultSeconds}}`), so a
 * number is typed once. Engineering constants (batch sizes, timeouts nobody reads about) stay in their modules.
 */
export const FACTS = {
  requests: {
    /** Writes per minute for an account, across all its credentials. */
    accountPerMinute: 300,
    /** Writes per minute for one CLI login. */
    loginPerMinute: 60,
    /** Writes per minute for one phone. */
    devicePerMinute: 120,
    /** Writes per minute for one webhook service. */
    servicePerMinute: 60,
    /** Work writes (start, update, heartbeat, finish) per minute for one login or service. */
    workPerMinute: 120,
    /** Work writes per minute for an account. */
    accountWorkPerMinute: 600,
    /** Other writes a phone or login makes to keep itself current (keys, tokens, reads), per minute. */
    upkeepPerMinute: 120,
    /** Upkeep writes per minute for an account. */
    accountUpkeepPerMinute: 600,
    /** Observed session snapshots per minute for one computer's hooks. */
    snapshotsPerMinute: 120,
    /** Observed session snapshots per minute for an account. */
    accountSnapshotsPerMinute: 600,
  },
  question: {
    /** How long a question waits when the asker says nothing. */
    defaultSeconds: 300,
    /** The longest a server's admin may let a question wait. */
    ceilingSeconds: 30 * 24 * 60 * 60,
    /** The admin's limit until they change it. */
    serverCapSeconds: 7 * 24 * 60 * 60,
    /** How long `relo ask` waits in the foreground for an agent before it hands back a wait command. */
    agentWaitSeconds: 100,
  },
  card: {
    /** The longest a card lives on the Lock Screen (an iOS limit); work continues in Relo after it. */
    maxSeconds: OWNER_STATE_TIMING.historySeconds,
    /** A quiet card dims ("not updated") after this. */
    freshSeconds: OWNER_STATE_TIMING.freshSeconds,
    /** A quiet card leaves the Lock Screen after this. */
    retireSeconds: OWNER_STATE_TIMING.retireSeconds,
    /** A finished card stays on the Lock Screen this long. */
    doneSeconds: OWNER_STATE_TIMING.doneSeconds,
    /** A failed card stays this long, so a failure is not missed. */
    failedSeconds: 60 * 60,
  },
  work: {
    goalMax: WORK_GOAL_MAX,
    statusMax: WORK_STATUS_MAX,
    outcomeMax: WORK_OUTCOME_MAX,
    stepLabelMax: WORK_LABEL_MAX,
    waitingMax: WORK_WAITING_MAX,
    planMaxSteps: WORK_PLAN_MAX_STEPS,
    planMaxNodes: WORK_PLAN_MAX_NODES,
    planMaxDepth: WORK_PLAN_MAX_DEPTH,
    /** Rounds whose steps are kept and sent: the newest ones (the open round and the two before it); older rounds keep only their entry. */
    planRoundsWithSteps: PLAN_ROUNDS_WITH_STEPS,
    detailMax: WORK_DETAIL_MAX,
  },
  lease: {
    /** The shortest lease a script or service may take. */
    minSeconds: 60,
    /** The longest lease. */
    maxSeconds: 3600,
    /** The lease `relo work start --lease` takes when no length is given. */
    defaultSeconds: 900,
  },
  callback: {
    /** Waits between answer-callback attempts: the first is immediate, then these. */
    retryDelaysSeconds: [30, 120, 600, 3_600, 10_800, 21_600, 43_200, 86_400, 86_400] as readonly number[],
    /** A callback stops retrying this long after its first attempt. */
    giveUpSeconds: 72 * 3_600,
    /** How many times a day an asker may ask for a callback again. */
    redeliveriesPerDay: 10,
  },
  outbox: {
    /** Writes that could not be sent stay on the computer's dead list this long. */
    deadDays: 7,
  },
  credentials: {
    /** A credential unused this long is flagged in doctor and the Dashboard. */
    unusedDays: 30,
    /** A CI token's lifetime when none is given. */
    ciTokenDefaultDays: 30,
    /** The longest a CI token may live. */
    ciTokenMaxDays: 90,
    /** Active CI tokens per account. */
    ciTokenMaxActive: 20,
  },
  computers: {
    /** The most a computer's machine report may weigh (JSON bytes); the server refuses a larger one. */
    reportMaxBytes: 32768,
  },
  retention: {
    /** The content window the deploy files set: readable content is removed this long after it ends. */
    defaultHours: 10,
  },
} as const;

/** How a fact reads in prose; the docs builder formats by unit. */
export type FactUnit = "seconds" | "per-minute" | "count" | "characters" | "bytes" | "days" | "hours" | "seconds-list";

/** Every fact by its dotted id, with the unit it is written in. A test keeps this and FACTS in step. */
export const FACT_UNITS: Record<string, FactUnit> = {
  "requests.accountPerMinute": "per-minute",
  "requests.loginPerMinute": "per-minute",
  "requests.devicePerMinute": "per-minute",
  "requests.servicePerMinute": "per-minute",
  "requests.workPerMinute": "per-minute",
  "requests.accountWorkPerMinute": "per-minute",
  "requests.upkeepPerMinute": "per-minute",
  "requests.accountUpkeepPerMinute": "per-minute",
  "requests.snapshotsPerMinute": "per-minute",
  "requests.accountSnapshotsPerMinute": "per-minute",
  "question.defaultSeconds": "seconds",
  "question.ceilingSeconds": "seconds",
  "question.serverCapSeconds": "seconds",
  "question.agentWaitSeconds": "seconds",
  "card.maxSeconds": "seconds",
  "card.freshSeconds": "seconds",
  "card.retireSeconds": "seconds",
  "card.doneSeconds": "seconds",
  "card.failedSeconds": "seconds",
  "work.goalMax": "characters",
  "work.statusMax": "characters",
  "work.outcomeMax": "characters",
  "work.stepLabelMax": "characters",
  "work.waitingMax": "characters",
  "work.planMaxSteps": "count",
  "work.planMaxNodes": "count",
  "work.planMaxDepth": "count",
  "work.planRoundsWithSteps": "count",
  "work.detailMax": "characters",
  "lease.minSeconds": "seconds",
  "lease.maxSeconds": "seconds",
  "lease.defaultSeconds": "seconds",
  "callback.retryDelaysSeconds": "seconds-list",
  "callback.giveUpSeconds": "seconds",
  "callback.redeliveriesPerDay": "count",
  "outbox.deadDays": "days",
  "credentials.unusedDays": "days",
  "credentials.ciTokenDefaultDays": "days",
  "credentials.ciTokenMaxDays": "days",
  "credentials.ciTokenMaxActive": "count",
  "computers.reportMaxBytes": "bytes",
  "retention.defaultHours": "hours",
};

/** Every fact as `[id, value]`, in declaration order. */
export function factEntries(): Array<[string, number | readonly number[]]> {
  return Object.entries(FACTS).flatMap(([group, values]) =>
    Object.entries(values).map(([name, value]) => [`${group}.${name}`, value as number | readonly number[]] as [string, number | readonly number[]]));
}
