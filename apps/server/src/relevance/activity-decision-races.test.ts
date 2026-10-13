import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createAccountAuth } from "../account-auth.js";
import { createLiveActivityCredential } from "../live-activity-interaction.js";
import { hashToken } from "../auth.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { expireDueInteractiveActivities } from "../interactive-activity-lifecycle.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("Activity decision transaction ordering",()=>{
  let db:Database,expiryDb:Database;
  const secret="activity-race-secret-at-least-32-characters";
  const owner="activity_race_owner_abcdefghijklmnopqrstuvwxyz";
  const phone="activity_race_phone_abcdefghijklmnopqrstuvwxyz";
  beforeAll(async()=>{
    db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);
    const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set("options","-c statement_timeout=250ms");
    expiryDb=createDatabase(url.toString());
  });
  afterAll(async()=>{await Promise.all([db.end(),expiryDb.end()]);});
  beforeEach(async()=>{
    await db.query("TRUNCATE owner_principals CASCADE");await bootstrapOwner(db,"owner",owner);
    const principalId=(await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    const deviceId=(await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization)
      VALUES ($1,$2,$3,'Race phone','com.example.relo.notifications','1','1','26','sandbox','authorized','authorized') RETURNING id`,
      [principalId,randomUUID(),randomUUID()])).rows[0].id;
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['interactions:respond','inbox:read'])",[deviceId,hashToken(phone)]);
  });
  async function request(path:string,token:string,body?:unknown){
    const response=await createApp(db,{apnsMode:"disabled",credentialDerivationSecret:secret,
      accountAuth:createAccountAuth(db,"http://127.0.0.1:8180",secret),bootstrapOwnerHandle:"owner",appUrl:"http://127.0.0.1:8180"}).request(path,{
      method:body===undefined?"GET":"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json","idempotency-key":randomUUID()},body:JSON.stringify(body),
    });return {status:response.status,body:await response.json() as any};
  }
  async function ask(activity=true){
    const result=await request("/api/interactions",owner,{title:"Race",prompt:"Continue?",type:"yes_no",expiresInSeconds:30,
      ...(activity?{presentation:"live_activity"}:{})});
    expect(result.status).toBe(201);return result.body;
  }
  async function waitForLocks(count:number){
    const deadline=performance.now()+3_000;
    while((await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n<count){
      if(performance.now()>deadline)throw new Error("Expected transaction lock barrier did not arrive");
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  }
  async function capability(decision:any){
    const row=(await db.query(`SELECT r.*,d.id AS device_id,d.credential_version FROM interaction_requests r
      JOIN devices d ON d.principal_id=r.principal_id WHERE r.id=$1`,[decision.interaction.id.slice(4)])).rows[0];
    return {notificationId:decision.eventId,deviceId:`dev_${row.device_id}`,action:"yes",
      credential:createLiveActivityCredential(secret,{interactionId:row.id,notificationEventId:row.notification_event_id,
        deviceId:row.device_id,principalId:row.principal_id,credentialVersion:Number(row.credential_version),expiresAt:new Date(row.expires_at)}),
      idempotencyKey:randomUUID()};
  }
  test.each([
    {first:"answer",surface:"phone"},{first:"end",surface:"phone"},
    {first:"answer",surface:"capability"},{first:"end",surface:"capability"},
  ])("$surface $first first settles without a request/activity deadlock",async ({first,surface})=>{
    const decision=await ask(),holder=await db.connect();
    await holder.query("BEGIN");await holder.query("SELECT id FROM interaction_requests WHERE id=$1 FOR UPDATE",[decision.interaction.id.slice(4)]);
    const credential=await capability(decision);
    const answer=()=>surface==="capability"?request(`/api/live-activity-responses/${decision.interaction.id}`,"",credential):request(`/api/notifications/${decision.eventId}/interactions`,phone,{kind:"yes",idempotencyKey:randomUUID()});
    const end=()=>request(`/api/live-activities/${decision.liveActivityId}/end`,owner,{});
    let answering!:ReturnType<typeof answer>,ending!:ReturnType<typeof end>;
    try{
      if(first==="answer"){answering=answer();await waitForLocks(1);ending=end();}
      else{ending=end();await waitForLocks(1);answering=answer();}
      await waitForLocks(2);
    }finally{await holder.query("ROLLBACK");holder.release();}
    const [answered,ended]=await Promise.all([answering,ending]);
    expect(answered.status).toBe(first==="answer"?(surface==="capability"?200:201):409);expect(ended.status).toBe(first==="answer"?409:200);
    expect((await db.query("SELECT count(*)::int AS n FROM interactions")).rows[0].n).toBe(first==="answer"?1:0);
  });
  test.each(["cancel","read","wait"])("%s settles before a concurrent end without reversing locks",async operation=>{
    const decision=await ask(),holder=await db.connect();
    if(operation!=="cancel")await db.query("UPDATE interaction_requests SET expires_at='2000-01-01'");
    await holder.query("BEGIN");await holder.query("SELECT id FROM interaction_requests WHERE id=$1 FOR UPDATE",[decision.interaction.id.slice(4)]);
    const path=`/api/interactions/${decision.interaction.id}${operation==="cancel"?"/cancel":operation==="wait"?"/wait?timeoutSeconds=0":""}`;
    let settling!:ReturnType<typeof request>,ending!:ReturnType<typeof request>;
    try{
      settling=request(path,owner,operation==="cancel"?{}:undefined);await waitForLocks(1);
      ending=request(`/api/live-activities/${decision.liveActivityId}/end`,owner,{});await waitForLocks(2);
    }finally{await holder.query("ROLLBACK");holder.release();}
    const [settled,ended]=await Promise.all([settling,ending]);
    expect(settled.status).toBe(200);expect(ended.status).toBe(409);
    expect(settled.body.interaction.state).toBe(operation==="cancel"?"canceled":"expired");
  });
  test.each(["rotate","revoke"])("capability rechecks %s after waiting for the activity lock",async change=>{
    const decision=await ask(),credential=await capability(decision),holder=await db.connect();
    await holder.query("BEGIN");await holder.query("SELECT id FROM live_activities WHERE id=$1 FOR UPDATE",[decision.liveActivityId.slice(4)]);
    let answering!:ReturnType<typeof request>;
    try{
      answering=request(`/api/live-activity-responses/${decision.interaction.id}`,"",credential);await waitForLocks(1);
      await db.query(change==="rotate"?"UPDATE devices SET credential_version=credential_version+1":"UPDATE devices SET revoked_at=now()");
    }finally{await holder.query("ROLLBACK");holder.release();}
    expect((await answering).status).toBe(change==="rotate"?401:404);
    expect((await db.query("SELECT count(*)::int AS n FROM interactions")).rows[0].n).toBe(0);
  });
  test("expiry skips a locked activity and still settles an unrelated ordinary decision",async()=>{
    const activity=await ask(),ordinary=await ask(false);
    await db.query("UPDATE interaction_requests SET expires_at='2000-01-01'");
    const holder=await db.connect();await holder.query("BEGIN");
    await holder.query("SELECT id FROM live_activities WHERE id=$1 FOR UPDATE",[activity.liveActivityId.slice(4)]);
    try{
      expect(await expireDueInteractiveActivities(expiryDb,"disabled")).toBe(1);
      expect((await db.query("SELECT state FROM interaction_requests WHERE id=$1",[ordinary.interaction.id.slice(4)])).rows[0].state).toBe("expired");
      expect((await db.query("SELECT state FROM interaction_requests WHERE id=$1",[activity.interaction.id.slice(4)])).rows[0].state).toBe("pending");
    }finally{await holder.query("ROLLBACK");holder.release();}
    expect(await expireDueInteractiveActivities(expiryDb,"disabled")).toBe(1);
  });
});
