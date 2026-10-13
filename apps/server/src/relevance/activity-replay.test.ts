import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { createWebhookService } from "../services.js";
import { canonicalOriginHash,lockOriginGenerationSlot } from "../origin-slots.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("Retained ActivityKit run replay",()=>{
  let db:Database,principalId:string;
  const token="activity_replay_owner_abcdefghijklmnopqrstuvwxyz";
  beforeAll(async()=>{db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);});
  afterAll(async()=>{await db.end();});
  beforeEach(async()=>{
    await db.query("TRUNCATE owner_principals CASCADE");await bootstrapOwner(db,"owner",token);
    principalId=(await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization)
      VALUES ($1,$2,$3,'Replay phone','com.example.relo.notifications','1','1','26','sandbox','authorized','authorized')`,
      [principalId,randomUUID(),randomUUID()]);
  });
  async function request(path:string,body:unknown,key=randomUUID()){
    const response=await createApp(db,{apnsMode:"disabled",credentialDerivationSecret:"activity-replay-secret-at-least-32-characters"}).request(path,{
      method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json","idempotency-key":key},body:JSON.stringify(body),
    });return {status:response.status,body:await response.json() as any};
  }
  test.each([
    {actor:"credential",withNewer:false},{actor:"credential",withNewer:true},
    {actor:"service",withNewer:false},{actor:"service",withNewer:true},
  ])("$actor replays retained admission after pruning (newer run: $withNewer)",async({actor,withNewer})=>{
    const service=actor==="service"?await createWebhookService(db,principalId,"Replay","http://127.0.0.1:8180"):null;
    const path=service?new URL(service.webhookUrl).pathname+"/live-activities":"/api/live-activities";
    const origin={sourceInstance:"replay-fixture",project:"Relo",thread:"same-work",channel:"progress"};
    const lifecycle={provider:"codex",runId:"replay-original-run"};
    const body={title:"Original run",status:"Working",origin,lifecycle};
    const first=await request(path,body);expect(first.status).toBe(201);
    const ended=await request(`${path}/${first.body.activity.id}/end`,{lifecycle});expect(ended.status).toBe(200);
    const newer=withNewer?await request(path,{...body,lifecycle:{...lifecycle,runId:"replay-newer-run"}}):null;
    if(newer)expect(newer.status).toBe(201);
    const pruned=await db.query("DELETE FROM notification_events WHERE principal_id=$1 AND payload#>>'{liveActivity,activityId}'=$2",[principalId,first.body.activity.id]);
    expect(pruned.rowCount).toBeGreaterThan(0);
    const remaining=(await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n;
    const replay=await request(path,body);
    expect(replay.status).toBe(200);expect(replay.body.replayed).toBe(true);
    expect(replay.body.activity).toEqual(first.body.activity);
    expect((await db.query("SELECT count(*)::int AS n FROM live_activities")).rows[0].n).toBe(newer?2:1);
    const active=(await db.query("SELECT id,generation FROM live_activities WHERE state='active'")).rows;
    if(newer)expect(active).toEqual([{id:newer.body.activity.id.slice(4),generation:2}]);
    else expect(active).toEqual([]);
    expect((await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n).toBe(remaining);
    const changed=await request(path,{...body,status:"A different original intent"});
    expect(changed.status).toBe(409);expect(changed.body.error).toBe("lifecycle_run_conflict");
  });
  test.each(["credential","service"])("%s concurrent start retries produce one admission and one command",async actor=>{
    const service=actor==="service"?await createWebhookService(db,principalId,"Replay","http://127.0.0.1:8180"):null;
    const path=service?new URL(service.webhookUrl).pathname+"/live-activities":"/api/live-activities";
    const body={title:"Concurrent run",status:"Working",lifecycle:{provider:"codex",runId:"concurrent-original-run"},
      origin:{sourceInstance:"replay-fixture",project:"Relo",thread:"same-work",channel:"progress"}};
    const results=await Promise.all([request(path,body),request(path,body)]);
    expect(results.map(result=>result.status).sort()).toEqual([200,201]);
    expect(results[0]!.body.activity).toEqual(results[1]!.body.activity);
    expect((await db.query("SELECT count(*)::int AS n FROM live_activities")).rows[0].n).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n).toBe(1);
  });
  test.each(["active","ended"])("an old history lock cannot delay selecting the %s latest generation",async state=>{
    const origin={sourceInstance:"lock-fixture",project:"Relo",thread:"same-work",channel:"progress"};
    const body={title:"History lock",status:"Working",origin};
    const first=await request("/api/live-activities",body);expect(first.status).toBe(201);
    expect((await request(`/api/live-activities/${first.body.activity.id}/end`,{})).status).toBe(200);
    const latest=await request("/api/live-activities",body);expect(latest.status).toBe(201);
    if(state==="ended")expect((await request(`/api/live-activities/${latest.body.activity.id}/end`,{})).status).toBe(200);
    const holder=await db.connect(),selector=await db.connect();
    try{
      await holder.query("BEGIN");await selector.query("BEGIN");
      await holder.query("SELECT id FROM live_activities WHERE id=$1 FOR UPDATE",[first.body.activity.id.slice(4)]);
      await selector.query("SET LOCAL statement_timeout='250ms'");
      const slot=await lockOriginGenerationSlot(selector,principalId,canonicalOriginHash(principalId,origin));
      expect(slot.latest.id).toBe(latest.body.activity.id.slice(4));expect(slot.nextGeneration).toBe(3);
      expect(slot.active?.id).toBe(state==="active"?latest.body.activity.id.slice(4):undefined);
    }finally{await holder.query("ROLLBACK");holder.release();await selector.query("ROLLBACK");selector.release();}
  });
  test.each(["credential","service"])("%s rejects changed start intent when expiry wins before acquisition",async actor=>{
    const service=actor==="service"?await createWebhookService(db,principalId,"Replay","http://127.0.0.1:8180"):null;
    const path=service?new URL(service.webhookUrl).pathname+"/live-activities":"/api/live-activities";
    const body={title:"Expired run",status:"Working",lifecycle:{provider:"codex",runId:"expired-original-run"},
      origin:{sourceInstance:"replay-fixture",project:"Relo",thread:"same-work",channel:"progress"}};
    const first=await request(path,body);expect(first.status).toBe(201);
    await db.query("UPDATE live_activities SET expires_at='2000-01-01',stale_at='2000-01-01' WHERE id=$1",[first.body.activity.id.slice(4)]);
    const changed=await request(path,{...body,status:"Changed after expiry"});
    expect(changed.status).toBe(409);expect(changed.body.error).toBe("lifecycle_run_conflict");
    expect((await db.query("SELECT count(*)::int AS n FROM live_activities")).rows[0].n).toBe(1);
  });
});
