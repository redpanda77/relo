import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { currentSubjectIdSchema, type Scope } from "@relo/notification-contracts";

const INBOX_READ: Scope = "inbox:read";
import type { AuthIdentity } from "./auth.js";
import type { Database } from "./db.js";
import type { CurrentChangeHub } from "./current-change-hub.js";
import { visibilityDeviceId } from "./owner-overview.js";

export async function currentStreamAuthorized(db:Database,actor:AuthIdentity):Promise<boolean>{
  const result=await db.query<{allowed:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM owner_principals p WHERE p.id=$1 AND p.disabled_at IS NULL AND (
      $2::uuid IS NULL AND EXISTS(SELECT 1 FROM principal_api_keys k WHERE k.id=$3 AND k.principal_id=p.id
        AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp()) AND $5::text=ANY(k.scopes))
      OR $2::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM devices d JOIN device_credentials c ON c.device_id=d.id
        WHERE d.id=$2 AND d.principal_id=p.id AND d.revoked_at IS NULL AND d.credential_version=$4
        AND c.id=$3 AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp())
        AND $5::text=ANY(c.scopes)))) AS allowed`,
  [actor.principalId,actor.deviceId??null,actor.deviceCredentialId??actor.credentialId??null,actor.deviceCredentialVersion??null,INBOX_READ]);
  return result.rows[0]?.allowed===true;
}

/** Translate event hints after commit, when admission has attached canonical identity.
 * $2 is the device whose delivery targets bound the hints: none for an overview device (owner-overview.ts).
 * A formerly visible version can invalidate its known pointer after retargeting.
 * No subject identity is sent solely because it belongs to the same account.
 */
export async function visibleCurrentHintIds(db:Database,actor:AuthIdentity,ids:string[]):Promise<string[]>{
  const visible=`($2::uuid IS NULL OR e.target_mode='broadcast' OR EXISTS(SELECT 1 FROM notification_event_targets t WHERE t.notification_event_id=e.id AND t.device_id=$2))`;
  const result=await db.query<{id:string}>(`SELECT DISTINCT id FROM (
    SELECT CASE WHEN nr.subject_id IS NOT NULL THEN 'sub_'||nr.subject_id::text
      WHEN e.kind='live_activity' THEN e.payload#>>'{liveActivity,activityId}' ELSE 'ntf_'||e.id::text END AS id
    FROM notification_events e LEFT JOIN notification_relevance nr ON nr.notification_event_id=e.id
    WHERE e.principal_id=$1 AND e.id=ANY($3::uuid[]) AND ${visible}
    UNION ALL SELECT 'sub_'||nr.subject_id::text FROM notification_relevance nr
    JOIN notification_events e ON e.id=nr.notification_event_id
    WHERE e.principal_id=$1 AND nr.subject_id=ANY($4::uuid[]) AND ${visible}
    UNION ALL SELECT 'act_'||a.id::text FROM live_activities a
    WHERE a.principal_id=$1 AND a.id=ANY($5::uuid[]) AND ($2::uuid IS NULL OR $2::uuid=ANY(a.target_device_ids))
  ) visible_ids WHERE id IS NOT NULL LIMIT 51`,[actor.principalId,visibilityDeviceId(actor)??null,
    ...["ntf_","sub_","act_"].map(prefix=>ids.filter(id=>id.startsWith(prefix)&&currentSubjectIdSchema.safeParse(id).success).map(id=>id.slice(4)))]);
  return result.rows.map(row=>row.id).filter(id=>currentSubjectIdSchema.safeParse(id).success);
}

/** How long a wake waits for the changes that follow it, so near-simultaneous writes make one frame. */
const COALESCE_MS=250;

export function currentStateStream(context:Context,db:Database,hub:CurrentChangeHub|undefined,
  timing:{keepaliveMs:number;reconcileMs:number;writeTimeoutMs:number;coalesceMs?:number}={keepaliveMs:15_000,reconcileMs:60_000,writeTimeoutMs:30_000}):Response {
  const actor=context.get("auth"),credential=actor.deviceCredentialId??actor.credentialId;
  if(!hub)return context.json({error:"current_stream_unavailable"},503);
  if(!credential)return context.json({error:"unauthorized"},401);
  const subscription=hub.subscribe(actor.principalId,`${actor.credentialKind}:${credential}`);
  if(!subscription)return context.json({error:"too_many_streams"},429);
  context.header("X-Accel-Buffering","no");
  const response=streamSSE(context,async stream=>{
    const abort=new AbortController();
    const stop=()=>{abort.abort();subscription.close();stream.abort();};
    stream.onAbort(()=>{abort.abort();subscription.close();});
    context.req.raw.signal.addEventListener("abort",stop,{once:true});
    if(context.req.raw.signal.aborted)stop();
    let lastReconcile=performance.now();
    const write=async (value:string)=>{
      const timer=setTimeout(stop,timing.writeTimeoutMs);
      try{await stream.write(value);}finally{clearTimeout(timer);}
    };
    try{
      while(!abort.signal.aborted){
        const expiry=actor.expiresAt?Math.max(0,actor.expiresAt.getTime()-Date.now()):timing.keepaliveMs;
        const wake=await subscription.wait(Math.min(timing.keepaliveMs,expiry),abort.signal);
        if(wake==="aborted" || abort.signal.aborted)break;
        // An extended credential can be picked up on reconnect. Keeping this
        // original session deadline prevents a zero-delay loop at old expiry.
        if(actor.expiresAt && actor.expiresAt.getTime()<=Date.now())break;
        if(!await currentStreamAuthorized(db,actor))break;
        if(abort.signal.aborted)break;
        const reconcile=performance.now()-lastReconcile>=timing.reconcileMs;
        if(wake==="timeout" && !reconcile){await write(": keepalive\n\n");continue;}
        // A hook phase change and a card write land moments apart: wait briefly so one frame carries both.
        const settle=timing.coalesceMs??COALESCE_MS;
        if(wake!=="timeout" && settle>0){
          await new Promise<void>(resolve=>{
            const timer=setTimeout(done,settle);
            function done(){clearTimeout(timer);abort.signal.removeEventListener("abort",done);resolve();}
            abort.signal.addEventListener("abort",done,{once:true});
          });
          if(abort.signal.aborted)break;
        }
        const pending=subscription.take();
        const ids=reconcile || !pending.subjectIds.length?[]:await visibleCurrentHintIds(db,actor,pending.subjectIds);
        if(abort.signal.aborted)break;
        if(!reconcile && pending.subjectIds.length && !ids.length)continue;
        const subjectIds=ids.length>50?[]:ids;
        if(!subjectIds.length)lastReconcile=performance.now();
        await write(`event: current\ndata: ${JSON.stringify({subjectIds,invalidateCounts:true})}\n\n`);
      }
    }catch{
      // No payload/credential errors on the wire. Closing forces a fresh authorized read.
      stream.abort();
    }finally{
      context.req.raw.signal.removeEventListener("abort",stop);subscription.close();
    }
  });
  response.headers.set("Cache-Control","no-store");
  return response;
}
