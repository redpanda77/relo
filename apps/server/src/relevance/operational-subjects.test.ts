import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { createWebhookService } from "../webhooks/admin.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("Operational subject admission",()=>{
  let db:Database,principalId:string,serviceSecret:string;
  const owner="operational_owner_abcdefghijklmnopqrstuvwxyz";
  const phone="operational_phone_abcdefghijklmnopqrstuvwxyz";
  beforeAll(async()=>{db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);});
  afterAll(async()=>{await db.end();});
  beforeEach(async()=>{
    await db.query("TRUNCATE owner_principals CASCADE");await bootstrapOwner(db,"owner",owner);
    principalId=(await db.query("SELECT principal_id FROM principal_api_keys WHERE token_hash=$1",[hashToken(owner)])).rows[0].principal_id;
    const device=(await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token)
      VALUES ($1,$2,$3,'Operational fixture','com.example.fixture','1','1','27','sandbox','authorized','authorized','fixture-token') RETURNING id`,
      [principalId,randomUUID(),randomUUID()])).rows[0];
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['inbox:read'])",[device.id,hashToken(phone)]);
    serviceSecret=(await createWebhookService(db,principalId,"Operational fixture","http://127.0.0.1:8180")).secret;
  });
  const app=()=>createApp(db,{apnsMode:"sandbox",credentialDerivationSecret:"operational-fixture-secret-at-least-32-characters"});
  const command=(policy:unknown,revision=1,more:Record<string,unknown>={})=>({subjectKey:"operational-work",generation:1,revision,
    operation:revision===1?"replace":"update",occurredAt:new Date().toISOString(),policy,...more});
  async function send(adapter:string,relevance:unknown,key=randomUUID()){
    const response=await app().request(adapter==="api"?"/api/notifications":"/hooks",{method:"POST",
      headers:{"content-type":"application/json","idempotency-key":key,authorization:`Bearer ${adapter==="api"?owner:serviceSecret}`},
      body:JSON.stringify({body:"Operational state",...(adapter==="api"?{title:"Operational state",sourceName:"Fixture"}:{}),relevance})});
    return {status:response.status,body:await response.json() as any};
  }
  async function current(){const response=await app().request("/api/inbox/current",{headers:{authorization:`Bearer ${phone}`}});expect(response.status).toBe(200);return await response.json() as any;}
  test.each(["api","service"])("%s progress is current and silent; late revisions cannot replace it",async adapter=>{
    const first=await send(adapter,command({kind:"progress"}));expect(first.status).toBe(201);expect(first.body.queued).toBe(0);
    expect((await current()).items).toHaveLength(1);expect((await current()).items[0].kind).toBe("progress");
    const latest=await send(adapter,command({kind:"progress"},3));expect(latest.status).toBe(201);expect(latest.body.queued).toBe(0);
    const stale=await send(adapter,command({kind:"progress"},2));expect(stale.status).toBe(409);
    expect((await current()).items[0].version.revision).toBe(3);
    expect((await db.query("SELECT count(*)::int AS n FROM delivery_jobs")).rows[0].n).toBe(0);
  });
  test.each(["api","service"])("%s incident resolution retires current work and fences reopening after history pruning",async adapter=>{
    const active=await send(adapter,command({kind:"incident",mode:"until_resolved"}));expect(active.status).toBe(201);expect(active.body.queued).toBe(1);
    const recovery=command({kind:"incident",mode:"until_resolved"},2,{status:"resolved"});
    const key=randomUUID(),resolved=await send(adapter,recovery,key);expect(resolved.status).toBe(201);expect(resolved.body.queued).toBe(0);
    expect(resolved.body.relevance.status).toBe("resolved");expect((await current()).items).toHaveLength(0);
    expect((await db.query("SELECT state FROM delivery_jobs WHERE notification_event_id=$1",[active.body.eventId.slice(4)])).rows[0].state).toBe("canceled");
    const replay=await send(adapter,recovery,key);expect(replay.status).toBe(200);expect(replay.body.relevance).toEqual(resolved.body.relevance);
    await db.query("DELETE FROM notification_events WHERE id=$1",[resolved.body.eventId.slice(4)]);
    expect((await send(adapter,recovery,key)).status).toBe(409);
    const reopened=await send(adapter,command({kind:"incident",mode:"until_resolved"},3));expect(reopened.status).toBe(409);expect(reopened.body.error).toBe("requires_replace");
    const next=await send(adapter,command({kind:"incident",mode:"until_resolved"},1,{generation:2}));expect(next.status).toBe(201);
    expect((await current()).items).toHaveLength(1);
  });
  test.each(["api","service"])("%s expired incident leases remain historical and invalid lifecycle authority is rejected",async adapter=>{
    const expired=await send(adapter,command({kind:"incident",mode:"lease",leaseUntil:new Date(Date.now()-1_000).toISOString()}));
    expect(expired.status).toBe(201);expect(expired.body.queued).toBe(0);expect((await current()).items).toHaveLength(0);
    expect((await send(adapter,command({kind:"notice"},2,{status:"resolved"}))).status).toBe(400);
    expect((await send(adapter,command({kind:"progress"},2,{status:"settled"}))).status).toBe(400);
    expect((await send(adapter,command({kind:"decision"},2))).status).toBe(400);
  });
  test("retention preserves current progress and unresolved incidents, then releases resolved history",async()=>{
    const progress=await send("api",command({kind:"progress"}));
    const incident=await send("api",command({kind:"incident",mode:"until_resolved"},1,{subjectKey:"incident"}));
    expect(progress.status).toBe(201);expect(incident.status).toBe(201);
    await db.query("UPDATE delivery_jobs SET state='canceled'");
    const prune=()=>db.query("SELECT * FROM run_notification_retention(now(),1,500,interval '90 days','operational-test')");
    await prune();expect((await current()).items).toHaveLength(2);
    const resolved=await send("api",command({kind:"incident",mode:"until_resolved"},2,{subjectKey:"incident",status:"resolved"}));
    expect(resolved.status).toBe(201);await prune();
    const remaining=(await current()).items;expect(remaining).toHaveLength(1);expect(remaining[0].kind).toBe("progress");
    expect((await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n).toBe(1);
    const reopening=await send("api",command({kind:"incident",mode:"until_resolved"},3,{subjectKey:"incident"}));
    expect(reopening.status).toBe(409);expect(reopening.body.error).toBe("requires_replace");
  });
});
