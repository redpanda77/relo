import { inboxHistorySummarySchema,inboxSnapshotResponseSchema,safeContextSchema,type InboxSnapshotResponse } from "@relo/notification-contracts";
import type { Database } from "../db.js";
import type { InboxActor } from "../pending-inventory.js";
import { visibilityDeviceId } from "../owner-overview.js";

const contextFields = {
  providerName: 80,computer: 120,account: 40,project: 120,providerThreadId: 200,providerWorkItemId: 200,threadName: 160,taskTitle: 160,
} as const;
// Only known, bounded presentation metadata crosses the list boundary. The full
// payload, command, prompt, body and encrypted content are never selected.
const contextProjection = `jsonb_strip_nulls(jsonb_build_object(
  ${Object.entries(contextFields).map(([key,maximum]) => `'${key}',NULLIF(left(e.payload#>>'{context,${key}}',${maximum}),'')`).join(",")},
  'producerKind',CASE WHEN e.payload#>>'{context,producerKind}' IN ('agent','service','webhook','manual') THEN e.payload#>>'{context,producerKind}' END,
  'threadNameSource',CASE WHEN e.payload#>>'{context,threadNameSource}' IN ('provider','explicit','fallback') THEN e.payload#>>'{context,threadNameSource}' END,
  'taskTitleSource',CASE WHEN e.payload#>>'{context,taskTitleSource}' IN ('provider','prompt_summary','explicit','fallback') THEN e.payload#>>'{context,taskTitleSource}' END
))`;

/** One PostgreSQL statement means one visibility snapshot for rows and totals.
 * There is no timestamp high-water mark: the next repair sees every committed
 * row still inside the newest 250, including transactions that began earlier.
 */
export async function loadInboxSnapshot(db: Database, actor: InboxActor): Promise<InboxSnapshotResponse> {
  const result = await db.query<{
    items: unknown[]; total: number; unread: InboxSnapshotResponse["unread"];
    server_time: Date; latest_at: string | null; latest_id: string | null;
  }>(`WITH clock AS MATERIALIZED (SELECT statement_timestamp() AS at),
  visible AS MATERIALIZED (
    SELECT e.id,e.created_at,e.project_resource_id,e.read_at,e.withdrawn_at
    FROM notification_events e
    WHERE e.principal_id=$1
      AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM devices d WHERE d.id=$2 AND d.principal_id=$1 AND d.revoked_at IS NULL))
      -- $3: the device whose delivery targets bound the snapshot (owner-overview.ts); $2 the reader's own.
      AND ($3::uuid IS NULL OR e.target_mode='broadcast' OR EXISTS (
        SELECT 1 FROM notification_event_targets t WHERE t.notification_event_id=e.id AND t.device_id=$3))
  ), retained AS MATERIALIZED (
    SELECT id,created_at FROM visible ORDER BY created_at DESC,id DESC LIMIT 250
  ), unread AS (
    SELECT project_resource_id,count(*)::int AS count FROM visible
    WHERE read_at IS NULL AND withdrawn_at IS NULL GROUP BY project_resource_id
  ), summaries AS (
    SELECT e.created_at,e.id,jsonb_build_object(
      'id','ntf_'||e.id::text,'kind',CASE WHEN e.kind='live_activity' THEN 'live_activity' ELSE 'notification' END,
      'sourceName',left(e.source,200),'sourceImageUrl',e.image_url,'title',left(e.title,200),
      'contentSummary',jsonb_build_object(
        'summary',CASE WHEN (e.payload->>'privacy'='private' OR e.payload#>>'{liveActivity,privacy}'='private') THEN 'Private notification'
          ELSE left(COALESCE(content.summary,e.body,''),240) END,
        'format',COALESCE(content.body_format,'text'),'byteLength',COALESCE(content.body_bytes,octet_length(e.body),0)),
      'readAt',e.read_at,'withdrawnAt',e.withdrawn_at,'result',CASE WHEN e.state='responded' THEN 'responded' END,
      'deliveryState',CASE delivery.state WHEN 'pending' THEN 'queued' WHEN 'processing' THEN 'sending'
        WHEN 'accepted' THEN 'accepted_by_apns' WHEN 'retry' THEN 'retryable'
        WHEN 'permanently_failed' THEN 'rejected' WHEN 'canceled' THEN 'rejected'
        WHEN 'token_invalid' THEN 'token_invalid' WHEN 'reconciliation_required' THEN 'reconciliation_required' END,
      'apnsAcceptedAt',delivery.accepted_at,'receivedAt',receipts.received_at,'openedAt',receipts.opened_at,
      'createdAt',e.created_at,'updatedAt',e.updated_at,'destinationUrl',e.deep_link,
      'privacy',CASE WHEN (e.payload->>'privacy'='private' OR e.payload#>>'{liveActivity,privacy}'='private') THEN 'private' ELSE 'standard' END,
      'interaction',CASE WHEN request.id IS NOT NULL THEN jsonb_build_object(
        'id','int_'||request.id::text,'kind',request.kind,'state',request.state,
        'prompt',CASE WHEN (e.payload->>'privacy'='private' OR e.payload#>>'{liveActivity,privacy}'='private') THEN 'Private notification' ELSE left(request.prompt,240) END,
        'expiresAt',request.expires_at,'respondedAt',request.responded_at) END,
      'context',${contextProjection},
      'resources',CASE WHEN source.id IS NOT NULL AND project.id IS NOT NULL THEN jsonb_build_object(
        'source',jsonb_build_object('id','src_'||source.id::text,'kind',source.kind,'name',left(source.display_name,200)),
        'project',jsonb_build_object('id','prj_'||project.id::text,'name',left(project.display_name,200),
          'isDirect',project.is_direct,'palette',jsonb_build_object('slot',project.palette_ordinal%12,'generation',project.palette_ordinal/12),
          'icon',project.icon,'revision',project.revision),
        'conversationId',CASE WHEN e.conversation_id IS NOT NULL THEN 'cnv_'||e.conversation_id::text END,
        'workItemId',CASE WHEN e.work_item_id IS NOT NULL THEN 'wrk_'||e.work_item_id::text END) END,
      'activityEvent',CASE WHEN e.kind='live_activity' THEN jsonb_build_object(
        'id',e.payload#>>'{liveActivity,activityId}','operation',e.payload#>>'{liveActivity,operation}',
        'generation',e.payload#>'{liveActivity,generation}','sequence',e.payload#>'{liveActivity,sequence}') END,
      'activity',CASE WHEN activity.id IS NOT NULL THEN jsonb_build_object(
        'state',activity.state::text,
        'outcome',CASE WHEN activity.state<>'active' AND activity.presentation#>>'{state,kind}' IN ('completed','failed')
          THEN activity.presentation#>>'{state,kind}' END,
        'status',CASE WHEN private.is_private THEN NULL ELSE NULLIF(left(activity.status,160),'') END,
        'progress',CASE WHEN activity.progress BETWEEN 0 AND 1 THEN activity.progress END,
        'steps',CASE WHEN steps.total>0 THEN jsonb_build_object('done',steps.done,'total',steps.total,
          'current',CASE WHEN private.is_private THEN NULL ELSE NULLIF(left(steps.current,80),'') END,
          'currentIndex',steps.current_index,'fill',steps.fill) END,
        'updates',GREATEST(activity.sequence,0)+1,
        'plan',(SELECT jsonb_agg(jsonb_build_object('id',plan_step.step->>'id','state',plan_step.step->>'state',
            'label',CASE WHEN private.is_private OR work.sealed_text THEN NULL ELSE left(plan_step.step->>'label',120) END)
            || jsonb_strip_nulls(jsonb_build_object('parent',plan_step.step->'parent','round',plan_step.step->'round',
              'detail',CASE WHEN private.is_private OR work.sealed_text THEN NULL ELSE to_jsonb(left(plan_step.step->>'detail',200)) END))
            ORDER BY plan_step.position)
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(work.plan->'steps')='array' THEN work.plan->'steps' ELSE '[]'::jsonb END)
            WITH ORDINALITY plan_step(step,position)
          WHERE plan_step.step->>'state' IN ('open','current','done','skipped')),
        'rounds',CASE WHEN jsonb_typeof(work.plan->'rounds')='array' THEN (SELECT jsonb_agg(
            jsonb_strip_nulls(jsonb_build_object('n',r.round->'n','state',r.round->'state',
              'title',CASE WHEN private.is_private OR work.sealed_text THEN NULL ELSE to_jsonb(left(r.round->>'title',80)) END,
              'outcome',CASE WHEN private.is_private OR work.sealed_text THEN NULL ELSE to_jsonb(left(r.round->>'outcome',200)) END,
              'openedAt',r.round->'openedAt','closedAt',r.round->'closedAt')) ORDER BY r.position)
          FROM jsonb_array_elements(work.plan->'rounds') WITH ORDINALITY r(round,position)) END,
        'roundOutcome',CASE WHEN NOT (private.is_private OR work.sealed_text) AND work.lifecycle='open'
            AND jsonb_typeof(work.plan->'rounds')='array' AND work.plan->'rounds'->-1->>'state'='closed'
          THEN left(work.plan->'rounds'->-1->>'outcome',200) END,
        'startedAt',activity.created_at,'endedAt',activity.ended_at) END,
      -- End-to-end sealed text for this phone (its own alert envelope and the shared content).
      'sealed',CASE WHEN jsonb_typeof(COALESCE(e.payload->'sealed',activity.sealed)->'alerts')='array' THEN jsonb_build_object(
        'alert',(SELECT alert FROM jsonb_array_elements(COALESCE(e.payload->'sealed',activity.sealed)->'alerts') alert
          WHERE $2::uuid IS NOT NULL AND alert#>>'{recipients,0,device}'='dev_'||$2::text LIMIT 1),
        'content',COALESCE(e.payload->'sealed',activity.sealed)->'content') END,
      'relevance',CASE WHEN relevance.notification_event_id IS NOT NULL THEN jsonb_build_object(
        'subjectId','sub_'||relevance.subject_id::text,'generation',relevance.generation,'revision',relevance.revision,
        'status',relevance.relevance->>'status','supersededAt',relevance.superseded_at,
        'currentUntil',relevance.relevant_until,'actionExpiresAt',relevance.action_expires_at,
        'freshUntil',relevance.fresh_until,'deliverUntil',relevance.deliver_until) END
    ) AS item
    FROM retained JOIN notification_events e ON e.id=retained.id
    LEFT JOIN notification_contents content ON content.notification_event_id=e.id
    LEFT JOIN interaction_requests request ON request.notification_event_id=e.id AND request.principal_id=e.principal_id
    LEFT JOIN notification_relevance relevance ON relevance.notification_event_id=e.id
    CROSS JOIN LATERAL (SELECT (e.payload->>'privacy'='private' OR e.payload#>>'{liveActivity,privacy}'='private') AS is_private) private
    LEFT JOIN live_activities activity ON e.kind='live_activity' AND activity.principal_id=e.principal_id
      AND activity.id=CASE WHEN e.payload#>>'{liveActivity,activityId}' ~ '^act_[0-9a-f-]{36}$'
        THEN substring(e.payload#>>'{liveActivity,activityId}' from 5)::uuid END
    LEFT JOIN works work ON work.id=activity.work_id AND work.principal_id=activity.principal_id
    LEFT JOIN LATERAL (
      -- The card's plan wire carries the count (top-level steps of the round in play); a card from before it
      -- counts the shown steps instead (a long plan's card shows a window: before/after count the hidden ones).
      SELECT COALESCE(max(window_counts.wire_total),
          count(*)::int+COALESCE(max(window_counts.before),0)+COALESCE(max(window_counts.after),0)) AS total,
        COALESCE(max(window_counts.wire_done),
          count(*) FILTER (WHERE step->>'state'='complete')::int+COALESCE(max(window_counts.before),0)) AS done,
        COALESCE(max(window_counts.wire_label), (array_agg(step->>'label') FILTER (WHERE step->>'state'='current'))[1]) AS current,
        max(window_counts.wire_current) AS current_index,max(window_counts.wire_fill) AS fill
      FROM (SELECT component FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(activity.presentation->'components')='array' THEN activity.presentation->'components' ELSE '[]'::jsonb END) component
        WHERE component->>'type'='steps' AND jsonb_typeof(component->'items')='array' LIMIT 1) steps_component
      CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(steps_component.component->'before')='number'
          THEN (steps_component.component->>'before')::int END AS before,
        CASE WHEN jsonb_typeof(steps_component.component->'after')='number'
          THEN (steps_component.component->>'after')::int END AS after,
        CASE WHEN jsonb_typeof(steps_component.component->'plan'->'total')='number' AND jsonb_typeof(steps_component.component->'plan'->'done')='number'
          THEN (steps_component.component->'plan'->>'total')::int END AS wire_total,
        CASE WHEN jsonb_typeof(steps_component.component->'plan'->'total')='number' AND jsonb_typeof(steps_component.component->'plan'->'done')='number'
          THEN (steps_component.component->'plan'->>'done')::int END AS wire_done,
        CASE WHEN jsonb_typeof(steps_component.component->'plan'->'stepLabel')='string'
          THEN steps_component.component->'plan'->>'stepLabel' END AS wire_label,
        CASE WHEN jsonb_typeof(steps_component.component->'plan'->'current')='number'
          THEN (steps_component.component->'plan'->>'current')::int END AS wire_current,
        CASE WHEN jsonb_typeof(steps_component.component->'plan'->'fill')='number'
          THEN (steps_component.component->'plan'->>'fill')::float8 END AS wire_fill) window_counts
      CROSS JOIN LATERAL jsonb_array_elements(steps_component.component->'items') step
    ) steps ON true
    LEFT JOIN resource_sources source ON source.id=e.source_resource_id AND source.principal_id=e.principal_id
    LEFT JOIN resource_projects project ON project.id=e.project_resource_id AND project.principal_id=e.principal_id
    LEFT JOIN LATERAL (
      SELECT CASE WHEN j.provider_outcome_category='invalid-recipient' THEN 'token_invalid' ELSE j.state END AS state,j.accepted_at
      FROM delivery_jobs j WHERE j.notification_event_id=e.id AND ($2::uuid IS NULL OR j.device_id=$2)
      ORDER BY j.updated_at DESC,j.id DESC LIMIT 1
    ) delivery ON true
    LEFT JOIN LATERAL (
      SELECT max(i.created_at) FILTER (WHERE i.kind='received') AS received_at,
             max(i.created_at) FILTER (WHERE i.kind='opened') AS opened_at
      FROM interactions i WHERE i.notification_event_id=e.id AND ($2::uuid IS NULL OR i.device_id=$2)
    ) receipts ON true
  ) SELECT COALESCE((SELECT jsonb_agg(item ORDER BY created_at DESC,id DESC) FROM summaries),'[]'::jsonb) AS items,
    (SELECT count(*)::int FROM visible) AS total,
    jsonb_build_object('account',COALESCE((SELECT sum(count)::int FROM unread),0),
      'projects',COALESCE((SELECT jsonb_object_agg(COALESCE('prj_'||project_resource_id::text,'direct'),count) FROM unread),'{}'::jsonb)) AS unread,
    clock.at AS server_time,
    (SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM retained ORDER BY created_at DESC,id DESC LIMIT 1) AS latest_at,
    (SELECT id FROM retained ORDER BY created_at DESC,id DESC LIMIT 1) AS latest_id
  FROM clock`, [actor.principalId,actor.deviceId ?? null,visibilityDeviceId(actor) ?? null]);
  const row = result.rows[0]!;
  const items = row.items.map(raw => {
    const value = raw as Record<string,unknown>;
    // Imported/pre-contract history may lack a complete native event identity.
    // Preserve the event, never manufacture a command from incomplete evidence.
    if (!inboxHistorySummarySchema.shape.activityEvent.safeParse(value.activityEvent).success) value.activityEvent = null;
    const context = safeContextSchema.safeParse(value.context);
    value.context = context.success ? context.data : null;
    if (!inboxHistorySummarySchema.shape.destinationUrl.safeParse(value.destinationUrl).success) value.destinationUrl = null;
    return value;
  }).filter(value => {
    // One unreadable row must never fail the whole snapshot: the phone would keep an old History
    // and session list (and their long-ended cards) until someone noticed.
    const parsed = inboxHistorySummarySchema.safeParse(value);
    if (!parsed.success) console.warn("inbox snapshot: skipped an unreadable item", value.id, parsed.error.issues.map(issue => issue.path.join(".")).join(","));
    return parsed.success;
  });
  return inboxSnapshotResponseSchema.parse({items,total:row.total,unread:row.unread,serverTime:row.server_time.toISOString(),
    readWatermark:row.latest_at && row.latest_id ? Buffer.from(JSON.stringify([row.latest_at,row.latest_id])).toString("base64url") : null});
}
