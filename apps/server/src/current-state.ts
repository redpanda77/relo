import { sealedForDevice } from "./sealed-content.js";
import type { ChoiceOption } from "@relo/notification-contracts";
import type { QuestionKind } from "./interactions/types.js";
import { z } from "zod";
import { currentSubjectIdSchema,type CurrentInboxResponse,type CurrentSubjectProjection,type RetiredSubject } from "@relo/notification-contracts";
import type { Database } from "./db.js";
import { decisionActivityJoin,pendingDecisionPredicate,type InboxActor } from "./pending-inventory.js";
import { actorCursorScope,decodeCursor,encodeCursor } from "./cursor.js";

export type CurrentCursor = { createdAt: string; subjectId: string };
const cursorSchema=z.tuple([z.literal("current-v1"),z.string(),z.iso.datetime(),currentSubjectIdSchema]);
export function decodeCurrentCursor(value: string,actor: InboxActor): CurrentCursor | null {
  const parsed=decodeCursor(value,cursorSchema);
  if(!parsed || parsed[1]!==actorCursorScope(actor))return null;
  return {createdAt:parsed[2],subjectId:parsed[3]};
}
function encodeCurrentCursor(cursor: CurrentCursor,actor: InboxActor): string {
  return encodeCursor(["current-v1",actorCursorScope(actor),cursor.createdAt,cursor.subjectId]);
}

const visibleEvent=`($2::uuid IS NULL OR e.target_mode='broadcast' OR EXISTS (
  SELECT 1 FROM notification_event_targets target WHERE target.notification_event_id=e.id AND target.device_id=$2))`;
const originalParentDeadline=`LEAST(activity.expires_at,CASE WHEN activity.lifecycle_provider IS NOT NULL THEN activity.stale_at END)`;
const retirement=`CASE
  WHEN e.withdrawn_at IS NOT NULL OR e.state='withdrawn' THEN 'withdrawn'
  WHEN nr.superseded_at IS NOT NULL THEN 'superseded'
  WHEN nr.relevance->>'status'='resolved' THEN 'resolved'
  WHEN nr.relevance->>'status'='settled' OR r.state IN ('approved','denied','yes','no','replied','canceled') THEN 'settled'
  WHEN r.state='expired' OR LEAST(e.expires_at,nr.action_expires_at,nr.relevant_until,r.expires_at)<=clock.at THEN 'expired'
  WHEN nr.relevance#>>'{deadlines,kind}'='decision' AND (${pendingDecisionPredicate("clock.at",visibleEvent)}) IS NOT TRUE THEN 'ended'
  WHEN e.state<>'active' THEN 'ended'
  ELSE NULL END`;

// Eligibility and aggregate metadata stay in one PostgreSQL statement/snapshot.
// Bodies and resource labels are projected only after the bounded page is chosen.
const candidatesSql=`WITH clock AS MATERIALIZED (SELECT statement_timestamp() AS at),
 actor AS MATERIALIZED (SELECT p.id FROM owner_principals p WHERE p.id=$1 AND p.disabled_at IS NULL
   AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM devices d WHERE d.id=$2 AND d.principal_id=p.id AND d.revoked_at IS NULL))),
 canonical AS (
   SELECT 'sub_'||subject.id::text AS subject_id,e.id AS event_id,activity.id AS activity_id,
     subject.created_at AS sort_at,nr.generation,nr.revision,nr.relevance#>>'{deadlines,kind}' AS kind,
     ${retirement} AS retired_reason,
     CASE WHEN nr.relevance#>>'{deadlines,kind}'='decision' THEN LEAST(r.expires_at,nr.action_expires_at,e.expires_at,${originalParentDeadline})
       ELSE LEAST(nr.relevant_until,e.expires_at) END AS current_until,
     nr.fresh_until,nr.deliver_until,
     (nr.relevance#>>'{deadlines,occurredAt}')::timestamptz AS occurred_at,
     (nr.relevance#>>'{deadlines,acceptedAt}')::timestamptz AS accepted_at,
     r.id AS interaction_id,r.kind::text AS interaction_kind,r.expires_at AS interaction_expiry,e.read_at
   FROM relevance_subjects subject JOIN notification_relevance nr ON nr.notification_event_id=subject.current_event_id
     AND nr.subject_id=subject.id AND nr.generation=subject.generation AND nr.revision=subject.revision
   JOIN notification_events e ON e.id=nr.notification_event_id AND e.principal_id=subject.principal_id
   LEFT JOIN interaction_requests r ON r.notification_event_id=e.id AND r.principal_id=e.principal_id
   ${decisionActivityJoin} CROSS JOIN clock CROSS JOIN actor
   WHERE subject.principal_id=$1 AND ${visibleEvent}
     AND ($3::text[] IS NOT NULL AND 'sub_'||subject.id::text=ANY($3) OR (${retirement}) IS NULL)
 ), native AS (
   SELECT 'act_'||a.id::text AS subject_id,event.id AS event_id,a.id AS activity_id,
     a.created_at AS sort_at,a.generation::bigint,a.sequence+1 AS revision,'progress'::text AS kind,
     CASE WHEN a.state='replaced' THEN 'superseded' WHEN a.state='ended' THEN 'ended'
       WHEN a.state='expired' OR LEAST(a.expires_at,CASE WHEN a.lifecycle_provider IS NOT NULL THEN a.stale_at END)<=clock.at
         THEN 'expired' ELSE NULL END AS retired_reason,
     LEAST(a.expires_at,CASE WHEN a.lifecycle_provider IS NOT NULL THEN a.stale_at END) AS current_until,
     NULL::timestamptz AS fresh_until,COALESCE(mutation.deliver_until,a.updated_at+interval '15 seconds') AS deliver_until,
     mutation.occurred_at,COALESCE(mutation.accepted_at,a.updated_at) AS accepted_at,
     NULL::uuid AS interaction_id,NULL::text AS interaction_kind,NULL::timestamptz AS interaction_expiry,event.read_at
   FROM live_activities a CROSS JOIN clock CROSS JOIN actor
   LEFT JOIN activity_mutation_freshness mutation ON mutation.activity_id=a.id AND mutation.sequence=a.sequence
   LEFT JOIN LATERAL (SELECT e.id,e.read_at FROM notification_events e
     WHERE e.principal_id=a.principal_id AND e.kind='live_activity'
       AND e.payload#>>'{liveActivity,activityId}'='act_'||a.id::text
       AND e.payload#>>'{liveActivity,generation}'=a.generation::text
       AND e.payload#>>'{liveActivity,sequence}'=a.sequence::text AND e.state='active' AND e.withdrawn_at IS NULL AND ${visibleEvent}
     ORDER BY e.created_at DESC,e.id DESC LIMIT 1) event ON true
   WHERE a.principal_id=$1 AND a.presentation#>>'{behavior,type}' IN ('progress','informational')
     AND ($2::uuid IS NULL OR $2::uuid=ANY(a.target_device_ids))
     AND ($3::text[] IS NOT NULL AND 'act_'||a.id::text=ANY($3) OR a.state='active')
 ), selected_candidates AS MATERIALIZED (
   SELECT * FROM canonical UNION ALL SELECT * FROM native
 )`;

