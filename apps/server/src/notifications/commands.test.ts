import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { createAccountAuth } from "../account-auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { hashToken } from "../auth.js";
import { createAuthDatabase,createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { createWebhookService } from "../webhooks/admin.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("Notification command adapter authority and atomicity",()=>{
  let db:Database,authDb:Database,principalId:string,credentialId:string,deviceId:string;
  let application:ReturnType<typeof createApp>,accountToken:string;
  let service:Awaited<ReturnType<typeof createWebhookService>>;
  const owner="command_owner_abcdefghijklmnopqrstuvwxyz",other="command_other_abcdefghijklmnopqrstuvwxyz";
  const secret="notification-command-fixture-secret-at-least-32-characters",origin="http://127.0.0.1:8180";
  beforeAll(async()=>{db=createDatabase(process.env.TEST_DATABASE_URL!);authDb=createAuthDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);});
  afterAll(async()=>{await Promise.all([db.end(),authDb.end()]);});
  beforeEach(async()=>{
    await db.query("TRUNCATE owner_principals CASCADE");
    await db.query("TRUNCATE auth.sessions,auth.accounts,auth.verifications,auth.users CASCADE");
    await bootstrapOwner(db,"owner",owner);await bootstrapOwner(db,"other",other);
    const key=(await db.query<{id:string;principal_id:string}>("SELECT id,principal_id FROM principal_api_keys WHERE token_hash=$1",[hashToken(owner)])).rows[0]!;
    principalId=key.principal_id;credentialId=key.id;
    deviceId=(await db.query<{id:string}>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token)
      VALUES ($1,$2,$3,'Command phone','com.example.fixture','1','1','27','sandbox','authorized','authorized','fixture-token') RETURNING id`,
      [principalId,randomUUID(),randomUUID()])).rows[0]!.id;
    service=await createWebhookService(db,principalId,"Command fixture",origin);
    application=createApp(db,{accountAuth:createAccountAuth(authDb,origin,secret),bootstrapOwnerHandle:"owner",credentialDerivationSecret:secret,appUrl:origin,apnsMode:"sandbox"});
    const signup=await application.request("/api/auth/sign-up/email",{method:"POST",headers:{"content-type":"application/json",origin},
      body:JSON.stringify({name:"Owner",email:"commands@example.test",password:"unique-test-password"})});
    expect(signup.status).toBe(200);accountToken=signup.headers.get("set-auth-token")!;
  });
  async function seed(adapter:string){
    return (await db.query<{id:string}>(`INSERT INTO notification_events(principal_id,requester_credential_id,service_id,requester_service_id,
      source,kind,title,body,payload,idempotency_key) VALUES ($1,$2,$3,$3,'Fixture','question','Question','Body','{}',$4) RETURNING id`,
      [principalId,adapter==="credential"?credentialId:null,adapter==="service"?service.row.id:null,randomUUID()])).rows[0]!.id;
  }
  async function withdraw(adapter:string,eventId:string,token?:string){
    const route=adapter==="service"?`/hooks/events/ntf_${eventId}/withdraw`
      :`/api/${adapter==="owner"?"account/":""}notifications/ntf_${eventId}/withdraw`;
    return application.request(route,{method:"POST",headers:{"idempotency-key":"withdraw-command",authorization:`Bearer ${adapter==="service"?service.secret:token??(adapter==="owner"?accountToken:owner)}`}});
  }
  test.each(["credential","service","owner"])("%s withdraw commits cancellation and append-only evidence once",async adapter=>{
    const eventId=await seed(adapter);
    await db.query("INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at) VALUES ($1,$2,'yes_no','Question',$3,now()+interval '15 minutes')",[principalId,eventId,randomUUID()]);
    await db.query("INSERT INTO delivery_jobs(notification_event_id,device_id) VALUES ($1,$2)",[eventId,deviceId]);
    const responses=await Promise.all([withdraw(adapter,eventId),withdraw(adapter,eventId)]);
    expect(responses.map(r=>r.status)).toEqual([200,200]);
    const bodies=await Promise.all(responses.map(r=>r.json())) as Array<{replayed?:boolean;idempotent?:boolean}>;
    expect(bodies.map(b=>b.replayed??b.idempotent).sort()).toEqual([false,true]);
    expect((await db.query("SELECT state FROM interaction_requests WHERE notification_event_id=$1",[eventId])).rows[0].state).toBe("canceled");
    expect((await db.query("SELECT state FROM delivery_jobs WHERE notification_event_id=$1",[eventId])).rows[0].state).toBe("canceled");
    const evidence=(await db.query("SELECT outcome,requester_kind FROM notification_withdrawal_evidence WHERE notification_event_id=$1 ORDER BY outcome",[eventId])).rows;
    expect(evidence.map(row=>row.outcome)).toEqual(["canonical_withdrawn","pending_delivery_canceled","sync_command_queued"]);
    expect(new Set(evidence.map(row=>row.requester_kind))).toEqual(new Set([adapter==="owner"?"dashboard":adapter]));
    await expect(db.query("DELETE FROM notification_withdrawal_evidence WHERE notification_event_id=$1",[eventId])).rejects.toThrow();
  });
  test.each(["credential","service","owner"])("%s withdrawal rolls back all state if evidence cannot commit",async adapter=>{
    const eventId=await seed(adapter);
    await db.query("INSERT INTO delivery_jobs(notification_event_id,device_id) VALUES ($1,$2)",[eventId,deviceId]);
    await db.query("CREATE FUNCTION reject_notification_command_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'command fixture failure'; END $$");
    await db.query("CREATE TRIGGER reject_notification_command_evidence BEFORE INSERT ON notification_withdrawal_evidence FOR EACH ROW EXECUTE FUNCTION reject_notification_command_evidence()");
    try{
      expect((await withdraw(adapter,eventId)).status).toBe(500);
      expect((await db.query("SELECT state,withdrawn_at FROM notification_events WHERE id=$1",[eventId])).rows[0]).toEqual({state:"active",withdrawn_at:null});
      expect((await db.query("SELECT state FROM delivery_jobs WHERE notification_event_id=$1",[eventId])).rows[0].state).toBe("pending");
    }finally{
      await db.query("DROP TRIGGER reject_notification_command_evidence ON notification_withdrawal_evidence");
      await db.query("DROP FUNCTION reject_notification_command_evidence()");
    }
  });
  test("credential and service actors cannot inherit owner withdrawal authority",async()=>{
    const credentialEvent=await seed("credential"),serviceEvent=await seed("service"),ownerEvent=await seed("owner");
    expect((await withdraw("credential",credentialEvent,other)).status).toBe(404);
    expect((await withdraw("credential",serviceEvent)).status).toBe(404);
    expect((await withdraw("service",credentialEvent)).status).toBe(404);
    expect((await withdraw("service",ownerEvent)).status).toBe(404);
    expect((await withdraw("credential",ownerEvent)).status).toBe(404);
    expect((await withdraw("owner",serviceEvent)).status).toBe(200);
  });
  async function create(adapter:string,key:string,body="Shared notification",relevance?:unknown){
    return application.request(adapter==="credential"?"/api/notifications":"/hooks",{
      method:"POST",headers:{"content-type":"application/json","idempotency-key":key,authorization:`Bearer ${adapter==="credential"?owner:service.secret}`},
      body:JSON.stringify({title:"Shared notification",body,...(adapter==="credential"?{sourceName:"Command fixture"}:{}),
        deviceIds:[`dev_${deviceId}`],...(relevance?{relevance}:{})}),
    });
  }
  test.each(["credential","service"])("%s creation preserves exact replay, content, targets and actor provenance",async adapter=>{
    const key=randomUUID(),first=await create(adapter,key);expect(first.status).toBe(201);
    const receipt=await first.json() as {eventId:string;delivery:unknown;relevance:unknown};
    expect(receipt.delivery).toMatchObject({ eligibleDevices:1,durableCommands:1,apnsJobs:1,readers:0});
    const replay=await create(adapter,key);expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({eventId:receipt.eventId,delivery:receipt.delivery,relevance:receipt.relevance});
    expect((await create(adapter,key,"Changed intent")).status).toBe(409);
    const event=(await db.query(`SELECT e.requester_credential_id,e.requester_service_id,e.service_id,e.target_mode,
      c.body_ciphertext FROM notification_events e JOIN notification_contents c ON c.notification_event_id=e.id WHERE e.id=$1`,[receipt.eventId.slice(4)])).rows[0];
    expect(event).toMatchObject({requester_credential_id:adapter==="credential"?credentialId:null,
      requester_service_id:adapter==="service"?service.row.id:null,service_id:adapter==="service"?service.row.id:null,target_mode:"explicit"});
    expect(event.body_ciphertext).not.toContain("Shared notification");
    expect((await db.query("SELECT count(*)::int AS n FROM notification_event_targets WHERE notification_event_id=$1 AND device_id=$2",[receipt.eventId.slice(4),deviceId])).rows[0].n).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n).toBe(1);
  });
  test.each(["credential","service"])("%s outbox failure rolls back new content, head and prior cancellation",async adapter=>{
    const occurredAt=new Date().toISOString();
    const subject=(revision:number)=>({subjectKey:"atomic-create",generation:1,revision,operation:revision===1?"replace":"update",occurredAt,policy:{kind:"notice"}});
    const first=await create(adapter,randomUUID(),"Shared notification",subject(1));expect(first.status).toBe(201);
    const prior=await first.json() as {eventId:string};
    await db.query("CREATE FUNCTION reject_notification_command_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox fixture failure'; END $$");
    await db.query("CREATE TRIGGER reject_notification_command_job BEFORE INSERT ON delivery_jobs FOR EACH ROW EXECUTE FUNCTION reject_notification_command_job()");
    try{
      expect((await create(adapter,randomUUID(),"Replacement",subject(2))).status).toBe(500);
      expect((await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n).toBe(1);
      expect((await db.query("SELECT count(*)::int AS n FROM notification_contents")).rows[0].n).toBe(1);
      expect((await db.query("SELECT revision::int AS revision,current_event_id FROM relevance_subjects")).rows[0]).toEqual({revision:1,current_event_id:prior.eventId.slice(4)});
      expect((await db.query("SELECT state FROM delivery_jobs")).rows[0].state).toBe("pending");
      expect((await db.query("SELECT superseded_at FROM notification_relevance")).rows[0].superseded_at).toBeNull();
    }finally{
      await db.query("DROP TRIGGER reject_notification_command_job ON delivery_jobs");await db.query("DROP FUNCTION reject_notification_command_job()");
    }
  });
  test.each(["credential","service"])("%s malformed persisted receipt fails without guessing delivery state",async adapter=>{
    const key=randomUUID(),first=await create(adapter,key);expect(first.status).toBe(201);
    const receipt=await first.json() as {eventId:string};
    await db.query("UPDATE notification_events SET delivery_summary='{}'::jsonb WHERE id=$1",[receipt.eventId.slice(4)]);
    const replay=await create(adapter,key);expect(replay.status).toBe(500);
    expect((await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n).toBe(1);
  });
  test("withdrawal waits for the request before locking its event",async()=>{
    const eventId=await seed("credential");
    await db.query("INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at) VALUES ($1,$2,'yes_no','Question',$3,now()+interval '15 minutes')",[principalId,eventId,randomUUID()]);
    const held=await db.connect(),probe=await db.connect();let response:Promise<Response>|undefined;
    try{
      await held.query("BEGIN");await held.query("SELECT id FROM interaction_requests WHERE notification_event_id=$1 FOR UPDATE",[eventId]);
      const pid=(await held.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      response=Promise.resolve(withdraw("credential",eventId));
      let blocked=false;
      for(let attempt=0;attempt<100&&!blocked;attempt++){
        blocked=(await db.query<{blocked:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked",[pid])).rows[0]!.blocked;
        if(!blocked) await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);
      await probe.query("BEGIN");
      // A response/expiry writer that already owns the request can still lock
      // the event. The former event-first withdrawal deadlocks this schedule.
      await probe.query("SELECT id FROM notification_events WHERE id=$1 FOR UPDATE NOWAIT",[eventId]);
    }finally{
      await probe.query("ROLLBACK");probe.release();await held.query("ROLLBACK");held.release();
      if(response) expect((await response).status).toBe(200);
    }
  });

});
