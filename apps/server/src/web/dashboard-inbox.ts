import type { Handler } from "hono";
import { unclaimedLoginsVisible } from "../server-accounts.js";
import { decisionGroupRepresentative } from "../pending-inventory.js";
import type { Database } from "../db.js";
import { sessionHandlesIn, sessionsNamingHandles } from "../agent-sessions.js";
import { loadDeliveryEvidence } from "../delivery-evidence.js";
import { allowedDeliveryReconciliationActions } from "../delivery-reconciliation.js";
import { internalId, publicId } from "../ids.js";
import {
  decryptedNotificationBody,
  type NotificationContentCipher,
} from "../notification-content.js";
import { accountOrRedirect,isoDate,pageNumber,secureHtml,dashboardDocumentOptions,type DashboardDocumentOptions } from "./http.js";
import type { z } from "zod";
import { loadNowSummary } from "../api/now-routes.js";
import { loadOwnerStateInputs } from "../derive/load.js";
import { deriveOwnerState } from "../derive/owner-state.js";
import { respondingDeviceResource } from "../api/resources.js";
import { inboxDashboardBootstrapSchema,inboxOverviewSchema,notificationHistorySchema,deliveryHistorySchema,notificationDetailSchema,inboxShellSchema } from "@relo/notification-contracts/dashboard/inbox";

const pageSize = 25;
/**
 * History's kinds, as the iPhone names them: messages (plain notifications), decisions (anything that
 * asked the owner), Live Activities (work cards) and responses (what the owner answered). Each is a
 * predicate over one logical row of `notificationListSql`.
 */
const historyKinds = {
  message: `kind='notification' AND question IS NULL`,
  decision: `question IS NOT NULL`,
  live_activity: `kind='live_activity'`,
  response: `question->>'state' IN ('approved','denied','yes','no','replied')`,
} as const;
/** History's states in the owner's words, mapped honestly onto the stored truth. */
const historyStates = {
  running: `activity_state='active'`,
  done: `activity_state<>'active' AND activity_outcome='completed'`,
  failed: `activity_state<>'active' AND activity_outcome='failed'`,
  // Ended without saying it was done or failed: dropped, expired, replaced or ended by a safeguard.
  stopped: `activity_state<>'active' AND activity_outcome IS NULL`,
  answered: `question->>'state' IN ('approved','denied','yes','no','replied')`,
  missed: `(question->>'state'='expired' OR (question->>'state'='pending'
    AND (question->>'expiresAt')::timestamptz<=statement_timestamp()))`,
} as const;
type HistoryKind = keyof typeof historyKinds;
type HistoryState = keyof typeof historyStates;
const historyKindNames = Object.keys(historyKinds) as HistoryKind[];
const historyStateNames = Object.keys(historyStates) as HistoryState[];

/** "50%_off" -> "50\%\_off": a search is literal text, never a pattern. */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * History's filters over one logical row ($2 kind … $7 search). The search reads only what the
 * server can read: a sealed row (ADR 0005) holds placeholders, so it matches by its source alone.
 */
function historyFilterSql(kind: HistoryKind | null, state: HistoryState | null): string {
  return [
    // Every parameter stays referenced, so Postgres can type it.
    kind ? `($2::text IS NOT NULL AND (${historyKinds[kind]}))` : "$2::text IS NULL",
    state ? `($3::text IS NOT NULL AND (${historyStates[state]}))` : "$3::text IS NULL",
    `($4::text IS NULL OR NULLIF(BTRIM(activity_context->>'project'),'')=$4)`,
    `($5::text IS NULL OR source=$5)`,
    `($6::text IS NULL OR NULLIF(BTRIM(activity_context->>'computer'),'')=$6)`,
    `($7::text IS NULL OR source ILIKE $7 OR (NOT COALESCE(event_encrypted,false)
      AND NOT COALESCE(activity_encrypted,false) AND (
        title ILIKE $7 OR body ILIKE $7 OR activity_title ILIKE $7 OR activity_status ILIKE $7
        OR activity_context->>'taskTitle' ILIKE $7 OR activity_context->>'threadName' ILIKE $7
        OR activity_context->>'project' ILIKE $7 OR resource_project_name ILIKE $7)))`,
  ].join("\n        AND ");
}

export type DashboardInboxShell = z.input<typeof inboxShellSchema>;

export type DashboardPagination = {
  page: number;
  pageSize: 25;
  total: number;
  pageCount: number;
  previousHref: string | null;
  nextHref: string | null;
};

export type DashboardNotificationSummary = {
  id: string;
  /** True when the text is sealed end to end: title and body are placeholders (ADR 0005). */
  encrypted: boolean;
  title: string;
  body: string;
  source: string;
  requesterKind: "cli" | "webhook" | "dashboard";
  kind: string;
  state: string;
  readAt: string | null;
  withdrawnAt: string | null;
  createdAt: string | null;
  destination:
    | { state: "safe"; href: string }
    | { state: "unsafe" | "not-set"; href: null };
  targetDeviceNames: string[];
  response: { action: string; respondedAt: string | null } | null;
  context: DashboardActivityContext;
  originThreadId: string | null;
  activity: DashboardActivitySummary | null;
  question?: DashboardQuestion | null;
  resources: {
    source: { id: string; kind: string; name: string };
    project: {
      id: string;
      name: string;
      isDirect: boolean;
      palette: { slot: number; generation: number };
      icon: string;
      revision: number;
    };
    conversationId: string | null;
    workItemId: string | null;
  } | null;
};

export type DashboardActivityContext = {
  providerName: string | null;
  producerKind: string | null;
  computer: string | null;
  account: string | null;
  project: string | null;
  providerThreadId: string | null;
  providerWorkItemId: string | null;
  threadName: string | null;
  taskTitle: string | null;
  threadNameSource: string | null;
  taskTitleSource: string | null;
};

export type DashboardActivitySummary = {
  id: string;
  operation: string;
  eventSequence: number;
  generation: number;
  sequence: number;
  state: string;
  title: string;
  status: string;
  detail: string | null;
  progress: number | null;
  originThreadId: string | null;
  conversationId: string | null;
  workItemId: string | null;
  lifecycle: { provider: string; runId: string } | null;
  context: DashboardActivityContext;
  createdAt: string | null;
  updatedAt: string | null;
  staleAt: string | null;
  expiresAt: string | null;
  endedAt: string | null;
  terminalReason: string | null;
  terminalActor: string | null;
  terminalPolicy: string | null;
  terminalTransitionAt: string | null;
  presentationPresetId: string | null;
  presentationPresetRevision: number | null;
  presentationPolicySource: string | null;
  /** True when the card's text is sealed end to end: title, status and steps are placeholders. */
  encrypted: boolean;
  /** Card digest (additive): how the work ended, step progress and update count. */
  outcome?: "completed" | "failed" | null;
  steps?: { done: number; total: number; current: string | null; currentIndex?: number; fill?: number } | null;
  updates?: number | null;
  stepItems?: Array<{ label: string; state: string }>;
};

export type DashboardQuestion = {
  kind: string;
  encrypted: boolean;
  prompt: string;
  state: string;
  respondedAt: string | null;
  expiresAt: string | null;
  chosenLabel: string | null;
};

