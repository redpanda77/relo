import type { Handler } from "hono";
import { unclaimedLoginsVisible } from "../server-accounts.js";
import { decisionGroupRepresentative } from "../pending-inventory.js";
import type { Database } from "../db.js";
import { listAgentSessions } from "../agent-sessions.js";
import { loadDeliveryEvidence } from "../delivery-evidence.js";
import { allowedDeliveryReconciliationActions } from "../delivery-reconciliation.js";
import { internalId, publicId } from "../ids.js";
import {
  decryptedNotificationBody,
  type NotificationContentCipher,
} from "../notification-content.js";
import { accountOrRedirect,isoDate,pageNumber,secureHtml } from "./http.js";
import type { z } from "zod";
import { inboxDashboardBootstrapSchema,inboxOverviewSchema,notificationHistorySchema,deliveryHistorySchema,notificationDetailSchema,inboxShellSchema } from "@relo/notification-contracts/dashboard/inbox";

const pageSize = 25;
const notificationKinds = [
  "notification",
  "approval",
  "question",
  "live_activity",
] as const;
const notificationStates = [
  "active",
  "recorded",
  "ended",
  "responded",
  "expired",
  "replaced",
  "canceled",
] as const;

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
  steps?: { done: number; total: number; current: string | null } | null;
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
  renderDocument(bootstrap: InboxDashboardBootstrap): Promise<string>;
  reconcileActivities?(): Promise<number>;
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

