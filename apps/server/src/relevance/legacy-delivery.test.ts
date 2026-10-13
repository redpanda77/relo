import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { bootstrapOwner } from "../bootstrap.js";
import { hashToken } from "../auth.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { claimDeliveryJobs } from "../apns-worker-state.js";
import { cancelUndeliverableDeliveryJobs } from "../delivery-lifecycle.js";
import { PostgresApnsRecipientResolver } from "../apns-recipient-resolver.js";
import { createTransportTokenEncryption } from "../token-encryption.js";
import { applySubjectMutation } from "./commands.js";
const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("Legacy alert windows use original event time",()=>{
  let db:Database,principalId:string,deviceId:string;
  const encryption=createTransportTokenEncryption("legacy-delivery-test-secret-at-least-32-characters");
  beforeAll(async()=>{db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);});
  afterAll(async()=>{await db.end();});
  beforeEach(async()=>{
    await db.query("TRUNCATE owner_principals CASCADE");await bootstrapOwner(db,"owner","legacy_delivery_owner_abcdefghijklmnopqrstuvwxyz");
    principalId=(await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    deviceId=(await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,apns_token)
      VALUES ($1,$2,$3,'Legacy phone','com.example.relo.notifications','1','1','26','sandbox','authorized',$4) RETURNING id`,
      [principalId,randomUUID(),randomUUID(),encryption.encrypt("fixture-token","device.apns_token")])).rows[0].id;
  });
  async function fixture(kind:string,age:number){
    const payload=kind==="progress"||kind==="end"?{liveActivity:{operation:kind==="end"?"end":"update"}}:{};
    const event=(await db.query(`INSERT INTO notification_events(principal_id,source,kind,title,body,payload,idempotency_key,
      expires_at,created_at) VALUES ($1,'Legacy',$2,'Fixture','Fixture',$3,$4,clock_timestamp()+interval '8 hours',
      clock_timestamp()-($5*interval '1 second')) RETURNING id,created_at`,
      [principalId,kind==="decision"?"question":kind==="notice"?"notification":"live_activity",payload,randomUUID(),age])).rows[0];
    await db.query("INSERT INTO notification_event_targets(notification_event_id,device_id) VALUES ($1,$2)",[event.id,deviceId]);
    if(kind==="decision")await db.query(`INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at)
      VALUES ($1,$2,'yes_no','Continue?',$3,clock_timestamp()+interval '8 hours')`,[principalId,event.id,hashToken(randomUUID())]);
    const job=(await db.query("INSERT INTO delivery_jobs(notification_event_id,device_id) VALUES ($1,$2) RETURNING id",[event.id,deviceId])).rows[0];
    return {event,job};
  }
  test.each([{kind:"notice",seconds:60},{kind:"progress",seconds:15},{kind:"decision",seconds:900},{kind:"end",seconds:3600}])("$kind cannot reset its $seconds-second window by recreating a job",async({kind,seconds})=>{
    const {event,job}=await fixture(kind,seconds+1);
    expect(await claimDeliveryJobs(db,10,new Date(0))).toEqual([]);
    expect(await cancelUndeliverableDeliveryJobs(db)).toBe(1);
    expect((await db.query("SELECT state,last_error_code FROM delivery_jobs WHERE id=$1",[job.id])).rows[0])
      .toMatchObject({state:"canceled",last_error_code:"relevance_delivery_closed"});
    expect((await db.query("SELECT state FROM notification_events WHERE id=$1",[event.id])).rows[0].state).toBe("active");
    if(kind==="decision")expect((await db.query("SELECT state FROM interaction_requests WHERE notification_event_id=$1",[event.id])).rows[0].state).toBe("pending");
  });
  test.each([{kind:"notice",seconds:60},{kind:"progress",seconds:15},{kind:"decision",seconds:900},{kind:"end",seconds:3600}])("$kind claim carries its original provider expiration",async({kind,seconds})=>{
    const {event}=await fixture(kind,0),[claim]=await claimDeliveryJobs(db,10,new Date(0));
    expect(claim).toBeDefined();expect(claim!.expires_at!.getTime()-event.created_at.getTime()).toBe(seconds*1000);
  });
  test("a shorter explicit request deadline wins and a settled legacy prompt cannot dispatch",async()=>{
    const {event}=await fixture("decision",0);
    const deadline=(await db.query("UPDATE interaction_requests SET expires_at=clock_timestamp()+interval '10 seconds' WHERE notification_event_id=$1 RETURNING expires_at",[event.id])).rows[0].expires_at;
    expect((await claimDeliveryJobs(db,10,new Date(0)))[0]!.expires_at!.toISOString()).toBe(deadline.toISOString());
    await db.query("UPDATE delivery_jobs SET state='retry',claim_token=NULL,claim_phase=NULL WHERE notification_event_id=$1",[event.id]);
    await db.query("UPDATE interaction_requests SET state='canceled' WHERE notification_event_id=$1",[event.id]);
    expect(await claimDeliveryJobs(db,10,new Date(0))).toEqual([]);
  });
  test("expiry at final authorization preserves fenced evidence",async()=>{
    const {event,job}=await fixture("notice",0),token=randomUUID();
    await db.query(`UPDATE delivery_jobs SET state='processing',claim_phase='dispatch_started',claim_token=$2,
      apns_payload_sha256=$3 WHERE id=$1`,[job.id,token,"a".repeat(64)]);
    await db.query("UPDATE notification_events SET created_at=clock_timestamp()-interval '61 seconds' WHERE id=$1",[event.id]);
    const resolver=new PostgresApnsRecipientResolver({db,encryption,kind:"notification",deliveryJobId:job.id,
      claimToken:token,principalId,deviceId,notificationEventId:event.id,environment:"sandbox"});
    await expect(resolver.acquire()).resolves.toBeNull();
    expect(await cancelUndeliverableDeliveryJobs(db)).toBe(0);
    expect((await db.query("SELECT state,apns_payload_sha256 FROM delivery_jobs WHERE id=$1",[job.id])).rows[0])
      .toEqual({state:"processing",apns_payload_sha256:"a".repeat(64)});
  });
  test("canonical heartbeat freshness also bounds provider expiration",async()=>{
    const {event}=await fixture("progress",0),tx=await db.connect();
    try{
      await tx.query("BEGIN");
      await applySubjectMutation(tx,{principalId,sourceId:"fixture:heartbeat"},{eventId:event.id,intentHash:"b".repeat(64),command:{
        subjectKey:"work",generation:1,revision:1,operation:"replace",occurredAt:event.created_at.toISOString(),
        policy:{kind:"progress",heartbeat:{intervalSeconds:1,lastHeartbeatAt:event.created_at.toISOString()}},
      }});await tx.query("COMMIT");
    }catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
    const [claim]=await claimDeliveryJobs(db,10,new Date(0));
    expect(claim!.expires_at!.getTime()-event.created_at.getTime()).toBe(3000);
  });
});