export type DashboardDeliverySummary = {
  id: string;
  notificationId: string;
  encrypted: boolean;
  title: string;
  source: string;
  deviceName: string;
  transport: string;
  state: string;
  attemptCount: number;
  providerMessageId: string | null;
  serialization: {
    canonicalIntent: string | null;
    deviceProjection: string | null;
    providerBytes: string | null;
  };
  error: { code: string; message: string | null } | null;
  reconciliation: {
    required: boolean;
    allowedActions: Array<"mark_accepted" | "retry" | "cancel">;
    resolvedAction: string | null;
  };
  acceptedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type InboxOverviewBootstrap = z.input<typeof inboxOverviewSchema>;

export type NotificationHistoryBootstrap = z.input<typeof notificationHistorySchema>;

export type DeliveryHistoryBootstrap = z.input<typeof deliveryHistorySchema>;

export type NotificationDetailBootstrap = z.input<typeof notificationDetailSchema>;

export type InboxDashboardBootstrap = z.input<typeof inboxDashboardBootstrapSchema>;

export type InboxDashboardAccount = {
  principalId: string;
  accountId: string;
  user: { name: string; email: string };
};

type InboxHandlerDependencies = {
  db: Database;
  releaseIdentity: string;
  getAccount(headers: Headers): Promise<InboxDashboardAccount | null>;
  renderDocument(bootstrap: InboxDashboardBootstrap,options?: DashboardDocumentOptions): Promise<string>;
  contentCipher?: NotificationContentCipher;
};

type DashboardCounts = {
  approvals: number;
  pending_responses: number;
  notifications: number;
  deliveries: number;
};

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function pagination(
  path: string,
  requestedPage: number,
  totalValue: unknown,
  query: Record<string, string | null> = {},
): DashboardPagination {
  const total = number(totalValue);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const href = (nextPage: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value) params.set(key, value);
    params.set("page", String(nextPage));
    return `${path}?${params.toString()}`;
  };
  return {
    page,
    pageSize,
    total,
    pageCount,
    previousHref: page > 1 ? href(page - 1) : null,
    nextHref: page < pageCount ? href(page + 1) : null,
  };
}

function names(value: unknown): string[] {
  if (Array.isArray(value))
    return value
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  return typeof value === "string"
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function activityContext(value: unknown): DashboardActivityContext {
  const context = record(value);
  return {
    providerName: optionalString(context.providerName),
    producerKind: optionalString(context.producerKind),
    computer: optionalString(context.computer),
    account: optionalString(context.account),
    project: optionalString(context.project),
    providerThreadId: optionalString(context.providerThreadId),
    providerWorkItemId: optionalString(context.providerWorkItemId),
    threadName: optionalString(context.threadName),
    taskTitle: optionalString(context.taskTitle),
    threadNameSource: optionalString(context.threadNameSource),
    taskTitleSource: optionalString(context.taskTitleSource),
  };
}

function activitySummary(row: Record<string, any>): DashboardActivitySummary | null {
  if (!row.live_activity_id) return null;
  const state = String(row.activity_state ?? "unknown");
  const staleAt = isoDate(row.activity_stale_at);
  const expiresAt = isoDate(row.activity_expires_at);
  const terminalReason = optionalString(row.activity_terminal_reason);
  return {
    id: publicId("act", String(row.live_activity_id)),
    operation: String(row.activity_operation ?? "unknown"),
    eventSequence: number(row.activity_event_sequence),
    generation: Math.max(1, number(row.activity_generation)),
    sequence: number(row.activity_sequence),
    state,
    title: String(row.activity_title ?? row.title ?? "Untitled activity"),
    status: String(row.activity_status ?? "Unknown status"),
    detail: row.activity_detail == null ? null : String(row.activity_detail),
    progress: row.activity_progress == null ? null : Number(row.activity_progress),
    originThreadId: optionalString(row.activity_origin_hash),
    conversationId: row.activity_conversation_id
      ? publicId("cnv",String(row.activity_conversation_id)) : null,
    workItemId: row.activity_work_item_id
      ? publicId("wrk",String(row.activity_work_item_id)) : null,
    lifecycle:
      row.lifecycle_provider && row.lifecycle_run_id
        ? {
            provider: String(row.lifecycle_provider),
            runId: String(row.lifecycle_run_id),
          }
        : null,
    context: activityContext(row.activity_context),
    createdAt: isoDate(row.activity_created_at),
    updatedAt: isoDate(row.activity_updated_at),
    staleAt,
    expiresAt,
    endedAt: isoDate(row.activity_ended_at),
    terminalReason,
    terminalActor: optionalString(row.activity_terminal_actor),
    terminalPolicy: optionalString(row.activity_terminal_policy),
    terminalTransitionAt: isoDate(row.activity_terminal_transition_at),
    presentationPresetId: optionalString(row.activity_presentation_preset_id),
    presentationPresetRevision: row.activity_presentation_preset_revision == null
      ? null : number(row.activity_presentation_preset_revision),
    presentationPolicySource: optionalString(row.activity_presentation_policy_source),
    encrypted: row.activity_encrypted === true,
    outcome: row.activity_outcome === "completed" || row.activity_outcome === "failed"
      ? row.activity_outcome : null,
    updates: row.activity_updates == null ? null : number(row.activity_updates),
    steps: stepDigest(row.activity_steps),
  };
}

function stepDigest(value: unknown): { done: number; total: number; current: string | null; currentIndex?: number; fill?: number } | null {
  const steps = record(value);
  const total = number(steps.total);
  if (total <= 0) return null;
  const index = number(steps.currentIndex);
  return { done: number(steps.done), total, current: optionalString(steps.current),
    ...(index >= 1 ? { currentIndex: index } : {}),
    ...(typeof steps.fill === "number" && Number.isFinite(steps.fill) ? { fill: Math.min(1, Math.max(0, steps.fill)) } : {}) };
}

type PlanStepState = "open" | "current" | "done" | "skipped";
type PlanTreeStep = { id: string; state: PlanStepState; label?: string; parent?: string; round?: number; detail?: string; startedAt?: string; doneAt?: string };
type PlanTreeRound = { n: number; state: "open" | "closed"; title?: string; outcome?: string; openedAt?: string; closedAt?: string };
const STEP_STATES = new Set<string>(["open", "current", "done", "skipped"]);
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const positive = (value: unknown) => (Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined);
type Loose<T> = { [K in keyof T]: T[K] | undefined };
const defined = <T extends object>(value: Loose<T>) => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

/** The work's plan and rounds for the detail page's tree, read back into the contract's shape; nothing without a plan. */
function planTree(value: unknown): { plan?: PlanTreeStep[]; rounds?: PlanTreeRound[] } {
  const tree = record(value);
  const plan = (Array.isArray(tree.plan) ? tree.plan : []).map(record)
    .filter((step) => typeof step.id === "string" && STEP_STATES.has(String(step.state)))
    .map((step) => defined<PlanTreeStep>({ id: String(step.id), state: step.state as PlanStepState, label: text(step.label),
      parent: text(step.parent), round: positive(step.round), detail: text(step.detail), startedAt: text(step.startedAt), doneAt: text(step.doneAt) }));
  const rounds = (Array.isArray(tree.rounds) ? tree.rounds : []).map(record)
    .filter((round) => positive(round.n) !== undefined && (round.state === "open" || round.state === "closed"))
    .map((round) => defined<PlanTreeRound>({ n: positive(round.n)!, state: round.state as "open" | "closed", title: text(round.title),
      outcome: text(round.outcome), openedAt: text(round.openedAt), closedAt: text(round.closedAt) }));
  return { ...(plan.length ? { plan } : {}), ...(rounds.length ? { rounds } : {}) };
}

function stepItems(value: unknown, isPrivate: boolean): Array<{ label: string; state: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).map((item, index) => {
    const step = record(item);
    return {
      label: isPrivate ? `Step ${index + 1}` : String(step.label ?? `Step ${index + 1}`).slice(0, 120),
      state: String(step.state ?? "pending"),
    };
  });
}

