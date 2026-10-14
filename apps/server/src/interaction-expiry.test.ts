import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { hashToken } from "./auth.js";
import { pendingInteractionBadgeCount } from "./badge.js";
import { createDatabase, type Database } from "./db.js";
import { expireDueInteractiveActivities } from "./interactive-activity-lifecycle.js";
import { nextInteractionExpiryDelay } from "./interaction-expiry-scheduling.js";
import { migrate } from "./migrate.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
describe("Interaction deadline timer", () => {
  test.each([[null,2000],["125.4",126],[-5,25],[10000,2000]])("schedules %s without a busy loop",async (value,expected) => {
    const db = { query:async()=>({ rows:[{ delay_ms:value }] }) } as any;
    expect(await nextInteractionExpiryDelay(db,2000)).toBe(expected);
  });
  test("rejects invalid bounds before database work",async()=>{
    const db = { query:()=>{ throw new Error("Unexpected query"); } } as any;
    await expect(nextInteractionExpiryDelay(db,NaN)).rejects.toThrow("invalid_expiry_fallback");
    await expect(expireDueInteractiveActivities(db,"disabled",101)).rejects.toThrow("invalid_expiry_batch_limit");
  });
});
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Canonical expiry for ordinary decisions",()=>{
  let db:Database, principalId:string, deviceId:string;
  const token="expiry-test-device-token-with-at-least-32-characters";
  beforeAll(async()=>{db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);});
  afterAll(async()=>{await db.end();});
  beforeEach(async()=>{
    await db.query("TRUNCATE owner_principals CASCADE");
    principalId=(await db.query("INSERT INTO owner_principals(handle) VALUES ($1) RETURNING id",[randomUUID()])).rows[0].id;
    deviceId=(await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,
      bundle_identifier,app_version,app_build,os_version,apns_environment,notification_authorization)
      VALUES ($1,$2,$3,'Expiry test','com.example.relo.notifications','1','1','26','sandbox','authorized') RETURNING id`,
      [principalId,randomUUID(),randomUUID()])).rows[0].id;
    await db.query("INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)",[deviceId,hashToken(token)]);
  });
  async function decision(kind="approval",deadline=new Date(Date.now()-60000)){
    const eventId=(await db.query(`INSERT INTO notification_events(principal_id,source,kind,title,body,idempotency_key,expires_at)
      VALUES ($1,'Expiry','approval','Expiry','Expiry',$2,$3) RETURNING id`,[principalId,randomUUID(),deadline])).rows[0].id;
    const requestId=(await db.query(`INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at)
      VALUES ($1,$2,$3,'Continue?',$4,$5) RETURNING id`,[principalId,eventId,kind,hashToken(randomUUID()),deadline])).rows[0].id;
    return {eventId,requestId};
  }
  function respond(eventId:string){
    return createApp(db,{apnsMode:"disabled"}).request(`/api/notifications/ntf_${eventId}/interactions`,{
      method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},
      body:JSON.stringify({kind:"approve",idempotencyKey:randomUUID(),value:{}}),
    });
  }
  test("all ordinary kinds expire, leave badges immediately, and become retention eligible",async()=>{
    const rows=await Promise.all(["approval","yes_no","text"].map(kind=>decision(kind)));
    const valid=await decision("approval",new Date(Date.now()+60000));
    expect(await pendingInteractionBadgeCount(db,deviceId)).toBe(1);
    expect(await expireDueInteractiveActivities(db,"disabled")).toBe(3);
    const expired=await db.query("SELECT state FROM interaction_requests WHERE id=ANY($1::uuid[])",[rows.map(row=>row.requestId)]);
    expect(expired.rows.map(row=>row.state)).toEqual(["expired","expired","expired"]);
    const eligible=await db.query("SELECT terminal_eligible FROM notification_retention_eligibility WHERE id=ANY($1::uuid[])",[rows.map(row=>row.eventId)]);
    expect(eligible.rows.map(row=>row.terminal_eligible)).toEqual([true,true,true]);
    expect((await db.query("SELECT state FROM interaction_requests WHERE id=$1",[valid.requestId])).rows[0].state).toBe("pending");
    expect(await expireDueInteractiveActivities(db,"disabled")).toBe(0);
  });
  test("terminal and expired events contribute no actionable badge even before request settlement",async()=>{
    const ended=await decision("approval",new Date(Date.now()+60000));
    const withdrawn=await decision("approval",new Date(Date.now()+60000));
    expect(await pendingInteractionBadgeCount(db,deviceId)).toBe(2);
    await db.query("UPDATE notification_events SET state='canceled' WHERE id=$1",[ended.eventId]);
    await db.query("UPDATE notification_events SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[withdrawn.eventId]);
    expect(await pendingInteractionBadgeCount(db,deviceId)).toBe(0);
  });
  test.each([
    ["pending",null,true],["retry",null,true],["processing","preparing",true],
    ["processing","dispatch_started",false],["reconciliation_required",null,false],
  ])("expiry treats %s/%s as unsent=%s, preserving pinned evidence",async(state,phase,canceled)=>{
    const row=await decision(),hash="a".repeat(64);
    const job=(await db.query(`INSERT INTO delivery_jobs(notification_event_id,device_id,state,claim_token,claim_phase,apns_payload_sha256)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,[row.eventId,deviceId,state,phase?randomUUID():null,phase,hash])).rows[0].id;
    expect(await expireDueInteractiveActivities(db,"disabled")).toBe(1);
    const stored=(await db.query("SELECT state,claim_phase,apns_payload_sha256,last_error_code FROM delivery_jobs WHERE id=$1",[job])).rows[0];
    expect(stored.state).toBe(canceled?"canceled":state);
    expect(stored.claim_phase).toBe(canceled?null:phase);
    expect(stored.apns_payload_sha256).toBe(hash);
    if(canceled)expect(stored.last_error_code).toBe("interaction_expired");
  });
  test("a held response lock cannot block independent expiry; committed responses stay settled",async()=>{
    const held=await decision();await decision();const tx=await db.connect();
    try{
      await tx.query("BEGIN");await tx.query("SELECT id FROM interaction_requests WHERE id=$1 FOR UPDATE",[held.requestId]);
      expect(await expireDueInteractiveActivities(db,"disabled")).toBe(1);
      await tx.query("UPDATE interaction_requests SET state='approved',responded_at=now() WHERE id=$1",[held.requestId]);
      await tx.query("UPDATE notification_events SET state='responded' WHERE id=$1",[held.eventId]);await tx.query("COMMIT");
      expect(await expireDueInteractiveActivities(db,"disabled")).toBe(0);
      expect((await db.query("SELECT state FROM interaction_requests WHERE id=$1",[held.requestId])).rows[0].state).toBe("approved");
    }finally{await tx.query("ROLLBACK");tx.release();}
  });
  test("a response racing the expiry winner is stored as a late answer, never permission",async()=>{
    const row=await decision(),locked=deferred(),release=deferred();
    const wrapped={connect:async()=>{const client=await db.connect();return{
      release:()=>client.release(),query:async(sql:string,args?:unknown[])=>{
        const result=await client.query(sql,args);
        if(sql.includes("FOR UPDATE OF r SKIP LOCKED")){locked.resolve();await release.promise;}
        return result;
      },
    };}} as Database;
    const expiry=expireDueInteractiveActivities(wrapped,"disabled");await locked.promise;
    const response=respond(row.eventId);release.resolve();expect(await expiry).toBe(1);
    const result=await response;expect(result.status).toBe(200);expect(await result.json()).toMatchObject({late:true,decision:{state:"expired"}});
    expect((await db.query("SELECT state,late_response IS NOT NULL AS late FROM interaction_requests WHERE notification_event_id=$1",[row.eventId])).rows[0]).toEqual({state:"expired",late:true});
  });
  test("queue failure rolls request and event expiry back together",async()=>{
    const row=await decision();await db.query("INSERT INTO delivery_jobs(notification_event_id,device_id) VALUES ($1,$2)",[row.eventId,deviceId]);
    const wrapped={connect:async()=>{const client=await db.connect();return{
      release:()=>client.release(),query:async(sql:string,args?:unknown[])=>{
        if(sql.includes("UPDATE delivery_jobs"))throw new Error("injected queue failure");return client.query(sql,args);
      },
    };}} as Database;
    await expect(expireDueInteractiveActivities(wrapped,"disabled")).rejects.toThrow("injected queue failure");
    expect((await db.query("SELECT state FROM interaction_requests WHERE id=$1",[row.requestId])).rows[0].state).toBe("pending");
    expect((await db.query("SELECT state FROM notification_events WHERE id=$1",[row.eventId])).rows[0].state).toBe("active");
    expect((await db.query("SELECT state FROM delivery_jobs WHERE notification_event_id=$1",[row.eventId])).rows[0].state).toBe("pending");
  });
  test("bounded passes drain remaining overdue work",async()=>{
    for(let i=0;i<5;i++)await decision();
    expect(await expireDueInteractiveActivities(db,"disabled",2)).toBe(2);
    expect(await expireDueInteractiveActivities(db,"disabled",2)).toBe(2);
    expect(await expireDueInteractiveActivities(db,"disabled",2)).toBe(1);
  });
});