// Targeted projection is separate from full-scope aggregates, so a hint never
// makes a truncated page appear to be the whole current inventory.
const querySql=`${candidatesSql}, whole_scope AS MATERIALIZED (
 SELECT * FROM selected_candidates WHERE retired_reason IS NULL
), metadata AS (
 SELECT count(*)::int AS total,count(*) FILTER(WHERE kind='decision')::int AS actionable,
   count(*) FILTER(WHERE read_at IS NULL)::int AS unread,
   min(LEAST(current_until,CASE WHEN fresh_until>(SELECT at FROM clock) THEN fresh_until END)) AS next_expiry
 FROM whole_scope
), page AS (
 SELECT * FROM selected_candidates WHERE
   ($3::text[] IS NOT NULL AND subject_id=ANY($3)) OR
   ($3::text[] IS NULL AND retired_reason IS NULL AND ($4::timestamptz IS NULL OR sort_at<$4 OR sort_at=$4 AND subject_id>$5))
 ORDER BY sort_at DESC,subject_id LIMIT $6
)
SELECT page.*,to_char(page.sort_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at_iso,
 metadata.total,metadata.actionable,metadata.unread,metadata.next_expiry,clock.at AS server_time,
 left(COALESCE(a.title,e.title),200) AS title,left(COALESCE(e.source,'Relo'),200) AS source,
 CASE WHEN e.payload->>'privacy'='private' OR e.payload#>>'{liveActivity,privacy}'='private' OR a.privacy='private' THEN 'Private notification'
   ELSE left(CASE WHEN page.kind='decision' THEN request_detail.prompt ELSE COALESCE(a.detail,content.summary,e.body,a.status,'') END,240) END AS summary,
 COALESCE(a.created_at,e.created_at) AS created_at,COALESCE(a.updated_at,e.updated_at) AS updated_at,
 CASE WHEN a.privacy='private' THEN NULL ELSE left(a.status,240) END AS activity_status,a.progress AS activity_progress,a.generation AS activity_generation,a.sequence AS activity_sequence,
 source.id AS source_id,source.kind AS source_kind,left(source.display_name,200) AS source_name,
 project.id AS project_id,left(project.display_name,200) AS project_name,project.is_direct AS project_direct,
 project.palette_ordinal,project.icon AS project_icon,project.revision AS project_revision,
 COALESCE(a.conversation_id,e.conversation_id) AS conversation_id,COALESCE(a.work_item_id,e.work_item_id) AS work_item_id,
 COALESCE(a.sealed,e.payload->'sealed') AS sealed,
 request_detail.options AS interaction_options
FROM metadata CROSS JOIN clock LEFT JOIN page ON true
LEFT JOIN notification_events e ON e.id=page.event_id
LEFT JOIN live_activities a ON a.id=page.activity_id
LEFT JOIN notification_contents content ON content.notification_event_id=e.id
LEFT JOIN interaction_requests request_detail ON request_detail.id=page.interaction_id
LEFT JOIN resource_sources source ON source.id=COALESCE(a.source_resource_id,e.source_resource_id)
LEFT JOIN resource_projects project ON project.id=COALESCE(a.project_resource_id,e.project_resource_id)
ORDER BY page.sort_at DESC,page.subject_id`;