function questionDigest(value: unknown): DashboardQuestion | null {
  const question = record(value);
  if (!question.prompt || !question.state) return null;
  return {
    kind: String(question.kind ?? "approval"),
    encrypted: question.encrypted === true,
    prompt: String(question.prompt),
    state: String(question.state),
    respondedAt: isoDate(question.respondedAt),
    expiresAt: isoDate(question.expiresAt),
    chosenLabel: typeof question.chosenLabel === "string" ? question.chosenLabel : null,
  };
}

/**
 * Attaches the derived absence (why a card left the screen or dimmed) to the work cards of a page: the
 * same derive() the phone reads, never worked out here. Display only; a failed load leaves the rows plain.
 */
async function withAbsences(db: Database,principalId: string,summaries: DashboardNotificationSummary[]): Promise<DashboardNotificationSummary[]> {
  const ids = summaries.flatMap((summary) => summary.activity ? [summary.activity.id] : []);
  if (!ids.length) return summaries;
  const loaded = await loadOwnerStateInputs(db,principalId,ids,new Date()).catch(() => []);
  const absences = new Map(loaded.flatMap((work) => {
    const absence = deriveOwnerState(work.input).absence;
    return absence ? [[work.id,absence] as const] : [];
  }));
  return summaries.map((summary) => {
    const absence = summary.activity ? absences.get(summary.activity.id) : undefined;
    return absence && summary.activity ? { ...summary,activity: { ...summary.activity,absence } } : summary;
  });
}

function notificationSummary(
  row: Record<string, any>,
): DashboardNotificationSummary {
  const activity = activitySummary(row);
  const context = activity?.context ?? activityContext(row.event_context);
  const eventState = String(row.state ?? "unknown");
  const state =
    activity?.state ??
    (row.kind === "notification" && eventState === "active"
      ? "recorded"
      : eventState);
  const paletteOrdinal = Number(row.resource_project_palette_ordinal);
  const resources = row.resource_source_id && row.resource_project_id
    ? {
        source: {
          id: `src_${row.resource_source_id}`,
          kind: String(row.resource_source_kind),
          name: String(row.resource_source_name),
        },
        project: {
          id: `prj_${row.resource_project_id}`,
          name: String(row.resource_project_name),
          isDirect: Boolean(row.resource_project_is_direct),
          palette: {
            slot: paletteOrdinal % 12,
            generation: Math.floor(paletteOrdinal / 12),
          },
          icon: String(row.resource_project_icon),
          revision: number(row.resource_project_revision),
        },
        conversationId: row.resource_conversation_id ? `cnv_${row.resource_conversation_id}` : null,
        workItemId: row.resource_work_item_id ? `wrk_${row.resource_work_item_id}` : null,
      }
    : null;
  return {
    id: publicId("ntf", String(row.id)),
    // A card is sealed when its row keeps envelopes; anything else when its event does.
    encrypted: activity ? activity.encrypted : row.event_encrypted === true,
    title: String(row.title ?? "Untitled notification"),
    body: String(row.body ?? ""),
    source: String(row.source ?? "Unknown source"),
    requesterKind: row.requester_service_id
      ? "webhook"
      : row.requester_credential_id
        ? "cli"
        : "dashboard",
    kind: String(row.kind ?? "notification"),
    state,
    readAt: isoDate(row.read_at),
    withdrawnAt: isoDate(row.withdrawn_at),
    createdAt: isoDate(row.created_at),
    destination: (() => {
      const safe = safeDestination(row.deep_link);
      return safe
        ? { state: "safe" as const, href: safe }
        : { state: row.deep_link ? "unsafe" as const : "not-set" as const, href: null };
    })(),
    targetDeviceNames: names(row.device_names),
    response: row.response_action
      ? {
          action: String(row.response_action),
          respondedAt: isoDate(row.responded_at),
        }
      : null,
    context,
    originThreadId: activity?.originThreadId ?? optionalString(row.event_origin_hash),
    activity,
    question: questionDigest(row.question),
    resources,
  };
}

function deliverySummary(row: Record<string, any>): DashboardDeliverySummary {
  return {
    id: publicId("job",String(row.id)),
    notificationId: publicId("ntf", String(row.event_id)),
    encrypted: row.encrypted === true,
    title: String(row.title ?? "Untitled notification"),
    source: String(row.source ?? "Unknown source"),
    deviceName: String(row.device_name ?? "Unnamed device"),
    transport: String(row.transport ?? "apns"),
    state: String(row.state ?? "unknown"),
    attemptCount: number(row.attempt_count),
    providerMessageId:
      row.provider_message_id == null ? null : String(row.provider_message_id),
    serialization: {
      canonicalIntent: shortSerializationHash(row.canonical_intent_sha256),
      deviceProjection: shortSerializationHash(row.device_projection_sha256),
      providerBytes: shortSerializationHash(row.apns_payload_sha256),
    },
    error:
      row.last_error_code == null
        ? null
        : {
            code: String(row.last_error_code),
            message:
              row.last_error_message == null
                ? null
                : String(row.last_error_message),
          },
    reconciliation: {
      required: row.state === "reconciliation_required",
      allowedActions: allowedDeliveryReconciliationActions(row),
      resolvedAction: row.reconciliation_action == null ? null : String(row.reconciliation_action),
    },
    acceptedAt: isoDate(row.accepted_at),
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  };
}

function shortSerializationHash(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
    ? `sha256:${value.slice(0,12)}`
    : null;
}

function safeDestination(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function canonicalResponseText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  for (const key of ["response", "value", "text"] as const) {
    if (typeof envelope[key] === "string") return envelope[key];
  }
  return null;
}

function shell(input: {
  account: InboxDashboardAccount;
  releaseIdentity: string;
  active: DashboardInboxShell["active"];
  title: string;
  description: string;
  counts: DashboardCounts;
}): DashboardInboxShell {
  return {
    title: input.title,
    description: input.description,
    active: input.active,
    releaseIdentity: input.releaseIdentity,
    account: {
      id: input.account.accountId,
      initial: input.account.user.name.trim().charAt(0).toUpperCase() || "K",
      name: input.account.user.name,
      email: input.account.user.email,
    },
    counts: {
      pending:
        number(input.counts.pending_responses) + number(input.counts.approvals),
      notifications: number(input.counts.notifications),
      deliveries: number(input.counts.deliveries),
    },
  };
}

