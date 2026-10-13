import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createAccountAuth } from "../account-auth.js";
import { createApp } from "../app.js";
import { hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createAuthDatabase,createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { createWebhookService } from "../services.js";
import { currentTestPresentation } from "../test-current-presentation.js";
import { pendingInteractionBadgeCount } from "../badge.js";
import { admitOrdinaryEvent } from "./ordinary-admission.js";
import type { SubjectCommand } from "./commands.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("Ordinary admission across authenticated adapters",()=>{
  let db:Database,authDb:Database,principalId:string,deviceId:string;
  let service:Awaited<ReturnType<typeof createWebhookService>>;
  const owner="adapter_owner_abcdefghijklmnopqrstuvwxyz";
  const phone="adapter_phone_abcdefghijklmnopqrstuvwxyz";
  const secret="adapter-relevance-test-secret-at-least-32-characters";
  const origin="http://127.0.0.1:8180";
  beforeAll(async()=>{db=createDatabase(process.env.TEST_DATABASE_URL!);authDb=createAuthDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);});
  afterAll(async()=>{await Promise.all([db.end(),authDb.end()]);});
  beforeEach(async()=>{
    await db.query("TRUNCATE owner_principals CASCADE");
    await db.query("TRUNCATE auth.sessions,auth.accounts,auth.verifications,auth.users CASCADE");
    await bootstrapOwner(db,"owner",owner);
    principalId=(await db.query("SELECT principal_id FROM principal_api_keys WHERE token_hash=$1",[hashToken(owner)])).rows[0].principal_id;
    deviceId=(await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token)
      VALUES ($1,$2,$3,'Adapter phone','com.example.relo.notifications','1','1','26','sandbox','authorized','authorized','fixture-token') RETURNING id`,
      [principalId,randomUUID(),randomUUID()])).rows[0].id;
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['interactions:respond','inbox:read'])",[deviceId,hashToken(phone)]);
    service=await createWebhookService(db,principalId,"Same visible name",origin);
  });
  const app=()=>createApp(db,{apnsMode:"sandbox",credentialDerivationSecret:secret});
  const path=()=>new URL(service.webhookUrl).pathname;
  const raw=(id:string)=>id.slice(4);
  const command=(kind:"notice"|"decision"="notice",generation=1,age=0):SubjectCommand=>({
    subjectKey:"same-visible-work",generation,revision:1,operation:"replace",
    occurredAt:new Date(Date.now()-age*1_000).toISOString(),
    policy:kind==="decision"?{kind,actionSeconds:30}:{kind},
  });
  async function post(body:unknown,key=randomUUID(),route=path()){
    const response=await app().request(route,{method:"POST",headers:{"content-type":"application/json","idempotency-key":key},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json() as any};
  }
  const notice=(relevance:unknown=command(),key=randomUUID(),route=path())=>post({body:"Still useful?",relevance},key,route);
  const ask=(relevance:unknown=command("decision"),key=randomUUID())=>post({body:"Ship this version?",response:{type:"yes_no",expiresInSeconds:30},relevance},key);
  async function answer(eventId:string,expectedSubject:unknown){
    const result=await app().request(`/api/notifications/${eventId}/interactions`,{method:"POST",headers:{authorization:`Bearer ${phone}`,"content-type":"application/json"},
      body:JSON.stringify({kind:"yes",idempotencyKey:randomUUID(),expectedSubject})});
    return {status:result.status,body:await result.json() as any};
  }
  async function state(eventId:string){
    return (await db.query(`SELECT e.state AS event_state,r.state,nr.relevance,nr.superseded_at
      FROM notification_events e JOIN notification_relevance nr ON nr.notification_event_id=e.id
      LEFT JOIN interaction_requests r ON r.notification_event_id=e.id WHERE e.id=$1`,[raw(eventId)])).rows[0];
  }
  test("webhook late arrivals and either replay key preserve deadlines; pruning cannot revive a version",async()=>{
    const relevance=command("notice",1,61),key=randomUUID();
    const first=await notice(relevance,key);
    expect(first.status).toBe(201);expect(first.body.queued).toBe(0);
    for(const replay of [await notice(relevance,key),await notice(relevance)]){
      expect(replay.status).toBe(200);expect(replay.body.eventId).toBe(first.body.eventId);
      expect(replay.body.relevance).toEqual(first.body.relevance);expect(replay.body.queued).toBe(0);
    }
    expect((await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n).toBe(1);
    await db.query("DELETE FROM notification_events WHERE id=$1",[raw(first.body.eventId)]);
    const retired=await notice(relevance,key);expect(retired.status).toBe(409);expect(retired.body.error).toBe("retired_replay");
  });
  test("service authority is isolated even for identical names and subject keys",async()=>{
    const old=await notice();
    const other=await createWebhookService(db,principalId,"Same visible name",origin);
    const independent=await notice(command(),randomUUID(),new URL(other.webhookUrl).pathname);
    const current=await notice(command("notice",2));
    expect(current.status).toBe(201);expect(independent.status).toBe(201);
    expect((await state(old.body.eventId)).relevance.supersededBy.generation).toBe(2);
    expect((await state(independent.body.eventId)).superseded_at).toBeNull();
    expect((await db.query("SELECT state FROM delivery_jobs WHERE notification_event_id=$1",[raw(old.body.eventId)])).rows[0].state).toBe("canceled");
    expect((await notice({...command(),accountId:"spoof",sourceId:`service:${other.row.id}`})).status).toBe(400);
    expect((await notice(command("decision"))).status).toBe(400);
    expect((await ask({...command("decision"),policy:{kind:"decision",actionSeconds:60}})).status).toBe(400);
  });
  test("webhook expired decisions are terminal on arrival and canonical status agrees",async()=>{
    const first=await ask(command("decision",1,31));
    expect(first.status).toBe(201);expect(first.body.response.status).toBe("expired");expect(first.body.queued).toBe(0);
    expect((await state(first.body.eventId)).state).toBe("expired");
    expect(await pendingInteractionBadgeCount(db,deviceId)).toBe(0);
    const status=await app().request(`${path()}/events/${first.body.eventId}`);
    expect(status.status).toBe(200);expect((await status.json() as any).event.response.status).toBe("expired");
  });
  test("replacement settles only its exact webhook decision and rejects the old phone action",async()=>{
    const old=await ask();const unrelated=await ask({...command("decision"),subjectKey:"independent"});
    const current=await ask(command("decision",2));
    expect((await state(old.body.eventId)).state).toBe("canceled");
    expect((await answer(old.body.eventId,old.body.relevance.identity)).body.error).toBe("interaction_superseded");
    expect((await answer(current.body.eventId,current.body.relevance.identity)).status).toBe(201);
    expect((await state(current.body.eventId)).state).toBe("yes");expect((await state(unrelated.body.eventId)).state).toBe("pending");
  });
  test("outbox failure rolls back the shared request, head and prior cancellations",async()=>{
    const old=await ask(),tx=await db.connect();
    try{
      await tx.query("BEGIN");
      const key=randomUUID();const event=(await tx.query(`INSERT INTO notification_events(principal_id,source,kind,title,body,idempotency_key)
        VALUES ($1,'Rollback','question','Rollback','Continue?',$2) RETURNING id,created_at`,[principalId,key])).rows[0];
      const next=await admitOrdinaryEvent(tx,{principalId,sourceId:`service:${service.row.id}`},{
        apnsMode:"disabled",kind:"decision",eventId:event.id,createdAt:event.created_at,idempotencyKey:key,intentHash:hashToken(key),relevance:command("decision",2),
        interaction:{kind:"yes_no",prompt:"Continue?",actionSeconds:30},
      });
      expect(next.kind).toBe("applied");
      await expect(tx.query("INSERT INTO delivery_jobs(notification_event_id,device_id) VALUES ($1,$2)",[event.id,randomUUID()])).rejects.toThrow();
    }finally{await tx.query("ROLLBACK");tx.release();}
    expect((await state(old.body.eventId)).state).toBe("pending");expect((await state(old.body.eventId)).superseded_at).toBeNull();
    expect((await db.query("SELECT generation,current_event_id FROM relevance_subjects")).rows[0]).toMatchObject({generation:"1",current_event_id:raw(old.body.eventId)});
    expect((await db.query("SELECT count(*)::int AS n FROM interaction_requests")).rows[0].n).toBe(1);
    expect((await db.query("SELECT state FROM delivery_jobs WHERE notification_event_id=$1",[raw(old.body.eventId)])).rows[0].state).toBe("pending");
  });
  test("Dashboard questions fold into the card, belong to it, and one waits at a time",async()=>{
    const application=createApp(db,{accountAuth:createAccountAuth(authDb,origin,secret),bootstrapOwnerHandle:"owner",credentialDerivationSecret:secret,appUrl:origin,apnsMode:"disabled"});
    const signup=await application.request("/api/auth/sign-up/email",{method:"POST",headers:{"content-type":"application/json",origin},
      body:JSON.stringify({name:"Owner",email:"owner@example.com",password:"unique-test-password"})});
    expect(signup.status).toBe(200);
    const signin=await application.request("/api/auth/sign-in/email",{method:"POST",headers:{"content-type":"application/json",origin},
      body:JSON.stringify({email:"owner@example.com",password:"unique-test-password",rememberMe:true})});
    expect(signin.status).toBe(200);
    const headers={authorization:`Bearer ${signin.headers.get("set-auth-token")}`,"content-type":"application/json",origin};
    const launched=await application.request("/api/dashboard/live-activities/test",{method:"POST",headers,
      body:JSON.stringify({deviceId:`dev_${deviceId}`,presentation:currentTestPresentation()})});
    expect(launched.status).toBe(201);const activityId=(await launched.json() as any).activity.id;
    const ask=()=>application.request(`/api/dashboard/live-activities/${activityId}/wait`,{method:"POST",headers,body:JSON.stringify({kind:"yes_no",prompt:"Continue?"})});
    const first=await ask();expect(first.status).toBe(200);const body=await first.json() as any;
    const record=await state(body.eventId);
    // A card's question belongs to the card, exactly as for an agent's question.
    expect(record.relevance.identity.sourceId).toBe(`native:${activityId.slice(4)}`);
    expect(record.relevance.deadlines.actionExpiresAt).toBe(body.interaction.expiresAt);
    expect(record.state).toBe("pending");
    const second=await ask();expect(second.status).toBe(409);expect((await second.json() as any).error).toBe("question_pending");
    const answered=await app().request(`/api/notifications/${body.eventId}/interactions`,{method:"POST",headers:{authorization:`Bearer ${phone}`,"content-type":"application/json"},
      body:JSON.stringify({kind:"yes",value:{},idempotencyKey:randomUUID(),expectedSubject:record.relevance.identity})});
    expect(answered.status).toBe(201);expect((await state(body.eventId)).state).toBe("yes");
  });
});
