import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { bootstrapOwner } from "../bootstrap.js";
import { hashToken } from "../auth.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { createWebhookService } from "../services.js";
import { expireInteraction,respondToInteraction } from "./commands.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("Shared interaction expiry",()=>{
  let db:Database,principalId:string,credentialId:string,deviceId:string;
  let service:Awaited<ReturnType<typeof createWebhookService>>;
  const owner="shared_expiry_owner_abcdefghijklmnopqrstuvwxyz",secret="shared-expiry-secret-with-at-least-32-characters";
  beforeAll(async()=>{db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);});
  afterAll(async()=>db.end());
  beforeEach(async()=>{
    await db.query("TRUNCATE owner_principals CASCADE");await bootstrapOwner(db,"owner",owner);
    const key=(await db.query<{id:string;principal_id:string}>("SELECT id,principal_id FROM principal_api_keys WHERE token_hash=$1",[hashToken(owner)])).rows[0]!;
    principalId=key.principal_id;credentialId=key.id;
    deviceId=(await db.query<{id:string}>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
      os_version,apns_environment,notification_authorization,apns_token) VALUES ($1,$2,$3,'Expiry','com.example.fixture','1','1','27','sandbox','authorized','fixture-token') RETURNING id`,
      [principalId,randomUUID(),randomUUID()])).rows[0]!.id;
    service=await createWebhookService(db,principalId,"Shared expiry","http://127.0.0.1:8180");
  });
  function app(){return createApp(db,{apnsMode:"sandbox",credentialDerivationSecret:secret});}
  async function decision(adapter="credential"){
    const response=await app().request(adapter==="service"?new URL(service.webhookUrl).pathname:"/api/interactions",{
      method:"POST",headers:{authorization:`Bearer ${owner}`,"content-type":"application/json","idempotency-key":randomUUID()},
      body:JSON.stringify(adapter==="service"?{body:"Continue?",response:{type:"yes_no",expiresInSeconds:30}}:{title:"Continue",prompt:"Continue?",type:"yes_no",expiresInSeconds:30}),
    });
    expect(response.status).toBe(201);
    const body=await response.json() as {eventId:string};
    const row=(await db.query<{id:string;notification_event_id:string}>("SELECT id,notification_event_id FROM interaction_requests WHERE notification_event_id=$1",[body.eventId.slice(4)])).rows[0]!;
    return {interactionId:row.id,eventId:row.notification_event_id};
  }
  test.each(["credential-read","credential-wait","service"])("%s expiry immediately cancels unsent delivery",async adapter=>{
    const command=await decision(adapter==="service"?"service":"credential");
    await db.query("UPDATE interaction_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[command.interactionId]);
    const path=adapter==="service"?`${new URL(service.webhookUrl).pathname}/events/ntf_${command.eventId}`:
      `/api/interactions/int_${command.interactionId}${adapter==="credential-wait"?"/wait":""}`;
    const response=await app().request(path,{headers:{authorization:`Bearer ${owner}`}});expect(response.status).toBe(200);
    expect((await db.query("SELECT state FROM interaction_requests WHERE id=$1",[command.interactionId])).rows[0].state).toBe("expired");
    expect((await db.query("SELECT state,last_error_code FROM delivery_jobs WHERE notification_event_id=$1",[command.eventId])).rows[0]).toEqual({state:"canceled",last_error_code:"interaction_expired"});
  });
  test("expiry cannot acquire a different credential, service, event or owner",async()=>{
    const command=await decision();
    await db.query("UPDATE interaction_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[command.interactionId]);
    for(const actor of [
      {kind:"credential" as const,principalId,credentialId:randomUUID()},
      {kind:"service" as const,principalId,serviceId:service.row.id},
      {kind:"owner" as const,principalId:randomUUID()},
      {kind:"device" as const,principalId,deviceId:randomUUID()},
    ]) expect(await expireInteraction(db,actor,command,"disabled")).toEqual({kind:"not_found"});
    expect(await expireInteraction(db,{kind:"credential",principalId,credentialId},{...command,eventId:randomUUID()},"disabled")).toEqual({kind:"not_found"});
    expect((await db.query("SELECT state FROM interaction_requests WHERE id=$1",[command.interactionId])).rows[0].state).toBe("pending");
    expect(await expireInteraction(db,{kind:"credential",principalId,credentialId},command,"disabled")).toEqual({kind:"expired"});
    expect(await expireInteraction(db,{kind:"credential",principalId,credentialId},command,"disabled")).toEqual({kind:"unchanged"});
  });
  test("the shared command uses the actual database deadline and never expires a valid decision",async()=>{
    const command=await decision();
    expect(await expireInteraction(db,{kind:"owner",principalId},command,"disabled")).toEqual({kind:"unchanged"});
    expect((await db.query("SELECT state FROM delivery_jobs WHERE notification_event_id=$1",[command.eventId])).rows[0].state).toBe("pending");
  });
  test("competing device responses choose one terminal value and one evidence row",async()=>{
    const command=await decision(),actor={kind:"device" as const,principalId,deviceId};
    const results=await Promise.all((["yes","no"] as const).map(kind=>respondToInteraction(db,actor,
      {...command,kind,value:{},idempotencyKey:randomUUID()},{apnsMode:"disabled"})));
    expect(results.filter(result=>result.kind==="accepted")).toHaveLength(1);
    expect(results.filter(result=>result.kind==="rejected")).toHaveLength(1);
    expect((await db.query("SELECT count(*)::int AS n FROM interactions WHERE notification_event_id=$1",[command.eventId])).rows[0].n).toBe(1);
    const accepted=results.find(result=>result.kind==="accepted")!;
    if(accepted.kind!=="accepted") throw new Error("missing winner");
    expect((await db.query("SELECT state FROM interaction_requests WHERE id=$1",[command.interactionId])).rows[0].state).toBe(accepted.state);
  });
  test("producer, service, owner and internal expiry actors cannot submit a phone answer",async()=>{
    const command=await decision();
    for(const actor of [
      {kind:"credential" as const,principalId,credentialId},
      {kind:"service" as const,principalId,serviceId:service.row.id},
      {kind:"owner" as const,principalId},{kind:"internal_expiry" as const,principalId},
    ]) expect(await respondToInteraction(db,actor,{...command,kind:"yes",value:{},idempotencyKey:randomUUID()},{apnsMode:"disabled"})).toEqual({kind:"rejected",error:"forbidden"});
    expect((await db.query("SELECT state FROM interaction_requests WHERE id=$1",[command.interactionId])).rows[0].state).toBe("pending");
  });
  test("response evidence failure rolls its state update and event transition back",async()=>{
    const command=await decision();
    await db.query("CREATE FUNCTION reject_shared_response() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'response evidence failure'; END $$");
    await db.query("CREATE TRIGGER reject_shared_response BEFORE INSERT ON interactions FOR EACH ROW EXECUTE FUNCTION reject_shared_response()");
    try{
      await expect(respondToInteraction(db,{kind:"device",principalId,deviceId},{...command,kind:"yes",value:{},idempotencyKey:randomUUID()},{apnsMode:"disabled"})).rejects.toThrow("response evidence failure");
      expect((await db.query("SELECT state,response,responded_at FROM interaction_requests WHERE id=$1",[command.interactionId])).rows[0]).toEqual({state:"pending",response:null,responded_at:null});
      expect((await db.query("SELECT state FROM notification_events WHERE id=$1",[command.eventId])).rows[0].state).toBe("active");
      expect((await db.query("SELECT count(*)::int AS n FROM interactions")).rows[0].n).toBe(0);
    }finally{
      await db.query("DROP TRIGGER reject_shared_response ON interactions");await db.query("DROP FUNCTION reject_shared_response()");
    }
  });
  test("exact response replay retains its first result and a different interaction identity is rejected",async()=>{
    const command=await decision(),actor={kind:"device" as const,principalId,deviceId},key=randomUUID();
    const input={...command,kind:"yes" as const,value:{},idempotencyKey:key};
    const first=await respondToInteraction(db,actor,input,{apnsMode:"disabled"});expect(first.kind).toBe("accepted");
    expect(await respondToInteraction(db,actor,input,{apnsMode:"disabled"})).toEqual({...first,kind:"replayed"});
    expect(await respondToInteraction(db,actor,{...input,interactionId:randomUUID()},{apnsMode:"disabled"})).toEqual({kind:"rejected",error:"interaction_version_mismatch"});
    expect(await respondToInteraction(db,actor,{...input,kind:"no"},{apnsMode:"disabled"})).toEqual({kind:"rejected",error:"idempotency_conflict"});
  });

});