async function loadCounts(
  db: Database,
  principalId: string,
): Promise<DashboardCounts> {
  const result = await db.query<DashboardCounts>(
    `SELECT
    (SELECT count(*)::int FROM device_authorizations WHERE status='pending' AND expires_at>now()
      AND ${unclaimedLoginsVisible}) AS approvals,
    (SELECT count(*)::int FROM interaction_requests r WHERE r.principal_id=$1 AND r.state='pending' AND r.expires_at>now()
      AND ${decisionGroupRepresentative("r","now()")}) AS pending_responses,
    (SELECT count(DISTINCT COALESCE(
       payload#>>'{liveActivity,activityId}',
       'ntf_'||id::text
     ))::int FROM notification_events WHERE principal_id=$1) AS notifications,
    (SELECT count(*)::int FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
      WHERE e.principal_id=$1) AS deliveries`,
    [principalId],
  );
  return (
    result.rows[0] ?? {
      approvals: 0,
      pending_responses: 0,
      notifications: 0,
      deliveries: 0,
    }
  );
}

const activityProjectionSql = `a.id AS live_activity_id,
    e.payload#>>'{liveActivity,operation}' AS activity_operation,
    e.payload#>>'{liveActivity,sequence}' AS activity_event_sequence,
    a.state::text AS activity_state,a.generation AS activity_generation,a.sequence AS activity_sequence,
    a.title AS activity_title,a.status AS activity_status,a.detail AS activity_detail,
    a.progress AS activity_progress,COALESCE(a.context,e.payload->'context') AS activity_context,
    COALESCE(a.origin_hash,e.origin_hash) AS activity_origin_hash,
    a.conversation_id AS activity_conversation_id,a.work_item_id AS activity_work_item_id,
    a.lifecycle_provider,a.lifecycle_run_id,a.created_at AS activity_created_at,
    a.updated_at AS activity_updated_at,a.stale_at AS activity_stale_at,
    a.expires_at AS activity_expires_at,a.ended_at AS activity_ended_at,
    a.terminal_reason AS activity_terminal_reason,a.terminal_actor AS activity_terminal_actor,
    a.terminal_policy AS activity_terminal_policy,a.terminal_transition_at AS activity_terminal_transition_at,
    a.presentation_preset_id AS activity_presentation_preset_id,
    a.presentation_preset_revision AS activity_presentation_preset_revision,
    a.presentation_policy_source AS activity_presentation_policy_source,
    a.sealed IS NOT NULL AS activity_encrypted,
    CASE WHEN a.state<>'active' AND a.presentation#>>'{state,kind}' IN ('completed','failed')
      THEN a.presentation#>>'{state,kind}' END AS activity_outcome,
    GREATEST(a.sequence,0)+1 AS activity_updates,
    (SELECT CASE WHEN COALESCE(wire.total,count(*))>0 THEN jsonb_build_object(
        'done',COALESCE(wire.done,count(*) FILTER (WHERE step->>'state'='complete')),
        'total',COALESCE(wire.total,count(*)),
        'current',CASE WHEN (e.payload->>'privacy'='private' OR e.payload#>>'{liveActivity,privacy}'='private') THEN NULL
          ELSE NULLIF(left(COALESCE(wire.label,(array_agg(step->>'label') FILTER (WHERE step->>'state'='current'))[1]),80),'') END,
        'currentIndex',wire.current,'fill',wire.fill) END
      -- The card's plan wire carries the count (top-level steps); a card from before it counts the shown steps.
      FROM (SELECT component FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(a.presentation->'components')='array' THEN a.presentation->'components' ELSE '[]'::jsonb END) component
        WHERE component->>'type'='steps' AND jsonb_typeof(component->'items')='array' LIMIT 1) steps_component
      CROSS JOIN LATERAL (SELECT
        CASE WHEN jsonb_typeof(steps_component.component->'plan'->'total')='number' AND jsonb_typeof(steps_component.component->'plan'->'done')='number'
          THEN (steps_component.component->'plan'->>'total')::int END AS total,
        CASE WHEN jsonb_typeof(steps_component.component->'plan'->'total')='number' AND jsonb_typeof(steps_component.component->'plan'->'done')='number'
          THEN (steps_component.component->'plan'->>'done')::int END AS done,
        CASE WHEN jsonb_typeof(steps_component.component->'plan'->'stepLabel')='string'
          THEN steps_component.component->'plan'->>'stepLabel' END AS label,
        CASE WHEN jsonb_typeof(steps_component.component->'plan'->'current')='number'
          THEN (steps_component.component->'plan'->>'current')::int END AS current,
        CASE WHEN jsonb_typeof(steps_component.component->'plan'->'fill')='number'
          THEN (steps_component.component->'plan'->>'fill')::float8 END AS fill) wire
      CROSS JOIN LATERAL jsonb_array_elements(steps_component.component->'items') step
      GROUP BY wire.total,wire.done,wire.label,wire.current,wire.fill
    ) AS activity_steps`;

/** Whether an event carries end-to-end envelopes; only this boolean ever leaves the server. */
const eventEncryptedSql = (alias: string) => `(jsonb_typeof(${alias}.payload->'sealed')='object'
    OR jsonb_typeof(${alias}.payload#>'{liveActivity,sealed}')='object')`;

const activityJoinSql = `LEFT JOIN live_activities a
    ON a.principal_id=e.principal_id
   AND e.kind='live_activity'
   AND e.payload#>>'{liveActivity,activityId}'=('act_'||a.id::text)`;

const notificationProjectSql = `NULLIF(BTRIM(COALESCE(a.context,e.payload->'context')->>'project'),'')`;

const logicalNotificationKeySql = `CASE
    WHEN a.id IS NOT NULL THEN 'activity:'||a.id::text
    ELSE 'notification:'||e.id::text
  END`;

