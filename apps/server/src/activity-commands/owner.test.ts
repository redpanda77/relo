import {randomUUID} from "node:crypto";
import {afterAll,beforeAll,beforeEach,describe,expect,test} from "vitest";
import {createApp} from "../app.js";
import {createAccountAuth} from "../account-auth.js";
import {bootstrapOwner} from "../bootstrap.js";
import {hashToken} from "../auth.js";
import {createAuthDatabase,createDatabase,type Database} from "../db.js";
import {migrate} from "../migrate.js";
import {createWebhookService} from "../services.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("Owner activity command isolation and atomicity",()=>{
 let db:Database,authDb:Database,app:ReturnType<typeof createApp>,principalId:string,session:string,devices:string[],hook:string;
 const owner="owner_activity_commands_abcdefghijklmnopqrstuvwxyz",origin="http://127.0.0.1:8180",secret="owner-activity-command-test-secret-at-least-32-characters";
 beforeAll(async()=>{db=createDatabase(process.env.TEST_DATABASE_URL!);authDb=createAuthDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);});
 afterAll(async()=>{await db.end();await authDb.end();});
 beforeEach(async()=>{
  await db.query("TRUNCATE owner_principals CASCADE");await db.query("TRUNCATE auth.sessions,auth.accounts,auth.verifications,auth.users CASCADE");
  await bootstrapOwner(db,"owner",owner);
  principalId=(await db.query<{principal_id:string}>("SELECT principal_id FROM principal_api_keys WHERE token_hash=$1",[hashToken(owner)])).rows[0]!.principal_id;
  devices=[];
  for(let i=0;i<2;i++)devices.push((await db.query<{id:string}>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
    app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,live_activity_push_to_start_token)
    VALUES ($1,$2,$3,'Owner fixture','com.example.fixture','1','1','27','sandbox','authorized','authorized','fixture-start') RETURNING id`,[principalId,randomUUID(),randomUUID()])).rows[0]!.id);
  hook=new URL((await createWebhookService(db,principalId,"Other authority",origin)).webhookUrl).pathname;
  app=createApp(db,{accountAuth:createAccountAuth(authDb,origin,secret),bootstrapOwnerHandle:"owner",credentialDerivationSecret:secret,appUrl:origin,apnsMode:"sandbox"});
  const signed=await app.request("/api/auth/sign-up/email",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({name:"Owner",email:"owner-commands@example.test",password:"unique-owner-password"})});
  expect(signed.status).toBe(200);session=signed.headers.get("set-auth-token")!;
 });
 async function request(path:string,body:unknown,token=session,method="POST"){
  const response=await app.request(path,{method,headers:{authorization:`Bearer ${token}`,origin,"content-type":"application/json","idempotency-key":randomUUID()},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as any};
 }
 async function seed(index=0,ownerOwned=true){
  const created=await request("/api/live-activities",{title:"Atomic owner",status:"Working",deviceIds:[`dev_${devices[index]}`]},owner);
  expect(created.status).toBe(201);
  if(ownerOwned)await db.query("UPDATE live_activities SET requester_credential_id=NULL WHERE id=$1",[created.body.activity.id.slice(4)]);
  return created.body.activity;
 }
 const updateInput=(activity:any)=>({presentation:{...activity.presentation,content:{...activity.presentation.content,status:"Updated"}}});
 async function rejectJobs(operation:()=>Promise<void>){
  await db.query("CREATE FUNCTION reject_owner_activity_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owner outbox failure'; END $$");
  await db.query("CREATE TRIGGER reject_owner_activity_job BEFORE INSERT ON delivery_jobs FOR EACH ROW EXECUTE FUNCTION reject_owner_activity_job()");
  try{await operation();}finally{await db.query("DROP TRIGGER reject_owner_activity_job ON delivery_jobs");await db.query("DROP FUNCTION reject_owner_activity_job()");}
 }
 test.each(["update","end"])("owner %s rolls back state and pending question when the outbox fails",async operation=>{
  const activity=await seed(),id=activity.id.slice(4),event=(await db.query<{id:string}>("SELECT id FROM notification_events WHERE payload#>>'{liveActivity,activityId}'=$1",[activity.id])).rows[0]!.id;
  await db.query("INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at) VALUES ($1,$2,'yes_no','Continue?',$3,now()+interval '15 minutes')",[principalId,event,randomUUID()]);
  const input=operation==="update"?updateInput(activity):{};
  await rejectJobs(async()=>{
   expect((await request(`/api/dashboard/live-activities/${activity.id}/${operation}`,input)).status).toBe(500);
   expect((await db.query("SELECT state,status,sequence::int AS sequence FROM live_activities WHERE id=$1",[id])).rows[0]).toEqual({state:"active",status:"Working",sequence:activity.sequence});
   expect((await db.query("SELECT state FROM interaction_requests WHERE notification_event_id=$1",[event])).rows[0].state).toBe("pending");
   expect((await db.query("SELECT count(*)::int AS n FROM live_activity_operations WHERE live_activity_id=$1",[id])).rows[0].n).toBe(0);
  });
  const result=await request(`/api/dashboard/live-activities/${activity.id}/${operation}`,input);expect(result.status).toBe(200);expect(result.body.eventIds).toHaveLength(1);
  expect((await db.query("SELECT state FROM interaction_requests WHERE notification_event_id=$1",[event])).rows[0].state).toBe("canceled");
 });
 test("owner start and reuse roll back their event, lease and receipt when outbox insertion fails",async()=>{
  const seedActivity=await seed(),input={deviceId:`dev_${devices[1]}`,presentation:seedActivity.presentation};
  const path="/api/dashboard/live-activities/test";
  await rejectJobs(async()=>{
   expect((await request(path,input)).status).toBe(500);
   expect((await db.query("SELECT count(*)::int AS n FROM live_activities")).rows[0].n).toBe(1);
   expect((await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n).toBe(1);
   expect((await db.query("SELECT count(*)::int AS n FROM live_activity_operations")).rows[0].n).toBe(0);
  });
  const started=await request(path,input);expect(started.status).toBe(201);
  const id=started.body.activity.id.slice(4),updated={...input,presentation:{...input.presentation,content:{...input.presentation.content,status:"Changed"}}};
  await rejectJobs(async()=>{
   expect((await request(path,updated)).status).toBe(500);
   expect((await db.query("SELECT sequence::int AS sequence,status FROM live_activities WHERE id=$1",[id])).rows[0]).toEqual({sequence:started.body.activity.sequence,status:"Working"});
   expect((await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n).toBe(2);
   expect((await db.query("SELECT count(*)::int AS n FROM live_activity_operations WHERE live_activity_id=$1",[id])).rows[0].n).toBe(1);
  });
  const reused=await request(path,updated);expect(reused.status).toBe(200);expect(reused.body.activity.id).toBe(started.body.activity.id);expect(reused.body.activity.sequence).toBe(started.body.activity.sequence+1);
 });
 test("a Test Lab run files under the Test Lab project with its title as the topic",async()=>{
  const seedActivity=await seed(),started=await request("/api/dashboard/live-activities/test",{deviceId:`dev_${devices[1]}`,presentation:seedActivity.presentation});
  expect(started.status).toBe(201);
  const row=(await db.query<{project:string|null;topic:string|null}>(
   `SELECT c.project,c.display_name AS topic FROM notification_events e JOIN activity_conversations c ON c.id=e.conversation_id
    WHERE e.payload#>>'{liveActivity,activityId}'=$1`,[started.body.activity.id])).rows[0];
  expect(row).toEqual({project:"Test Lab",topic:seedActivity.presentation.content.title});
 });
 test("owner mutation cannot inherit credential or service activity authority",async()=>{
  const credential=await seed(0,false);
  expect((await request(`/api/dashboard/live-activities/${credential.id}/update`,updateInput(credential))).status).toBe(409);
  expect((await request(`/api/dashboard/live-activities/${credential.id}/end`,{})).status).toBe(409);
  const service=await request(`${hook}/live-activities`,{title:"Service",status:"Working",deviceIds:[`dev_${devices[1]}`]});expect(service.status).toBe(201);
  expect((await request(`/api/dashboard/live-activities/${service.body.activity.id}/end`,{})).status).toBe(409);
  const all=await request("/api/dashboard/live-activities/end-all",{});expect(all.status).toBe(200);expect(all.body.ended).toEqual([]);
  expect((await db.query("SELECT count(*)::int AS n FROM live_activities WHERE state='active'")).rows[0].n).toBe(2);
 });
 test("end-all rolls back every activity when a later outbox insertion fails",async()=>{
  const first=await seed(0),second=await seed(1);
  await db.query(`CREATE FUNCTION reject_second_owner_activity_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.live_activity_id='${second.id.slice(4)}'::uuid THEN RAISE EXCEPTION 'second owner outbox failure'; END IF; RETURN NEW; END $$`);
  await db.query("CREATE TRIGGER reject_second_owner_activity_job BEFORE INSERT ON delivery_jobs FOR EACH ROW EXECUTE FUNCTION reject_second_owner_activity_job()");
  try{
   expect((await request("/api/dashboard/live-activities/end-all",{})).status).toBe(500);
   expect((await db.query("SELECT state,sequence::int AS sequence FROM live_activities ORDER BY created_at")).rows).toEqual([{state:"active",sequence:first.sequence},{state:"active",sequence:second.sequence}]);
   expect((await db.query("SELECT count(*)::int AS n FROM live_activity_operations")).rows[0].n).toBe(0);
  }finally{await db.query("DROP TRIGGER reject_second_owner_activity_job ON delivery_jobs");await db.query("DROP FUNCTION reject_second_owner_activity_job()");}
  const ended=await request("/api/dashboard/live-activities/end-all",{});expect(ended.status).toBe(200);expect(ended.body.ended).toHaveLength(2);
  expect((await request("/api/dashboard/live-activities/end-all",{})).body.alreadyTerminal).toBe(true);
 });
 test("unavailable targets reject a single update without partial state",async()=>{
  const activity=await seed();await db.query("UPDATE live_activities SET target_device_ids=ARRAY[$2::uuid] WHERE id=$1",[activity.id.slice(4),randomUUID()]);
  const result=await request(`/api/dashboard/live-activities/${activity.id}/update`,updateInput(activity));expect(result.status).toBe(409);expect(result.body.error).toBe("activity_target_unavailable");
  expect((await db.query("SELECT status FROM live_activities WHERE id=$1",[activity.id.slice(4)])).rows[0].status).toBe("Working");
 });
 test("end-all truthfully counts and records an owned activity with no targets",async()=>{
  const activity=await seed();await db.query("UPDATE live_activities SET target_device_ids='{}'::uuid[] WHERE id=$1",[activity.id.slice(4)]);
  const ended=await request("/api/dashboard/live-activities/end-all",{});expect(ended.status).toBe(200);expect(ended.body.ended).toEqual([{id:activity.id,sequence:activity.sequence+1}]);expect(ended.body.delivery.durableCommands).toBe(0);
  expect((await db.query("SELECT state FROM live_activities WHERE id=$1",[activity.id.slice(4)])).rows[0].state).toBe("ended");
  expect((await db.query("SELECT count(*)::int AS n FROM live_activity_operations WHERE live_activity_id=$1",[activity.id.slice(4)])).rows[0].n).toBe(1);
 });
});