function stepDigest(value: unknown): { done: number; total: number; current: string | null } | null {
  const steps = record(value);
  const total = number(steps.total);
  if (total <= 0) return null;
  return { done: number(steps.done), total, current: optionalString(steps.current) };
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
  };
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
    (SELECT CASE WHEN count(*)>0 THEN jsonb_build_object('done',count(*) FILTER (WHERE step->>'state'='complete'),
        'total',count(*),
        'current',CASE WHEN (e.payload->>'privacy'='private' OR e.payload#>>'{liveActivity,privacy}'='private') THEN NULL
          ELSE NULLIF(left((array_agg(step->>'label') FILTER (WHERE step->>'state'='current'))[1],80),'') END) END
      FROM jsonb_array_elements(COALESCE((SELECT component->'items' FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(a.presentation->'components')='array' THEN a.presentation->'components' ELSE '[]'::jsonb END) component
        WHERE component->>'type'='steps' AND jsonb_typeof(component->'items')='array' LIMIT 1),'[]'::jsonb)) step
    ) AS activity_steps`;

/** Whether an event carries end-to-end envelopes; only this boolean ever leaves the server. */
const eventEncryptedSql = (alias: string) => `(jsonb_typeof(${alias}.payload->'sealed')='object'
    OR jsonb_typeof(${alias}.payload#>'{liveActivity,sealed}')='object')`;

const activityJoinSql = `LEFT JOIN live_activities a
    ON a.principal_id=e.principal_id
   AND e.kind='live_activity'
   AND e.payload#>>'{liveActivity,activityId}'=('act_'||a.id::text)`;

const notificationStateSql = `CASE
    WHEN a.id IS NOT NULL THEN a.state::text
    WHEN e.kind='notification' AND e.state='active' THEN 'recorded'
    ELSE e.state::text
  END`;

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
    reconcileActivities,
    releaseIdentity,
    renderDocument,
    contentCipher,
  } = dependencies;

  const overview: Handler = async (context) => {
    const account = await accountOrRedirect(context, getAccount);
    if (account instanceof Response) return account;
    await reconcileActivities?.();
    const counts = await loadCounts(db, account.principalId);
    const requestedPage = pageNumber(context.req.query("page"));
    const approvalPages = pagination(
      "/dashboard",
      requestedPage,
      counts.approvals,
    );
    const [approvals, pendingResponses, notifications, running, sessions] = await Promise.all([
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
      listAgentSessions(db, account.principalId),
    ]);
    const bootstrap: InboxOverviewBootstrap = {
      version: 1,
      kind: "inbox-overview",
      route: { path: context.req.path, page: approvalPages.page },
      shell: shell({
        account,
        releaseIdentity,
        active: "inbox",
        title: "Inbox",
        description: `Account ${account.accountId}. Approvals and recent notification outcomes in one durable queue.`,
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
      recentNotifications: notifications.rows.map(notificationSummary),
      runningActivities: running.rows.map(notificationSummary),
      sessions,
    };
    return secureHtml(context, await renderDocument(bootstrap));
  };

  const history: Handler = async (context) => {
    const account = await accountOrRedirect(context, getAccount);
    if (account instanceof Response) return account;
    await reconcileActivities?.();
    const kind =
      notificationKinds.find((value) => value === context.req.query("kind")) ??
      null;
    const state =
      notificationStates.find(
        (value) => value === context.req.query("state"),
      ) ?? null;
    const projectOptions = await db.query<{ project: string }>(
      `SELECT DISTINCT ${notificationProjectSql} AS project
      FROM notification_events e
      ${activityJoinSql}
      WHERE e.principal_id=$1 AND ${notificationProjectSql} IS NOT NULL
      ORDER BY project LIMIT 200`,
      [account.principalId],
    );
    const projects = projectOptions.rows.map((row) => String(row.project));
    const requestedProject = optionalString(context.req.query("project"));
    const project =
      requestedProject && projects.includes(requestedProject)
        ? requestedProject
        : null;
    const counts = await loadCounts(db, account.principalId);
    const filtered = await db.query<{ total: number }>(
      `SELECT count(DISTINCT ${logicalNotificationKeySql})::int AS total FROM notification_events e
      ${activityJoinSql}
      WHERE e.principal_id=$1 AND ($2::text IS NULL OR e.kind::text=$2)
        AND ($3::text IS NULL OR (${notificationStateSql})=$3)
        AND ($4::text IS NULL OR ${notificationProjectSql}=$4)`,
      [account.principalId, kind, state, project],
    );
    const pages = pagination(
      "/dashboard/inbox/notifications",
      pageNumber(context.req.query("page")),
      filtered.rows[0]?.total,
      { kind, state, project },
    );
    const notifications = await db.query<any>(
      `SELECT * FROM (${notificationListSql}
      WHERE e.principal_id=$1 AND ($2::text IS NULL OR e.kind::text=$2)
        AND ($3::text IS NULL OR (${notificationStateSql})=$3)
        AND ($4::text IS NULL OR ${notificationProjectSql}=$4)) logical_notifications
      WHERE logical_rank=1
      ORDER BY created_at DESC,id DESC LIMIT $5 OFFSET $6`,
      [
        account.principalId,
        kind,
        state,
        project,
        pageSize,
        (pages.page - 1) * pageSize,
      ],
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
        filters: { kind, state, project },
      },
      filterOptions: { projects },
      shell: shell({
        account,
        releaseIdentity,
        active: "inbox-notifications",
        title: "Notifications",
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
      notifications: notifications.rows.map(notificationSummary),
      pagination: pages,
    };
    return secureHtml(context, await renderDocument(bootstrap));
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
    return secureHtml(context, await renderDocument(bootstrap));
  };

  const detail: Handler = async (context) => {
    const account = await accountOrRedirect(context, getAccount);
    if (account instanceof Response) return account;
    await reconcileActivities?.();
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
        `SELECT r.kind,r.prompt,r.state,r.response,r.expires_at,r.created_at,r.responded_at,
          winner.kind AS response_action,winner.device_id AS response_device_id,d.name AS response_device_name
        FROM interaction_requests r
        LEFT JOIN LATERAL (
          SELECT i.kind,i.device_id FROM interactions i
          WHERE i.interaction_request_id=r.id ORDER BY i.created_at,i.id LIMIT 1
        ) winner ON true LEFT JOIN devices d ON d.id=winner.device_id
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
            respondingDevice: interaction.response_device_id
              ? {
                  id: publicId("dev", String(interaction.response_device_id)),
                  name: String(
                    interaction.response_device_name ?? "Unnamed device",
                  ),
                }
              : null,
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
    return secureHtml(context, await renderDocument(bootstrap));
  };

  return { overview, history, delivery, detail };
}