const notificationListSql = `SELECT e.id,e.source,e.kind,e.title,e.body,e.deep_link,e.state,e.read_at,e.withdrawn_at,e.created_at,
    e.requester_credential_id,e.requester_service_id,
    e.payload->'context' AS event_context,e.origin_hash AS event_origin_hash,
    ${eventEncryptedSql("e")} AS event_encrypted,
    ${activityProjectionSql},
    COALESCE(a.source_resource_id,e.source_resource_id) AS resource_source_id,
    resource_source.kind AS resource_source_kind,
    resource_source.display_name AS resource_source_name,
    COALESCE(a.project_resource_id,e.project_resource_id) AS resource_project_id,
    resource_project.display_name AS resource_project_name,
    resource_project.is_direct AS resource_project_is_direct,
    resource_project.palette_ordinal AS resource_project_palette_ordinal,
    resource_project.icon AS resource_project_icon,
    resource_project.revision AS resource_project_revision,
    COALESCE(a.conversation_id,e.conversation_id) AS resource_conversation_id,
    COALESCE(a.work_item_id,e.work_item_id) AS resource_work_item_id,
    targets.device_names,response.action AS response_action,response.responded_at,
    (SELECT jsonb_build_object('kind',q.kind,'state',q.state,'encrypted',${eventEncryptedSql("qe")},'respondedAt',q.responded_at,'expiresAt',q.expires_at,
        'chosenLabel',CASE WHEN q.kind='choice' THEN q.response->>'label' END,
        'prompt',CASE WHEN (qe.payload->>'privacy'='private' OR qe.payload#>>'{liveActivity,privacy}'='private')
          THEN 'Private notification' ELSE left(q.prompt,240) END)
      FROM interaction_requests q JOIN notification_events qe ON qe.id=q.notification_event_id
      WHERE q.principal_id=e.principal_id AND (qe.id=e.id OR (a.id IS NOT NULL
        AND qe.payload#>>'{liveActivity,activityId}'=('act_'||a.id::text)))
      ORDER BY q.created_at DESC,q.id DESC LIMIT 1) AS question,
    ROW_NUMBER() OVER (
      PARTITION BY ${logicalNotificationKeySql}
      ORDER BY e.created_at DESC,e.id DESC
    ) AS logical_rank
  FROM notification_events e
  ${activityJoinSql}
  LEFT JOIN resource_sources resource_source
    ON resource_source.id=COALESCE(a.source_resource_id,e.source_resource_id)
  LEFT JOIN resource_projects resource_project
    ON resource_project.id=COALESCE(a.project_resource_id,e.project_resource_id)
  LEFT JOIN LATERAL (
    SELECT array_agg(d.name ORDER BY d.name,d.id) AS device_names
    FROM notification_event_targets t JOIN devices d ON d.id=t.device_id
    WHERE t.notification_event_id=e.id AND d.principal_id=e.principal_id
  ) targets ON true
  LEFT JOIN LATERAL (
    SELECT i.kind AS action,r.responded_at FROM interaction_requests r
    LEFT JOIN interactions i ON i.interaction_request_id=r.id
    WHERE r.notification_event_id=e.id ORDER BY i.created_at DESC NULLS LAST,r.created_at DESC LIMIT 1
  ) response ON true`;

