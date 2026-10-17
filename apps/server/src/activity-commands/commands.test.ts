import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { bootstrapOwner } from "../bootstrap.js";
import { hashToken } from "../auth.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { createWebhookService } from "../webhooks/admin.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("Activity command adapter chronology",()=>{
  let db:Database,principalId:string,hookSecret:string;
  const owner="activity_command_owner_abcdefghijklmnopqrstuvwxyz";
  beforeAll(async()=>{db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);});
  afterAll(async()=>db.end());
  beforeEach(async()=>{
    await db.query("TRUNCATE owner_principals CASCADE");await bootstrapOwner(db,"owner",owner);
    principalId=(await db.query<{principal_id:string}>("SELECT principal_id FROM principal_api_keys WHERE token_hash=$1",[hashToken(owner)])).rows[0]!.principal_id;
    await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
      os_version,apns_environment,notification_authorization,live_activity_authorization,live_activity_push_to_start_token)
      VALUES ($1,$2,$3,'Chronology','com.example.fixture','1','1','27','sandbox','authorized','authorized','fixture-start')`,[principalId,randomUUID(),randomUUID()]);
    hookSecret=(await createWebhookService(db,principalId,"Chronology","http://127.0.0.1:8180")).secret;
  });
  const before=(seconds:number)=>new Date(Date.now()-seconds*1000).toISOString();
  async function send(adapter:string,suffix:string,body:unknown,method="POST",key=randomUUID()){
    const response=await createApp(db,{apnsMode:"sandbox",credentialDerivationSecret:"activity-command-secret-with-at-least-32-characters"})
      .request(`${adapter==="service"?"/hooks":"/api"}/live-activities${suffix}`,{method,
        headers:{authorization:`Bearer ${adapter==="service"?hookSecret:owner}`,"content-type":"application/json","idempotency-key":key},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json() as {activity:{id:string;sequence:number};queued:number;replayed?:boolean;error?:string}};
  }
  test.each(["credential","service"])("%s delayed start preserves its original delivery deadline and exact replay",async adapter=>{
    const occurredAt=before(120),key=randomUUID(),input={title:"Late start",status:"Working",occurredAt};
    const first=await send(adapter,"",input,"POST",key);expect(first.status).toBe(201);expect(first.body.queued).toBe(0);
    const record=(await db.query("SELECT occurred_at,deliver_until FROM activity_mutation_freshness WHERE activity_id=$1",[first.body.activity.id.slice(4)])).rows[0];
    expect(record.occurred_at.toISOString()).toBe(occurredAt);expect(record.deliver_until.toISOString()).toBe(new Date(Date.parse(occurredAt)+15000).toISOString());
    const replay=await send(adapter,"",input,"POST",key);expect(replay.status).toBe(200);expect(replay.body.activity).toEqual(first.body.activity);expect(replay.body.queued).toBe(0);
  });
  test.each(["credential","service"])("%s out-of-order updates roll back canonical state and terminal cleanup keeps original time",async adapter=>{
    const first=await send(adapter,"",{title:"Run",status:"Started",occurredAt:before(180)});expect(first.status).toBe(201);
    const path=`/${first.body.activity.id}`,accepted=await send(adapter,path,{status:"Newer",occurredAt:before(90),ifSequence:first.body.activity.sequence},"PATCH");
    expect(accepted.status).toBe(200);expect(accepted.body.queued).toBe(0);
    const stale=await send(adapter,path,{status:"Obsolete",occurredAt:before(120),ifSequence:accepted.body.activity.sequence},"PATCH");
    expect(stale.status).toBe(409);
    expect((await db.query("SELECT status,sequence::int AS sequence FROM live_activities WHERE id=$1",[first.body.activity.id.slice(4)])).rows[0]).toEqual({status:"Newer",sequence:accepted.body.activity.sequence});
    const occurredAt=before(30),ended=await send(adapter,path+"/end",{occurredAt,ifSequence:accepted.body.activity.sequence});expect(ended.status).toBe(200);
    const record=(await db.query("SELECT occurred_at,accepted_at,deliver_until FROM activity_mutation_freshness WHERE activity_id=$1 ORDER BY sequence DESC LIMIT 1",[first.body.activity.id.slice(4)])).rows[0];
    expect(record.occurred_at.toISOString()).toBe(occurredAt);expect(record.deliver_until.toISOString()).toBe(new Date(record.accepted_at.getTime()+3600000).toISOString());
  });
  test.each(["credential","service"])("%s rejects another lifecycle owner for updates and terminal commands",async adapter=>{
    const lifecycle={provider:"codex",runId:randomUUID()};
    const first=await send(adapter,"",{title:"Owned run",status:"Working",lifecycle,origin:{sourceInstance:"chronology",project:"relo",thread:randomUUID(),channel:"work"}});expect(first.status).toBe(201);
    const wrong={provider:"codex",runId:randomUUID()},path=`/${first.body.activity.id}`;
    for(const operation of ["update","end"]){
      const result=await send(adapter,path+(operation==="end"?"/end":""),{status:"Wrong run",lifecycle:wrong},operation==="update"?"PATCH":"POST");
      expect(result.status).toBe(409);expect(result.body.error).toBe("activity_owner_conflict");
    }
    expect((await db.query("SELECT state,status,sequence::int AS sequence FROM live_activities WHERE id=$1",[first.body.activity.id.slice(4)])).rows[0])
      .toEqual({state:"active",status:"Working",sequence:first.body.activity.sequence});
  });
  test.each(["credential","service"])("%s rejects an unseen stale generation after a newer run finishes",async adapter=>{
    const origin={sourceInstance:"chronology",project:"relo",thread:randomUUID(),channel:"work"};
    const first=await send(adapter,"",{title:"Latest",status:"Working",origin,occurredAt:before(60)});expect(first.status).toBe(201);
    expect((await send(adapter,`/${first.body.activity.id}/end`,{occurredAt:before(30),ifSequence:first.body.activity.sequence})).status).toBe(200);
    const delayed=await send(adapter,"",{title:"Obsolete",status:"Working",origin,occurredAt:before(90)});
    expect(delayed.status).toBe(409);expect(delayed.body.error).toBe("stale_occurrence");
    expect(Number((await db.query("SELECT count(*) AS count FROM live_activities WHERE principal_id=$1",[principalId])).rows[0].count)).toBe(1);
  });
  test.each(["credential","service"])("%s rejects future producer timestamps without creating state",async adapter=>{
    const result=await send(adapter,"",{title:"Future",status:"Working",occurredAt:new Date(Date.now()+3600000).toISOString()});
    expect(result.status).toBe(400);expect(result.body.error).toBe("invalid_occurrence");
    expect(Number((await db.query("SELECT count(*) AS count FROM live_activities WHERE principal_id=$1",[principalId])).rows[0].count)).toBe(0);
  });

  test.each(["credential","service"])("%s delayed admission preserves canonical expiry and stale deadlines",async adapter=>{
    const occurredAt=before(120),first=await send(adapter,"",{title:"Delayed lifetime",status:"Working",occurredAt,expiresInSeconds:300,staleAfterSeconds:180});
    expect(first.status).toBe(201);
    const row=(await db.query("SELECT expires_at,stale_at FROM live_activities WHERE id=$1",[first.body.activity.id.slice(4)])).rows[0];
    expect(row.expires_at.getTime()).toBe(Date.parse(occurredAt)+300000);
    expect(row.stale_at.getTime()).toBe(Date.parse(occurredAt)+180000);
  });

  test.each(["credential","service"])("%s delayed updates retain configured freshness cadence",async adapter=>{
    const first=await send(adapter,"",{title:"Delayed cadence",status:"Working",occurredAt:before(120),expiresInSeconds:600,staleAfterSeconds:180});
    expect(first.status).toBe(201);
    let sequence=first.body.activity.sequence;
    for(const age of [90,30]){
      const occurredAt=before(age),updated=await send(adapter,`/${first.body.activity.id}`,{status:`Update ${age}`,occurredAt,ifSequence:sequence},"PATCH");
      expect(updated.status).toBe(200);sequence=updated.body.activity.sequence;
      const row=(await db.query("SELECT stale_at FROM live_activities WHERE id=$1",[first.body.activity.id.slice(4)])).rows[0];
      expect(row.stale_at.getTime()).toBe(Date.parse(occurredAt)+180000);
    }
  });
  test.each(["credential","service"])("%s delayed origin reuse preserves producer freshness time",async adapter=>{
    const origin={sourceInstance:"chronology",project:"relo",thread:randomUUID(),channel:"work"};
    const first=await send(adapter,"",{title:"Reuse",status:"Working",origin,occurredAt:before(120),expiresInSeconds:600,staleAfterSeconds:180});
    expect(first.status).toBe(201);
    const occurredAt=before(90),reuse=await send(adapter,"",{title:"Reuse",status:"New state",origin,occurredAt,expiresInSeconds:600,staleAfterSeconds:180});
    expect(reuse.status).toBe(200);expect(reuse.body.activity.id).toBe(first.body.activity.id);
    const row=(await db.query("SELECT stale_at FROM live_activities WHERE id=$1",[first.body.activity.id.slice(4)])).rows[0];
    expect(row.stale_at.getTime()).toBe(Date.parse(occurredAt)+180000);
  });

  test.each(["credential","service"])("%s: a raw API card with steps keeps its own percentage when an update brings steps (only a work's card drops it)",async adapter=>{
    const first=await send(adapter,"",{title:"Raw",status:"Working",progress:0.6,steps:{labels:["A","B","C"],current:1}});expect(first.status).toBe(201);
    const progress=async()=>Number((await db.query("SELECT progress FROM live_activities WHERE id=$1",[first.body.activity.id.slice(4)])).rows[0].progress);
    expect(await progress()).toBeCloseTo(0.6);
    const updated=await send(adapter,`/${first.body.activity.id}`,{status:"Next",steps:{labels:["A","B","C"],current:2}},"PATCH");expect(updated.status).toBe(200);
    expect(await progress()).toBeCloseTo(0.6);
  });
});
