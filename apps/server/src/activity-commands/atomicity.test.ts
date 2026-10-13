import {randomUUID} from "node:crypto";
import {afterAll,beforeAll,beforeEach,describe,expect,test} from "vitest";
import {createApp} from "../app.js";
import {bootstrapOwner} from "../bootstrap.js";
import {hashToken} from "../auth.js";
import {createDatabase,type Database} from "../db.js";
import {migrate} from "../migrate.js";
import {createWebhookService} from "../services.js";
import {executeActivityCommand} from "./commands.js";
import {SYSTEM_PRESENTATION_POLICY} from "../presentation-policy.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("Activity transactions",()=>{
 let db:Database,principalId:string,credentialId:string,hook:string,serviceId:string;
 const owner="activity_atomic_owner_abcdefghijklmnopqrstuvwxyz";
 beforeAll(async()=>{db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);});
 afterAll(async()=>db.end());
 beforeEach(async()=>{
  await db.query("TRUNCATE owner_principals CASCADE");await bootstrapOwner(db,"owner",owner);
  const actor=(await db.query<{id:string;principal_id:string}>("SELECT id,principal_id FROM principal_api_keys WHERE token_hash=$1",[hashToken(owner)])).rows[0]!;
  principalId=actor.principal_id;credentialId=actor.id;
  await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
    os_version,apns_environment,notification_authorization,live_activity_authorization,live_activity_push_to_start_token)
    VALUES ($1,$2,$3,'Atomicity','com.example.fixture','1','1','27','sandbox','authorized','authorized','fixture-start')`,[principalId,randomUUID(),randomUUID()]);
  const service=await createWebhookService(db,principalId,"Atomicity","http://127.0.0.1:8180");
  hook=new URL(service.webhookUrl).pathname;serviceId=service.row.id;
 });
 async function send(adapter:string,suffix:string,body:unknown,method="POST",key=randomUUID()){
  const response=await createApp(db,{apnsMode:"sandbox"}).request(`${adapter==="service"?hook:"/api"}/live-activities${suffix}`,{method,
   headers:{authorization:`Bearer ${owner}`,"content-type":"application/json","idempotency-key":key},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as {activity:{id:string;sequence:number};replayed:boolean;error?:string}};
 }
 for(const adapter of ["credential","service"]) for(const operation of ["update","end"]){
  test(`${adapter} ${operation} rolls back canonical state, pending decision and freshness when outbox fails`,async()=>{
   const start=await send(adapter,"",{title:"Atomic",status:"Working"});expect(start.status).toBe(201);
   const activityId=start.body.activity.id.slice(4),key=randomUUID(),path=`/${start.body.activity.id}${operation==="end"?"/end":""}`;
   const event=(await db.query<{id:string}>("SELECT id FROM notification_events WHERE payload#>>'{liveActivity,activityId}'=$1",[start.body.activity.id])).rows[0]!;
   await db.query(`INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at)
     VALUES ($1,$2,'yes_no','Continue?',$3,now()+interval '15 minutes')`,[principalId,event.id,randomUUID()]);
   const input={status:operation==="end"?"Complete":"Updated",ifSequence:start.body.activity.sequence};
   await db.query("CREATE FUNCTION reject_activity_command_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'activity outbox failure'; END $$");
   await db.query("CREATE TRIGGER reject_activity_command_job BEFORE INSERT ON delivery_jobs FOR EACH ROW EXECUTE FUNCTION reject_activity_command_job()");
   try{
    expect((await send(adapter,path,input,operation==="end"?"POST":"PATCH",key)).status).toBe(500);
    expect((await db.query("SELECT state,status,sequence::int AS sequence FROM live_activities WHERE id=$1",[activityId])).rows[0])
      .toEqual({state:"active",status:"Working",sequence:start.body.activity.sequence});
    expect((await db.query("SELECT state FROM interaction_requests WHERE notification_event_id=$1",[event.id])).rows[0].state).toBe("pending");
    expect((await db.query("SELECT state FROM delivery_jobs WHERE notification_event_id=$1",[event.id])).rows[0].state).toBe("pending");
    expect((await db.query("SELECT count(*)::int AS n FROM live_activity_operations WHERE live_activity_id=$1",[activityId])).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM activity_mutation_freshness WHERE activity_id=$1",[activityId])).rows[0].n).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n).toBe(1);
   }finally{
    await db.query("DROP TRIGGER reject_activity_command_job ON delivery_jobs");await db.query("DROP FUNCTION reject_activity_command_job()");
   }
   const accepted=await send(adapter,path,input,operation==="end"?"POST":"PATCH",key);expect(accepted.status).toBe(200);
   expect((await db.query("SELECT state FROM interaction_requests WHERE notification_event_id=$1",[event.id])).rows[0].state).toBe("canceled");
   expect((await db.query("SELECT state FROM delivery_jobs WHERE notification_event_id=$1",[event.id])).rows[0].state).toBe("canceled");
   const replay=await send(adapter,path,input,operation==="end"?"POST":"PATCH",key);expect(replay.status).toBe(200);expect(replay.body.replayed).toBe(true);expect(replay.body.activity).toEqual(accepted.body.activity);
   expect((await db.query("SELECT count(*)::int AS n FROM live_activity_operations WHERE live_activity_id=$1",[activityId])).rows[0].n).toBe(1);
  });
 }
 test.each(["credential","service"])("%s start and replacement roll back completely when new outbox insertion fails",async adapter=>{
  const input={title:"New admission",status:"Working",replace:true},key=randomUUID();
  for(const replacing of [false,true]) {
   const previous=replacing?await send(adapter,"",{title:"Prior admission",status:"Working"}):null;
   if(previous)expect(previous.status).toBe(201);
   const priorId=previous?.body.activity.id.slice(4)??null;
   const before=(await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n;
   await db.query(`CREATE FUNCTION reject_new_activity_start() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
     IF NEW.live_activity_id IS DISTINCT FROM ${priorId?"'"+priorId+"'::uuid":"NULL::uuid"} THEN RAISE EXCEPTION 'start outbox failure'; END IF; RETURN NEW; END $$`);
   await db.query("CREATE TRIGGER reject_new_activity_start BEFORE INSERT ON delivery_jobs FOR EACH ROW EXECUTE FUNCTION reject_new_activity_start()");
   try{
    expect((await send(adapter,"",input,"POST",key)).status).toBe(500);
    expect((await db.query("SELECT count(*)::int AS n FROM live_activities")).rows[0].n).toBe(replacing?1:0);
    expect((await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n).toBe(before);
    expect((await db.query("SELECT count(*)::int AS n FROM live_activity_operations")).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM activity_mutation_freshness")).rows[0].n).toBe(replacing?1:0);
    if(priorId)expect((await db.query("SELECT state FROM live_activities WHERE id=$1",[priorId])).rows[0].state).toBe("active");
   }finally{await db.query("DROP TRIGGER reject_new_activity_start ON delivery_jobs");await db.query("DROP FUNCTION reject_new_activity_start()");}
  }
  const started=await send(adapter,"",input,"POST",key);expect(started.status).toBe(201);
  const replay=await send(adapter,"",input,"POST",key);expect(replay.status).toBe(200);expect(replay.body.activity).toEqual(started.body.activity);
  expect((await db.query("SELECT count(*)::int AS n FROM live_activities WHERE state='active'")).rows[0].n).toBe(1);
 });
 test.each(["credential","service"])("%s rechecks activity ownership after waiting for the row lock",async adapter=>{
  const start=await send(adapter,"",{title:"Owned",status:"Working"});expect(start.status).toBe(201);
  const replacementCredential=(await db.query<{id:string}>("INSERT INTO principal_api_keys(principal_id,label,token_hash,scopes) VALUES ($1,'Other',$2,ARRAY['activities:write']) RETURNING id",[principalId,randomUUID()])).rows[0]!.id;
  const replacementService=(await createWebhookService(db,principalId,"Other","http://127.0.0.1:8180")).row.id;
  const held=await db.connect();let pending:ReturnType<typeof send>|undefined;
  try{
   await held.query("BEGIN");await held.query("SELECT id FROM live_activities WHERE id=$1 FOR UPDATE",[start.body.activity.id.slice(4)]);
   const pid=(await held.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
   pending=send(adapter,`/${start.body.activity.id}`,{status:"Cannot apply"},"PATCH");
   let blocked=false;
   for(let i=0;i<100&&!blocked;i++){
    blocked=(await db.query<{blocked:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked",[pid])).rows[0]!.blocked;
    if(!blocked) await new Promise(resolve=>setTimeout(resolve,10));
   }
   expect(blocked).toBe(true);
   await held.query("UPDATE live_activities SET requester_credential_id=$2,requester_service_id=$3 WHERE id=$1",
    [start.body.activity.id.slice(4),adapter==="credential"?replacementCredential:null,adapter==="service"?replacementService:null]);
   await held.query("COMMIT");
   expect((await pending).status).toBe(404);
   expect((await db.query("SELECT status FROM live_activities WHERE id=$1",[start.body.activity.id.slice(4)])).rows[0].status).toBe("Working");
  }finally{await held.query("ROLLBACK");held.release();if(pending) await pending;}
 });
 test("command boundary rejects an invalid service secret and a revoked credential",async()=>{
  const start=await send("credential","",{title:"Owned",status:"Working"});expect(start.status).toBe(201);
  const command={operation:"update" as const,activityId:start.body.activity.id.slice(4),idempotencyKey:randomUUID(),requestHash:"fixture",
   input:{status:"Cannot apply"},policy:{policy:SYSTEM_PRESENTATION_POLICY,source:"system" as const},apnsMode:"disabled" as const};
  expect(await executeActivityCommand(db,{kind:"service",principalId,serviceId,secretHash:"wrong",sourceName:"Wrong"},command)).toEqual({kind:"not_found"});
  await db.query("UPDATE principal_api_keys SET revoked_at=now() WHERE id=$1",[credentialId]);
  expect(await executeActivityCommand(db,{kind:"credential",principalId,credentialId,sourceName:"Revoked"},command)).toEqual({kind:"not_found"});
 });
 test("expiry is checked after acquiring a contended activity lock",async()=>{
  const start=await send("credential","",{title:"Expiry",status:"Working"});expect(start.status).toBe(201);
  const id=start.body.activity.id.slice(4);
  await db.query("UPDATE live_activities SET stale_at=NULL,expires_at=clock_timestamp()+interval '300 milliseconds' WHERE id=$1",[id]);
  const held=await db.connect();let pending:ReturnType<typeof send>|undefined;
  try{
   await held.query("BEGIN");await held.query("SELECT id FROM live_activities WHERE id=$1 FOR UPDATE",[id]);
   const pid=(await held.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
   pending=send("credential",`/${start.body.activity.id}`,{status:"Too late"},"PATCH");
   let blocked=false;
   for(let i=0;i<100&&!blocked;i++){
    blocked=(await db.query<{blocked:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked",[pid])).rows[0]!.blocked;
    if(!blocked) await new Promise(resolve=>setTimeout(resolve,5));
   }
   expect(blocked).toBe(true);
   await held.query("SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.02) FROM live_activities WHERE id=$1",[id]);
   await held.query("COMMIT");
   const result=await pending;expect(result.status).toBe(409);expect(result.body.error).toBe("activity_terminal");
   expect((await db.query("SELECT state,terminal_reason FROM live_activities WHERE id=$1",[id])).rows[0]).toEqual({state:"expired",terminal_reason:"absolute_expiry"});
  }finally{await held.query("ROLLBACK");held.release();if(pending) await pending;}
 });

 test.each(["credential","service"])("%s dates a contended mutation from its actual write",async adapter=>{
  const start=await send(adapter,"",{title:"Ordered",status:"Working"});expect(start.status).toBe(201);
  const id=start.body.activity.id.slice(4),held=await db.connect();let pending:ReturnType<typeof send>|undefined;
  try{
   await held.query("BEGIN");await held.query("SELECT id FROM live_activities WHERE id=$1 FOR UPDATE",[id]);
   const pid=(await held.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
   pending=send(adapter,`/${start.body.activity.id}`,{status:"After lock"},"PATCH");
   let blocked=false;
   for(let i=0;i<100&&!blocked;i++){
    blocked=(await db.query<{blocked:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked",[pid])).rows[0]!.blocked;
    if(!blocked) await new Promise(resolve=>setTimeout(resolve,5));
   }
   expect(blocked).toBe(true);
   const releasedAfter=(await held.query<{at:Date}>("SELECT clock_timestamp() AS at")).rows[0]!.at;
   await held.query("COMMIT");expect((await pending).status).toBe(200);
   const row=(await db.query<{updated_at:Date;accepted_at:Date}>(`SELECT a.updated_at,f.accepted_at FROM live_activities a
     JOIN activity_mutation_freshness f ON f.activity_id=a.id AND f.sequence=a.sequence WHERE a.id=$1`,[id])).rows[0]!;
   expect(row.updated_at.getTime()).toBeGreaterThanOrEqual(releasedAfter.getTime());
   expect(row.accepted_at).toEqual(row.updated_at);
  }finally{await held.query("ROLLBACK");held.release();if(pending) await pending;}
 });

});