export function createDashboardInboxHandlers(
  dependencies: InboxHandlerDependencies,
): {
  overview: Handler;
  history: Handler;
  delivery: Handler;
  detail: Handler;
} {
  const {
    db,
    getAccount,
    releaseIdentity,
    renderDocument,
    contentCipher,
  } = dependencies;

  /**
   * The page plus the agent sessions whose sealed names envelopes name its handles (ids only), so a
   * linked browser names a project on History and the detail page as it does on Now.
   */
  async function withNamesFrom<T extends object>(principalId: string, page: T): Promise<T & { namesFrom?: string[] }> {
    const namesFrom = await sessionsNamingHandles(db, principalId, sessionHandlesIn(page));
    return namesFrom.length ? { ...page, namesFrom } : page;
  }

  const overview: Handler = async (context) => {
    const account = await accountOrRedirect(context, getAccount);
    if (account instanceof Response) return account;
    const counts = await loadCounts(db, account.principalId);
    const requestedPage = pageNumber(context.req.query("page"));
    const approvalPages = pagination(
      "/dashboard",
      requestedPage,
      counts.approvals,
    );
    const [approvals, pendingResponses, notifications, running] = await Promise.all([
      db.query<any>(
        `SELECT user_code,client_name,requested_scopes,expires_at,credential_expires_at
        FROM device_authorizations WHERE status='pending' AND expires_at>now() AND ${unclaimedLoginsVisible}
        ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2`,
        [pageSize, (approvalPages.page - 1) * pageSize],
      ),
      db.query<any>(
        `SELECT r.kind,r.prompt,r.state,r.created_at,r.expires_at,e.id AS event_id,
          e.source,e.title,targets.device_names,${eventEncryptedSql("e")} AS encrypted
        FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id
        LEFT JOIN LATERAL (
          SELECT array_agg(d.name ORDER BY d.name,d.id) AS device_names
          FROM notification_event_targets t JOIN devices d ON d.id=t.device_id
          WHERE t.notification_event_id=e.id AND d.principal_id=e.principal_id
        ) targets ON true
        WHERE r.principal_id=$1 AND r.state='pending' AND r.expires_at>now()
          AND ${decisionGroupRepresentative("r","now()")}
        ORDER BY r.created_at DESC,r.id DESC LIMIT $2`,
        [account.principalId, pageSize],
      ),
      db.query<any>(
        `SELECT * FROM (${notificationListSql}
        WHERE e.principal_id=$1) logical_notifications
        WHERE logical_rank=1
        ORDER BY created_at DESC,id DESC LIMIT $2`,
        [account.principalId, pageSize],
      ),
      db.query<any>(
        `SELECT * FROM (${notificationListSql}
        WHERE e.principal_id=$1 AND a.state='active'
          AND (a.expires_at IS NULL OR a.expires_at>now())) logical_notifications
        WHERE logical_rank=1
        ORDER BY created_at DESC,id DESC LIMIT 50`,
        [account.principalId],
      ),
    ]);
    const since = context.req.query("since");
    const now = await loadNowSummary(db, account.principalId, undefined,
      since && Number.isFinite(Date.parse(since)) ? new Date(since).toISOString() : undefined);
    const bootstrap: InboxOverviewBootstrap = {
      version: 1,
      kind: "inbox-overview",
      route: { path: context.req.path, page: approvalPages.page },
      shell: shell({
        account,
        releaseIdentity,
        active: "inbox",
        title: "Now",
        description: `Account ${account.accountId}. What needs you, what is running and what finished.`,
        counts,
      }),
      summary: {
        pendingResponses: number(counts.pending_responses),
        pendingApprovals: number(counts.approvals),
        notifications: number(counts.notifications),
        deliveries: number(counts.deliveries),
      },
      pendingResponses: pendingResponses.rows.map((row) => ({
        notificationId: publicId("ntf", String(row.event_id)),
        encrypted: row.encrypted === true,
        title: String(row.title),
        source: String(row.source),
        kind: String(row.kind),
        state: String(row.state),
        prompt: String(row.prompt),
        targetDeviceNames: names(row.device_names),
        createdAt: isoDate(row.created_at),
        expiresAt: isoDate(row.expires_at),
      })),
      approvalRequests: approvals.rows.map((row) => ({
        userCode: String(row.user_code),
        clientName: String(row.client_name),
        requestedScopes: Array.isArray(row.requested_scopes)
          ? row.requested_scopes.map(String)
          : [],
        approvalExpiresAt: isoDate(row.expires_at),
        credentialExpiresAt: isoDate(row.credential_expires_at),
      })),
      approvalPagination: approvalPages,
      recentNotifications: await withAbsences(db,account.principalId,notifications.rows.map(notificationSummary)),
      runningActivities: await withAbsences(db,account.principalId,running.rows.map(notificationSummary)),
      now,
    };
    return secureHtml(context, await renderDocument(await withNamesFrom(account.principalId, bootstrap),dashboardDocumentOptions(context)));
  };

  const history: Handler = async (context) => {
    const account = await accountOrRedirect(context, getAccount);
    if (account instanceof Response) return account;
    const kind =
      historyKindNames.find((value) => value === context.req.query("kind")) ?? null;
    const state =
      historyStateNames.find((value) => value === context.req.query("state")) ?? null;
    const projectOptions = await db.query<{ project: string }>(
      `SELECT DISTINCT ${notificationProjectSql} AS project
      FROM notification_events e
      ${activityJoinSql}
      WHERE e.principal_id=$1 AND ${notificationProjectSql} IS NOT NULL
      ORDER BY project LIMIT 200`,
      [account.principalId],
    );
    const projects = projectOptions.rows.map((row) => String(row.project));
    // Which sources and computers the owner has heard from: the menus appear only with a choice.
    const originOptions = await db.query<{ history_source: string; history_computer: string | null }>(
      `SELECT DISTINCT e.source AS history_source,
        NULLIF(BTRIM(COALESCE(a.context,e.payload->'context')->>'computer'),'') AS history_computer
      FROM notification_events e
      ${activityJoinSql}
      WHERE e.principal_id=$1
      LIMIT 1000`,
      [account.principalId],
    );
    const sorted = (values: Iterable<string>) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
    const sources = sorted(originOptions.rows.map((row) => String(row.history_source)));
    const computers = sorted(originOptions.rows.flatMap((row) => row.history_computer ? [String(row.history_computer)] : []));
    const requestedProject = optionalString(context.req.query("project"));
    const project =
      requestedProject && projects.includes(requestedProject)
        ? requestedProject
        : null;
    const requestedSource = optionalString(context.req.query("source"));
    const source = requestedSource && sources.includes(requestedSource) ? requestedSource : null;
    const requestedComputer = optionalString(context.req.query("computer"));
    const computer = requestedComputer && computers.includes(requestedComputer) ? requestedComputer : null;
    const q = optionalString(context.req.query("q"))?.slice(0, 120) ?? null;
    const filters = { kind, state, project, source, computer, q };
    const filterParams = [account.principalId, kind, state, project, source, computer, q ? likePattern(q) : null];
    const where = historyFilterSql(kind, state);
    const counts = await loadCounts(db, account.principalId);
    const filtered = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM (${notificationListSql}
      WHERE e.principal_id=$1) logical_notifications
      WHERE logical_rank=1
        AND ${where}`,
      filterParams,
    );
    const pages = pagination(
      "/dashboard/inbox/notifications",
      pageNumber(context.req.query("page")),
      filtered.rows[0]?.total,
      filters,
    );
    const notifications = await db.query<any>(
      `SELECT * FROM (${notificationListSql}
      WHERE e.principal_id=$1) logical_notifications
      WHERE logical_rank=1
        AND ${where}
      ORDER BY created_at DESC,id DESC LIMIT $8 OFFSET $9`,
      [...filterParams, pageSize, (pages.page - 1) * pageSize],
    );
    const unread = await db.query<{ project: string; count: number }>(
      `SELECT COALESCE(resource_project_name,'Direct') AS project,count(*)::int AS count
      FROM (${notificationListSql}
      WHERE e.principal_id=$1) logical_notifications
      WHERE logical_rank=1 AND read_at IS NULL AND withdrawn_at IS NULL
      GROUP BY COALESCE(resource_project_name,'Direct')
      ORDER BY project`,
      [account.principalId],
    );
    const bootstrap: NotificationHistoryBootstrap = {
      version: 1,
      kind: "notification-history",
      route: {
        path: context.req.path,
        page: pages.page,
        filters,
      },
      filterOptions: { projects, sources, computers },
      shell: shell({
        account,
        releaseIdentity,
        active: "inbox-notifications",
        title: "History",
        description:
          "Review source, target, delivery state, timestamps, and canonical responses.",
        counts,
      }),
      unread: {
        total: unread.rows.reduce((total, row) => total + number(row.count), 0),
        byProject: unread.rows.map((row) => ({
          project: String(row.project),
          count: number(row.count),
        })),
      },
      notifications: await withAbsences(db,account.principalId,notifications.rows.map(notificationSummary)),
      pagination: pages,
    };
    return secureHtml(context, await renderDocument(await withNamesFrom(account.principalId, bootstrap),dashboardDocumentOptions(context)));
  };

  const delivery: Handler = async (context) => {
    const account = await accountOrRedirect(context, getAccount);
    if (account instanceof Response) return account;
    const counts = await loadCounts(db, account.principalId);
    const pages = pagination(
      "/dashboard/inbox/delivery",
      pageNumber(context.req.query("page")),
      counts.deliveries,
    );
    const deliveries = await db.query<any>(
      `SELECT j.id,j.transport,j.state,j.attempt_count,j.provider_message_id,j.last_error_code,
        j.canonical_intent_sha256,j.device_projection_sha256,j.apns_payload_sha256,
        j.last_error_message,j.accepted_at,j.created_at,j.updated_at,e.payload,
        resolution.action AS reconciliation_action,
        e.id AS event_id,e.title,e.source,d.name AS device_name,${eventEncryptedSql("e")} AS encrypted
      FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
      JOIN devices d ON d.id=j.device_id
      LEFT JOIN delivery_reconciliation_resolutions resolution ON resolution.delivery_job_id=j.id
      WHERE e.principal_id=$1
      ORDER BY j.updated_at DESC,j.id DESC LIMIT $2 OFFSET $3`,
      [account.principalId, pageSize, (pages.page - 1) * pageSize],
    );
    const bootstrap: DeliveryHistoryBootstrap = {
      version: 1,
      kind: "delivery-history",
      route: { path: context.req.path, page: pages.page },
      shell: shell({
        account,
        releaseIdentity,
        active: "inbox-delivery",
        title: "Delivery",
        description:
          "Trace target-level server and provider attempts without inferring phone receipt.",
        counts,
      }),
      deliveries: deliveries.rows.map(deliverySummary),
      pagination: pages,
    };
    return secureHtml(context, await renderDocument(bootstrap,dashboardDocumentOptions(context)));
  };

  const detail: Handler = async (context) => {
    const account = await accountOrRedirect(context, getAccount);
    if (account instanceof Response) return account;
    const notificationId = internalId(
      "ntf",
      context.req.param("notificationId") ?? "",
    );
    if (!notificationId) return context.notFound();
    const event = await db.query<any>(
      `SELECT e.id,e.source,e.kind,e.title,e.body,e.deep_link,e.state,e.expires_at,
        e.read_at,e.withdrawn_at,
        e.created_at,e.updated_at,e.target_mode,s.title AS service_title,
        content.body_ciphertext,content.body_format,
        COALESCE(e.payload->>'privacy',e.payload#>>'{liveActivity,privacy}','standard') AS privacy,
        ${eventEncryptedSql("e")} AS event_encrypted,
        (SELECT component->'items' FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(a.presentation->'components')='array' THEN a.presentation->'components' ELSE '[]'::jsonb END) component
          WHERE component->>'type'='steps' AND jsonb_typeof(component->'items')='array' LIMIT 1) AS activity_step_items,
        -- The work's plan tree and rounds, as the phone gets them (inbox/queries.ts): labels, details, titles and
        -- outcomes only when readable; a sealed work's labels open from its sealed text in the browser.
        (SELECT jsonb_build_object(
            'plan',(SELECT jsonb_agg(jsonb_build_object('id',plan_step.step->>'id','state',plan_step.step->>'state',
                'label',CASE WHEN hidden.yes THEN NULL ELSE left(plan_step.step->>'label',120) END)
                || jsonb_strip_nulls(jsonb_build_object('parent',plan_step.step->'parent','round',plan_step.step->'round',
                  'startedAt',plan_step.step->'startedAt','doneAt',plan_step.step->'doneAt',
                  'detail',CASE WHEN hidden.yes THEN NULL ELSE to_jsonb(left(plan_step.step->>'detail',200)) END))
                ORDER BY plan_step.position)
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(work.plan->'steps')='array' THEN work.plan->'steps' ELSE '[]'::jsonb END)
                WITH ORDINALITY plan_step(step,position)
              WHERE plan_step.step->>'state' IN ('open','current','done','skipped')),
            'rounds',CASE WHEN jsonb_typeof(work.plan->'rounds')='array' THEN (SELECT jsonb_agg(
                jsonb_strip_nulls(jsonb_build_object('n',r.round->'n','state',r.round->'state',
                  'title',CASE WHEN hidden.yes THEN NULL ELSE to_jsonb(left(r.round->>'title',80)) END,
                  'outcome',CASE WHEN hidden.yes THEN NULL ELSE to_jsonb(left(r.round->>'outcome',200)) END,
                  'openedAt',r.round->'openedAt','closedAt',r.round->'closedAt')) ORDER BY r.position)
              FROM jsonb_array_elements(work.plan->'rounds') WITH ORDINALITY r(round,position)) END)
          FROM works work
          CROSS JOIN LATERAL (SELECT work.sealed_text IS TRUE
            OR COALESCE(e.payload->>'privacy',e.payload#>>'{liveActivity,privacy}','standard')='private' AS yes) hidden
          WHERE work.id=a.work_id AND work.principal_id=a.principal_id) AS activity_plan_tree,
        ${activityProjectionSql}
      FROM notification_events e
      ${activityJoinSql}
      LEFT JOIN notification_contents content ON content.notification_event_id=e.id
      LEFT JOIN webhook_services s ON s.id=e.service_id
      WHERE e.id=$1 AND e.principal_id=$2`,
      [notificationId, account.principalId],
    );
    if (!event.rowCount) return context.notFound();
    const row = event.rows[0];
    const counts = await loadCounts(db, account.principalId);
    const [
      request, deliveries, receipts, operations, threadHistory, presentationLeases,
      relationships, correlationDecisions, evidenceTimeline,
    ] = await Promise.all([
      db.query<any>(
        `SELECT r.id,r.kind,r.prompt,r.state,r.response,r.expires_at,r.created_at,r.responded_at,
          winner.kind AS response_action,winner.device_id AS response_device_id,winner.browser_id AS response_browser_id,
          COALESCE(d.name,b.name) AS response_device_name
        FROM interaction_requests r
        LEFT JOIN LATERAL (
          SELECT i.kind,i.device_id,i.browser_id FROM interactions i
          WHERE i.interaction_request_id=COALESCE(r.answered_on_request_id,r.id) ORDER BY i.created_at,i.id LIMIT 1
        ) winner ON true LEFT JOIN devices d ON d.id=winner.device_id
        LEFT JOIN linked_browsers b ON b.id=winner.browser_id
        WHERE r.notification_event_id=$1 AND r.principal_id=$2`,
        [notificationId, account.principalId],
      ),
      db.query<any>(
        `SELECT j.id,j.transport,j.state,j.attempt_count,j.provider_message_id,j.last_error_code,
          j.canonical_intent_sha256,j.device_projection_sha256,j.apns_payload_sha256,
          j.last_error_message,j.accepted_at,j.created_at,j.updated_at,e.id AS event_id,e.title,e.source,
          e.payload,resolution.action AS reconciliation_action,
          d.name AS device_name,${eventEncryptedSql("e")} AS encrypted
        FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
        JOIN devices d ON d.id=j.device_id
        LEFT JOIN delivery_reconciliation_resolutions resolution ON resolution.delivery_job_id=j.id
        WHERE j.notification_event_id=$1 AND d.principal_id=$2 ORDER BY j.created_at,j.id`,
        [notificationId, account.principalId],
      ),
      db.query<any>(
        `SELECT i.kind,i.created_at,d.name AS device_name
        FROM interactions i JOIN devices d ON d.id=i.device_id
        WHERE i.notification_event_id=$1 AND i.principal_id=$2 ORDER BY i.created_at,i.id`,
        [notificationId, account.principalId],
      ),
      row.live_activity_id
        ? db.query<any>(
            `SELECT operation,resulting_sequence,created_at,activity_snapshot
            FROM live_activity_operations
            WHERE live_activity_id=$1 AND principal_id=$2
            ORDER BY resulting_sequence,created_at`,
            [row.live_activity_id, account.principalId],
          )
        : Promise.resolve({ rows: [], rowCount: 0 }),
      row.live_activity_id && (row.activity_conversation_id || row.activity_origin_hash)
        ? db.query<any>(
            `SELECT id,generation,state,title,status,context,created_at,updated_at,ended_at,terminal_reason,
              sealed IS NOT NULL AS encrypted
            FROM live_activities
            WHERE principal_id=$1 AND ${row.activity_conversation_id
              ? "conversation_id=$2"
              : "origin_hash=$2"}
            ORDER BY generation DESC,created_at DESC,id DESC
            LIMIT 50`,
            [account.principalId, row.activity_conversation_id ?? row.activity_origin_hash],
          )
        : Promise.resolve({ rows: [], rowCount: 0 }),
      row.live_activity_id
        ? db.query<any>(
            `SELECT lease.device_id,d.name AS device_name,lease.state,lease.reason,lease.relevance_score,
              lease.last_command_sequence,lease.selected_at,lease.last_applied_at,lease.ended_at
            FROM live_activity_presentation_leases lease
            JOIN devices d ON d.id=lease.device_id AND d.principal_id=lease.principal_id
            WHERE lease.live_activity_id=$1 AND lease.principal_id=$2
            ORDER BY lease.relevance_score DESC,lease.selected_at DESC,lease.device_id`,
            [row.live_activity_id, account.principalId],
          )
        : Promise.resolve({ rows: [], rowCount: 0 }),
      row.live_activity_id
        ? db.query<any>(
            `SELECT relationship.id,relationship.kind,relationship.actor,relationship.reason,
              relationship.provenance,relationship.created_at,
              predecessor.id AS predecessor_id,predecessor.title AS predecessor_title,
              predecessor.state AS predecessor_state,predecessor.generation AS predecessor_generation,
              predecessor.sealed IS NOT NULL AS predecessor_encrypted,successor.sealed IS NOT NULL AS successor_encrypted,
              successor.id AS successor_id,successor.title AS successor_title,
              successor.state AS successor_state,successor.generation AS successor_generation
            FROM activity_relationships relationship
            JOIN live_activities predecessor ON predecessor.id=relationship.predecessor_activity_id
              AND predecessor.principal_id=relationship.principal_id
            JOIN live_activities successor ON successor.id=relationship.successor_activity_id
              AND successor.principal_id=relationship.principal_id
            WHERE relationship.principal_id=$1
              AND (relationship.predecessor_activity_id=$2 OR relationship.successor_activity_id=$2)
            ORDER BY relationship.created_at,relationship.id`,
            [account.principalId, row.live_activity_id],
          )
        : Promise.resolve({ rows: [], rowCount: 0 }),
      row.live_activity_id
        ? db.query<any>(
            `SELECT id,outcome,matched_by,actor,reason,provenance,relationship_id,created_at
            FROM activity_correlation_decisions
            WHERE principal_id=$1 AND activity_id=$2
            ORDER BY created_at,id`,
            [account.principalId, row.live_activity_id],
          )
        : Promise.resolve({ rows: [], rowCount: 0 }),
      loadDeliveryEvidence(db,account.principalId,{
        notificationId: publicId("ntf",notificationId),limit: 100,
      }),
    ]);
    const safe = safeDestination(row.deep_link);
    const interaction = request.rows[0];
    const responseText = canonicalResponseText(interaction?.response);
    const notificationEncrypted = row.live_activity_id
      ? row.activity_encrypted === true
      : row.event_encrypted === true;
    const bootstrap: NotificationDetailBootstrap = {
      version: 1,
      kind: "notification-detail",
      route: {
        path: context.req.path,
        backHref: "/dashboard/inbox/notifications",
      },
      shell: shell({
        account,
        releaseIdentity,
        active: "inbox-notifications",
        title: String(row.title),
        description: `Persistent event ${publicId("ntf", row.id)}. Payloads, credentials, and idempotency keys are intentionally not displayed.`,
        counts,
      }),
      notification: {
        id: publicId("ntf", String(row.id)),
        encrypted: notificationEncrypted,
        source: String(row.source),
        serviceTitle:
          row.service_title == null ? null : String(row.service_title),
        kind: String(row.kind),
        title: String(row.title),
        body: contentCipher ? decryptedNotificationBody(contentCipher,row) : String(row.body ?? ""),
        bodyFormat: row.body_format === "markdown" ? "markdown" : "text",
        readAt: isoDate(row.read_at),
        withdrawnAt: isoDate(row.withdrawn_at),
        state:
          row.activity_state != null
            ? String(row.activity_state)
            : row.kind === "notification" && row.state === "active"
              ? "recorded"
              : String(row.state),
        privacy: String(row.privacy),
        targetMode: String(row.target_mode),
        createdAt: isoDate(row.created_at),
        updatedAt: isoDate(row.updated_at),
        expiresAt: isoDate(row.expires_at),
        destination: safe
          ? { state: "safe", href: safe }
          : { state: row.deep_link ? "unsafe" : "not-set", href: null },
      },
      activity: row.live_activity_id
        ? {
            ...activitySummary(row)!,
            stepItems: stepItems(row.activity_step_items, row.privacy === "private"),
            ...planTree(row.activity_plan_tree),
            threadHistory: threadHistory.rows.map((related) => ({
              id: publicId("act", String(related.id)),
              encrypted: related.encrypted === true,
              generation: Math.max(1, number(related.generation)),
              state: String(related.state ?? "unknown"),
              title: String(related.title ?? "Untitled activity"),
              status: String(related.status ?? "Unknown status"),
              taskTitle: activityContext(related.context).taskTitle,
              createdAt: isoDate(related.created_at),
              updatedAt: isoDate(related.updated_at),
              endedAt: isoDate(related.ended_at),
              terminalReason: optionalString(related.terminal_reason),
              current: String(related.id) === String(row.live_activity_id),
            })),
            timeline: operations.rows.map((operation) => {
              const snapshot = record(operation.activity_snapshot);
              return {
                operation: String(operation.operation),
                sequence: number(operation.resulting_sequence),
                state: optionalString(snapshot.state),
                status: optionalString(snapshot.status),
                createdAt: isoDate(operation.created_at),
              };
            }),
            presentationLeases: presentationLeases.rows.map((lease) => ({
              deviceId: publicId("dev", String(lease.device_id)),
              deviceName: String(lease.device_name ?? "Unnamed device"),
              state: String(lease.state ?? "unknown"),
              reason: String(lease.reason ?? "unknown"),
              relevanceScore: Number(lease.relevance_score ?? 0),
              lastCommandSequence: lease.last_command_sequence == null
                ? null : number(lease.last_command_sequence),
              selectedAt: isoDate(lease.selected_at),
              lastAppliedAt: isoDate(lease.last_applied_at),
              endedAt: isoDate(lease.ended_at),
            })),
            relationships: relationships.rows.map((relationship) => {
              const outgoing = String(relationship.predecessor_id) === String(row.live_activity_id);
              return {
                id: `rel_${String(relationship.id)}`,
                kind: String(relationship.kind),
                direction: outgoing ? "successor" as const : "predecessor" as const,
                relatedActivity: {
                  id: publicId("act", String(outgoing
                    ? relationship.successor_id
                    : relationship.predecessor_id)),
                  title: String(outgoing
                    ? relationship.successor_title
                    : relationship.predecessor_title),
                  encrypted: (outgoing
                    ? relationship.successor_encrypted
                    : relationship.predecessor_encrypted) === true,
                  state: String(outgoing
                    ? relationship.successor_state
                    : relationship.predecessor_state),
                  generation: Math.max(1, number(outgoing
                    ? relationship.successor_generation
                    : relationship.predecessor_generation)),
                },
                actor: String(relationship.actor),
                reason: String(relationship.reason),
                provenance: String(relationship.provenance),
                createdAt: isoDate(relationship.created_at),
              };
            }),
            correlationDecisions: correlationDecisions.rows.map((decision) => ({
              id: `cor_${String(decision.id)}`,
              outcome: String(decision.outcome),
              matchedBy: String(decision.matched_by),
              actor: String(decision.actor),
              reason: String(decision.reason),
              provenance: String(decision.provenance),
              relationshipId: decision.relationship_id
                ? `rel_${String(decision.relationship_id)}`
                : null,
              createdAt: isoDate(decision.created_at),
            })),
          }
        : null,
      interaction: interaction
        ? {
            kind: String(interaction.kind),
            // The prompt is a placeholder when the question or its card is sealed.
            encrypted: row.event_encrypted === true || row.activity_encrypted === true,
            state: String(interaction.state),
            action:
              interaction.response_action === "answer"
                ? "reply"
                : interaction.response_action == null
                  ? null
                  : String(interaction.response_action),
            prompt: String(interaction.prompt),
            responseText,
            // The question's id: a linked browser answers it (molecules/answer-controls.tsx).
            id: publicId("int", String(interaction.id)),
            // A phone (dev_…) or a linked browser (brw_…) that answered.
            respondingDevice: respondingDeviceResource(interaction),
            createdAt: isoDate(interaction.created_at),
            expiresAt: isoDate(interaction.expires_at),
            respondedAt: isoDate(interaction.responded_at),
          }
        : null,
      deliveries: deliveries.rows.map(deliverySummary),
      evidenceTimeline: evidenceTimeline.items,
      receipts: receipts.rows.map((receipt) => ({
        kind: String(receipt.kind),
        deviceName: String(receipt.device_name ?? "Unnamed device"),
        createdAt: isoDate(receipt.created_at),
      })),
    };
    return secureHtml(context, await renderDocument(await withNamesFrom(account.principalId, bootstrap),dashboardDocumentOptions(context)));
  };

  return { overview, history, delivery, detail };
}