type CurrentRow = {
 subject_id: string | null;event_id: string | null;activity_id: string | null;sort_at_iso: string;
 generation: string;revision: string;kind: CurrentSubjectProjection["kind"];retired_reason: RetiredSubject["reason"] | null;
 current_until: Date | null;fresh_until: Date | null;deliver_until: Date;occurred_at: Date | null;accepted_at: Date;
 interaction_id: string | null;interaction_kind: QuestionKind;interaction_expiry: Date;interaction_options: ChoiceOption[] | null;read_at: Date | null;
 total: number;actionable: number;unread: number;next_expiry: Date | null;server_time: Date;
 title: string;source: string;summary: string;created_at: Date;updated_at: Date;
 activity_status: string | null;activity_progress: number | null;activity_generation: number;activity_sequence: string;
 source_id: string | null;source_kind: string;source_name: string;project_id: string | null;project_name: string;
 project_direct: boolean;palette_ordinal: string;project_icon: string;project_revision: string;conversation_id: string | null;work_item_id: string | null;
 sealed: unknown;
};

function projection(row: CurrentRow & {subject_id:string},devicePublicId?: string): CurrentSubjectProjection {
 const palette=Number(row.palette_ordinal);
 // End-to-end sealed text for this phone; title, summary and status are placeholders (E3–E5).
 const sealed=sealedForDevice({ sealed: row.sealed },devicePublicId);
 return {
  ...(sealed?{sealed}:{}),
  subjectId:row.subject_id,notificationId:row.event_id?`ntf_${row.event_id}`:null,kind:row.kind,
  version:{generation:Number(row.generation),revision:Number(row.revision)},title:row.title,summary:row.summary,source:row.source,
  createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),occurredAt:row.occurred_at?.toISOString()??null,acceptedAt:row.accepted_at.toISOString(),readAt:row.read_at?.toISOString()??null,
  currentUntil:row.current_until?.toISOString()??null,freshUntil:row.fresh_until?.toISOString()??null,deliverUntil:row.deliver_until.toISOString(),
  freshness:row.fresh_until===null?"unknown":row.fresh_until<=row.server_time?"stale":"fresh",
  interaction:row.interaction_id?{id:`int_${row.interaction_id}`,type:row.interaction_kind,state:"pending",expiresAt:row.interaction_expiry.toISOString(),
    ...(row.interaction_kind==="choice"&&row.interaction_options?{options:row.interaction_options}:{})}:null,
  activity:row.activity_id?{id:`act_${row.activity_id}`,generation:row.activity_generation,sequence:Number(row.activity_sequence),status:row.activity_status,progress:row.activity_progress}:null,
  resources:row.source_id && row.project_id?{
    source:{id:`src_${row.source_id}`,kind:row.source_kind,name:row.source_name},
    project:{id:`prj_${row.project_id}`,name:row.project_name,isDirect:row.project_direct,palette:{slot:palette%12,generation:Math.floor(palette/12)},icon:row.project_icon,revision:Number(row.project_revision)},
    conversationId:row.conversation_id?`cnv_${row.conversation_id}`:null,workItemId:row.work_item_id?`wrk_${row.work_item_id}`:null,
  }:null,
 };
}

export async function loadCurrentState(db: Database,actor: InboxActor,input:{limit:number;ids?:string[];after?:CurrentCursor}):Promise<CurrentInboxResponse> {
 const result=await db.query<CurrentRow>(querySql,[actor.principalId,actor.deviceId??null,input.ids??null,input.after?.createdAt??null,input.after?.subjectId??null,input.ids?50:input.limit+1]);
 const metadata=result.rows[0]!;
 const candidates=result.rows.filter((row):row is CurrentRow & {subject_id:string}=>row.subject_id!==null);
 const hasMore=input.ids===undefined && candidates.length>input.limit;
 const rows=input.ids?candidates:candidates.slice(0,input.limit),last=rows.at(-1);
 const retired:RetiredSubject[]=rows.filter(row=>row.retired_reason!==null).map(row=>({subjectId:row.subject_id,reason:row.retired_reason!,version:{generation:Number(row.generation),revision:Number(row.revision)}}));
 if(input.ids){const found=new Set(rows.map(row=>row.subject_id));for(const id of input.ids)if(!found.has(id))retired.push({subjectId:id,reason:"not_found"});}
 return {items:rows.filter(row=>row.retired_reason===null).map(row=>projection(row,actor.deviceId?`dev_${actor.deviceId}`:undefined)),retired,total:metadata.total,
  counts:{actionable:metadata.actionable,currentUnread:metadata.unread},nextExpiryAt:metadata.next_expiry?.toISOString()??null,serverTime:metadata.server_time.toISOString(),hasMore,
  cursor:hasMore && last?encodeCurrentCursor({createdAt:last.sort_at_iso,subjectId:last.subject_id},actor):null};
}
