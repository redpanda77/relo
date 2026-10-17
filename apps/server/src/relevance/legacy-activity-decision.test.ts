import { expireDueInteractiveActivities } from "../interactive-activity-lifecycle.js";
import { currentTestPresentation } from "../test-current-presentation.js";
import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("Legacy activity decision boundaries",()=>{
  let db:Database,principalId:string,deviceId:string;
  const owner="activity_admission_owner_abcdefghijklmnopqrstuvwxyz",phone="activity_admission_phone_abcdefghijklmnopqrstuvwxyz";
  beforeAll(async()=>{db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);});
  afterAll(async()=>{await db.end();});
  beforeEach(async()=>{
    await db.query("TRUNCATE owner_principals CASCADE");await bootstrapOwner(db,"owner",owner);
    principalId=(await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    deviceId=(await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,live_activity_push_to_start_token)
      VALUES ($1,$2,$3,'Decision phone','com.example.relo.notifications','1','1','26','sandbox','authorized','authorized','fixture-token') RETURNING id`,
      [principalId,randomUUID(),randomUUID()])).rows[0].id;
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['interactions:respond'])",[deviceId,hashToken(phone)]);
  });
  async function request(path:string,token:string,body:unknown,key=randomUUID()){
    const response=await createApp(db,{apnsMode:"sandbox",credentialDerivationSecret:"activity-admission-secret-at-least-32-characters"}).request(path,{
      method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json","idempotency-key":key},body:JSON.stringify(body),
    });return {status:response.status,body:await response.json() as any};
  }
  const interactive=()=>({...currentTestPresentation(),behavior:{type:"yes_no",primary:{action:"yes",label:"Yes"},secondary:{action:"no",label:"No"}}});
  test.each([{terminal:"response",fenced:false},{terminal:"cancel",fenced:false},{terminal:"expiry",fenced:false},{terminal:"response",fenced:true}])("$terminal retires legacy prompts (provider attempt fenced: $fenced)",async({terminal,fenced})=>{
    const secondToken="legacy_activity_second_abcdefghijklmnopqrstuvwxyz";
    const second=(await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,live_activity_push_to_start_token)
      VALUES ($1,$2,$3,'Second phone','com.example.relo.notifications','1','1','26','sandbox','authorized','authorized','fixture-token') RETURNING id`,
      [principalId,randomUUID(),randomUUID()])).rows[0].id;
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['interactions:respond'])",[second,hashToken(secondToken)]);
    const start=await request("/api/live-activities",owner,{presentation:interactive()});expect(start.status).toBe(201);
    // Explicit composable presentations used the old per-device request format.
    const events=(await db.query(`SELECT e.id,t.device_id,r.id AS request_id FROM notification_events e
      JOIN notification_event_targets t ON t.notification_event_id=e.id
      JOIN interaction_requests r ON r.notification_event_id=e.id
      WHERE e.payload#>>'{liveActivity,activityId}'=$1`,[start.body.activity.id])).rows;
    expect(events).toHaveLength(2);
    const first=events.find(row=>row.device_id===deviceId),other=events.find(row=>row.device_id===second);
    if(fenced)await db.query(`UPDATE delivery_jobs SET state='processing',claim_phase='dispatch_started',claim_token=$2,
      apns_payload_sha256=$3 WHERE notification_event_id=$1`,[other.id,randomUUID(),"a".repeat(64)]);
    if(terminal==="response")expect((await request(`/api/notifications/ntf_${first.id}/interactions`,phone,{kind:"yes",idempotencyKey:randomUUID()})).status).toBe(201);
    else if(terminal==="cancel")expect((await request(`/api/interactions/int_${first.request_id}/cancel`,owner,{})).status).toBe(200);
    else {
      await db.query("UPDATE interaction_requests SET expires_at='2000-01-01'");
      expect(await expireDueInteractiveActivities(db,"sandbox")).toBe(1);
      // Every phone's copy expires with the question, whichever copy the expiry pass reached first.
      expect((await db.query("SELECT state FROM interaction_requests")).rows.map((row)=>row.state)).toEqual(["expired","expired"]);
    }
    expect((await request(`/api/notifications/ntf_${other.id}/interactions`,secondToken,{kind:"no",idempotencyKey:randomUUID()})).status).toBe(terminal==="expiry"?200:409);
    // After expiry a late answer is stored as a fact on the expired request (never permission), so it is accepted.
    if(terminal!=="expiry")expect((await db.query("SELECT count(*)::int AS n FROM interactions")).rows[0].n).toBe(terminal==="response"?1:0);
    if(terminal==="expiry")expect((await db.query("SELECT count(*)::int AS n FROM interaction_requests WHERE late_response IS NOT NULL")).rows[0].n).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM interaction_requests WHERE state='pending'")).rows[0].n).toBe(0);
    const job=(await db.query("SELECT state,claim_phase,apns_payload_sha256 FROM delivery_jobs WHERE notification_event_id=$1",[other.id])).rows[0];
    expect(job.state).toBe(fenced?"processing":"canceled");
    if(fenced)expect(job).toMatchObject({claim_phase:"dispatch_started",apns_payload_sha256:"a".repeat(64)});
  });
  test("producer end of the card leaves its question open (questions and cards are decoupled)",async()=>{
    const decision=await request("/api/interactions",owner,{title:"Review",prompt:"Continue?",type:"yes_no",presentation:"live_activity"});
    expect(decision.status).toBe(201);
    expect((await request(`/api/live-activities/${decision.body.liveActivityId}/end`,owner,{})).status).toBe(200);
    expect((await db.query("SELECT relevance->>'status' AS status FROM notification_relevance WHERE notification_event_id=$1",[decision.body.eventId.slice(4)])).rows[0].status).toBe("active");
    expect((await db.query("SELECT count(*)::int AS n FROM interaction_requests WHERE state='pending'")).rows[0].n).toBe(1);
  });

});
