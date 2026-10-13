import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test,vi } from "vitest";
import { createApp } from "../app.js";
import { hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { currentTestPresentation } from "../test-current-presentation.js";
import { RUN_PHONE_EVIDENCE_SQL } from "../web/run-evidence.js";
const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("Activity wait canonical admission",()=>{
  let db:Database,principalId:string;
  const owner="wait_admission_owner_abcdefghijklmnopqrstuvwxyz",phone="wait_admission_phone_abcdefghijklmnopqrstuvwxyz";
  beforeAll(async()=>{db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);});
  afterAll(async()=>{await db.end();});
  beforeEach(async()=>{
    await db.query("TRUNCATE owner_principals CASCADE");await bootstrapOwner(db,"owner",owner);
    principalId=(await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    for(let i=0;i<2;i++){
      const device=(await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
        app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token,live_activity_push_to_start_token)
        VALUES ($1,$2,$3,'Wait phone','com.example.relo.notifications','1','1','26','sandbox','authorized','authorized','fixture-alert','fixture-start') RETURNING id`,
        [principalId,randomUUID(),randomUUID()])).rows[0].id;
      if(i===0)await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['interactions:respond'])",[device,hashToken(phone)]);
    }
  });
  async function post(path:string,body:unknown,key=randomUUID(),token=owner){
    const response=await createApp(db,{apnsMode:"sandbox",credentialDerivationSecret:"wait-admission-secret-at-least-32-characters"}).request(path,{
      method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json","idempotency-key":key},body:JSON.stringify(body),
    });return {status:response.status,body:await response.json() as any};
  }
  async function start(){
    const result=await post("/api/live-activities",{presentation:currentTestPresentation(),expiresInSeconds:60});
    expect(result.status).toBe(201);return result.body.activity;
  }
  const card=async(id:string)=>(await db.query("SELECT state,status,presentation,resume_presentation FROM live_activities WHERE id=$1",[id.slice(4)])).rows[0];
  test.each(["yes_no","approval"])("%s folds into the parent card, alerts, and settles the same answer on every phone",async type=>{
    const parent=await start(),key=randomUUID(),input={type,prompt:"Continue?",expiresInSeconds:300};
    const first=await post(`/api/live-activities/${parent.id}/wait`,input,key);expect(first.status).toBe(201);
    expect(first.body.companionActivityId).toBeNull();
    expect(first.body.interaction.expiresAt).toBe(parent.expiresAt);
    expect((await db.query("SELECT count(*)::int AS n FROM live_activities")).rows[0].n).toBe(1);
    const folded=await card(parent.id);
    expect(folded.status).toBe("Needs you");expect(folded.presentation.behavior.type).toBe(type);
    expect(folded.resume_presentation.content.status).toBe(parent.status);
    const commands=(await db.query(`SELECT e.payload FROM notification_events e JOIN interaction_requests r ON r.notification_event_id=e.id
      WHERE e.payload#>>'{liveActivity,activityId}'=$1`,[parent.id])).rows;
    expect(commands).toHaveLength(2);
    for(const command of commands){expect(command.payload.liveActivity.operation).toBe("update");expect(command.payload.liveActivity.alertOwner).toBe("apns");}
    const replay=await post(`/api/live-activities/${parent.id}/wait`,input,key);expect(replay.status).toBe(200);
    expect(replay.body.eventId).toBe(first.body.eventId);
    const others=(await db.query(`SELECT e.id FROM notification_events e JOIN interaction_requests r ON r.notification_event_id=e.id
      WHERE e.payload#>>'{liveActivity,activityId}'=$1 AND e.id<>$2`,[parent.id,first.body.eventId.slice(4)])).rows;
    const otherEvent=`ntf_${others[0].id}`;
    const otherRelevance=(await db.query("SELECT relevance FROM notification_relevance WHERE notification_event_id=$1",[others[0].id])).rows[0].relevance;
    const answer=await post(`/api/notifications/${otherEvent}/interactions`,{kind:type==="approval"?"approve":"yes",
      idempotencyKey:randomUUID(),expectedSubject:otherRelevance.identity},randomUUID(),phone);
    // The phone credential belongs to the first device; answering the second phone's copy is not allowed.
    if(answer.status!==201){
      const own=await post(`/api/notifications/${first.body.eventId}/interactions`,{kind:type==="approval"?"approve":"yes",
        idempotencyKey:randomUUID(),expectedSubject:first.body.relevance.identity},randomUUID(),phone);
      expect(own.status).toBe(201);
    }
    const states=(await db.query(`SELECT r.state FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id
      WHERE e.payload#>>'{liveActivity,activityId}'=$1`,[parent.id])).rows.map((row:any)=>row.state);
    expect(new Set(states)).toEqual(new Set([type==="approval"?"approved":"yes"]));
    const resumed=await card(parent.id);
    expect(resumed.state).toBe("active");expect(resumed.resume_presentation).toBeNull();
    expect(resumed.status).toBe(`${type==="approval"?"Approved":"Yes"} · ${parent.status}`);
  });
  test("database time governs admission despite a wrong process clock",async()=>{
    const parent=await start();vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2100-01-01"));
    try{
      const result=await post(`/api/live-activities/${parent.id}/wait`,{type:"yes_no",prompt:"Continue?"});
      expect(result.status).toBe(201);expect(result.body.relevance.deadlines.actionExpiresAt).toBe(parent.expiresAt);
    }finally{vi.useRealTimers();}
  });
  test("a longer parent never extends a shorter question, and exact acceptance survives replay",async()=>{
    const parent=await start(),key=randomUUID(),input={type:"yes_no",prompt:"Continue?",expiresInSeconds:30};
    const first=await post(`/api/live-activities/${parent.id}/wait`,input,key);expect(first.status).toBe(201);
    const deadlines=first.body.relevance.deadlines;
    expect(Date.parse(deadlines.actionExpiresAt)-Date.parse(deadlines.occurredAt)).toBe(30_000);
    expect(Date.parse(deadlines.actionExpiresAt)).toBeLessThan(Date.parse(parent.expiresAt));
    const own=(await db.query(`SELECT e.id,nr.relevance FROM notification_events e
      JOIN notification_event_targets t ON t.notification_event_id=e.id
      JOIN device_credentials c ON c.device_id=t.device_id AND c.token_hash=$2
      JOIN notification_relevance nr ON nr.notification_event_id=e.id
      WHERE e.payload#>>'{liveActivity,activityId}'=$1`,[parent.id,hashToken(phone)])).rows[0];
    const answer=await post(`/api/notifications/ntf_${own.id}/interactions`,{
      kind:"yes",idempotencyKey:randomUUID(),expectedSubject:own.relevance.identity,
    },randomUUID(),phone);expect(answer.status).toBe(201);expect(answer.body.decision.state).toBe("yes");
    const replay=await post(`/api/live-activities/${parent.id}/wait`,input,key);
    expect(replay.status).toBe(200);expect(replay.body.interaction.state).toBe("yes");
    expect(replay.body.relevance.deadlines).toEqual(deadlines);
  });
  test("one question at a time per card, updates land underneath it, and typed replies are refused",async()=>{
    const parent=await start();
    expect((await post(`/api/live-activities/${parent.id}/wait`,{type:"text",prompt:"Why?"})).status).toBe(400);
    const first=await post(`/api/live-activities/${parent.id}/wait`,{type:"approval",prompt:"First?"});expect(first.status).toBe(201);
    const second=await post(`/api/live-activities/${parent.id}/wait`,{type:"approval",prompt:"Second?"});
    expect(second.status).toBe(409);expect(second.body.error).toBe("question_pending");
    const update=await createApp(db,{apnsMode:"sandbox",credentialDerivationSecret:"wait-admission-secret-at-least-32-characters"})
      .request(`/api/live-activities/${parent.id}`,{method:"PATCH",headers:{authorization:`Bearer ${owner}`,
        "content-type":"application/json","idempotency-key":randomUUID()},body:JSON.stringify({status:"Still building"})});
    expect(update.status).toBe(200);
    const held=await card(parent.id);
    expect(held.status).toBe("Needs you");expect(held.resume_presentation.content.status).toBe("Still building");
    expect((await db.query("SELECT count(*)::int AS n FROM interaction_requests WHERE state='pending'")).rows[0].n).toBe(2);
  });
  test("an unanswered question ends the card, which leaves the phone at once",async()=>{
    const parent=await start();
    const asked=await post(`/api/live-activities/${parent.id}/wait`,{type:"yes_no",prompt:"Continue?",expiresInSeconds:30});
    expect(asked.status).toBe(201);
    await db.query("UPDATE interaction_requests SET expires_at=clock_timestamp()-interval '1 second'");
    const { expireDueInteractiveActivities }=await import("../interactive-activity-lifecycle.js");
    expect(await expireDueInteractiveActivities(db,"disabled")).toBeGreaterThan(0);
    const ended=await card(parent.id);
    expect(ended.state).toBe("expired");expect(ended.status).toBe("No answer");expect(ended.resume_presentation).toBeNull();
    expect(ended.presentation.behavior.type).not.toBe("yes_no");
    expect((await db.query("SELECT count(*)::int AS n FROM interaction_requests WHERE state='pending'")).rows[0].n).toBe(0);
    const end=(await db.query(`SELECT payload FROM notification_events
      WHERE payload#>>'{liveActivity,activityId}'=$1 AND payload#>>'{liveActivity,operation}'='end'`,[parent.id])).rows;
    expect(end).toHaveLength(1);expect(end[0].payload.liveActivity.dismissAfterSeconds).toBeLessThanOrEqual(5);
    expect(end[0].payload.liveActivity.interaction).toBeNull();
  });
  test("a question waits at most as long as the server allows",async()=>{
    await db.query("UPDATE server_settings SET max_question_seconds=3600");
    try {
      const parent=await start();
      const tooLong=await post(`/api/live-activities/${parent.id}/wait`,{type:"yes_no",prompt:"Continue?",expiresInSeconds:3601});
      expect(tooLong.status).toBe(400);
      expect((await post("/api/interactions",{type:"yes_no",prompt:"Continue?",expiresInSeconds:3601})).status).toBe(400);
    } finally { await db.query("UPDATE server_settings SET max_question_seconds=604800"); }
  });
  test("a start sent while a question waits succeeds and is shown after the answer",async()=>{
    const context={providerName:"Claude Code",project:"relo",threadName:"Release"};
    const first=await post("/api/live-activities",{key:"session-x",acquireMode:"ensure",title:"Release",status:"Building",context});
    expect(first.status).toBe(201);const id=first.body.activity.id;
    expect((await post(`/api/live-activities/${id}/wait`,{type:"yes_no",prompt:"Continue?"})).status).toBe(201);
    const again=await post("/api/live-activities",{key:"session-x",acquireMode:"ensure",title:"Release",status:"Testing",context});
    expect(again.status).toBe(200);expect(again.body.activity.id).toBe(id);expect(again.body.delivery.durableCommands).toBe(0);
    const held=await card(id);
    expect(held.status).toBe("Needs you");expect(held.resume_presentation.content.status).toBe("Testing");
  });
  test("a card that ask started for the question shows only the answer afterwards, named by its agent",async()=>{
    const context={providerName:"Claude Code",project:"relo",threadName:"Release"};
    const started=await post("/api/live-activities",{key:"session-y",acquireMode:"ensure",title:"Release",status:"Needs you",context});
    const id=started.body.activity.id;
    const asked=await post(`/api/live-activities/${id}/wait`,{type:"yes_no",prompt:"Continue?"});expect(asked.status).toBe(201);
    const sources=(await db.query("SELECT DISTINCT source FROM notification_events WHERE payload#>>'{liveActivity,activityId}'=$1",[id])).rows;
    expect(sources).toEqual([{source:"Claude Code"}]);
    const own=(await db.query(`SELECT e.id,nr.relevance FROM notification_events e
      JOIN notification_event_targets t ON t.notification_event_id=e.id
      JOIN device_credentials c ON c.device_id=t.device_id AND c.token_hash=$2
      JOIN notification_relevance nr ON nr.notification_event_id=e.id
      JOIN interaction_requests r ON r.notification_event_id=e.id
      WHERE e.payload#>>'{liveActivity,activityId}'=$1`,[id,hashToken(phone)])).rows[0];
    expect((await post(`/api/notifications/ntf_${own.id}/interactions`,{kind:"yes",idempotencyKey:randomUUID(),
      expectedSubject:own.relevance.identity},randomUUID(),phone)).status).toBe(201);
    const after=await card(id);expect(after.state).toBe("active");expect(after.status).toBe("Yes");
    // The dashboard's phone evidence: the answering phone counts as having received the card,
    // also after the card ends (Live Activity pushes never wake the app to confirm receipt).
    const evidence=async()=>(await db.query(`SELECT run_receipts.expected,run_receipts.confirmed
      FROM live_activities a ${RUN_PHONE_EVIDENCE_SQL} WHERE a.id=$1`,[id.slice(4)])).rows[0];
    expect(await evidence()).toEqual({expected:2,confirmed:1});
    expect((await post(`/api/live-activities/${id}/end`,{status:"Done"})).status).toBe(200);
    expect((await card(id)).state).toBe("ended");
    expect(await evidence()).toEqual({expected:2,confirmed:1});
  });
});
