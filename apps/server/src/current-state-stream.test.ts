import { randomUUID } from "node:crypto";
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { bootstrapOwner } from "./bootstrap.js";
import { hashToken,type AuthIdentity } from "./auth.js";
import { ApiChangeListener } from "./api-change-listener.js";
import { createApp } from "./app.js";
import { currentStreamAuthorized,visibleCurrentHintIds } from "./current-state-stream.js";
import { admitOrdinaryEvent } from "./relevance/ordinary-admission.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("committed scoped current streams",()=>{
  let db:Database,bus:ApiChangeListener,app:ReturnType<typeof createApp>,principal:string,devices:string[],actors:AuthIdentity[];
  const owner="current-stream-owner-abcdefghijklmnopqrstuvwxyz",phones=["current-stream-a-abcdefghijklmnopqrstuvwxyz","current-stream-b-abcdefghijklmnopqrstuvwxyz"];
  const streams:{reader:ReadableStreamDefaultReader<Uint8Array>;abort:AbortController}[]=[];
  beforeAll(async()=>{db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);});
  beforeEach(async()=>{
    await db.query("TRUNCATE owner_principals CASCADE");await bootstrapOwner(db,"stream",owner);
    principal=(await db.query("SELECT id FROM owner_principals WHERE handle='stream'")).rows[0].id;devices=[];actors=[];
    await db.query("UPDATE principal_api_keys SET scopes=array_append(scopes,'inbox:read') WHERE principal_id=$1",[principal]);
    for(const token of phones){
      const device=(await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
        app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization)
        VALUES ($1,$2,$3,'Fixture','com.example.relo.notifications','1','1','27','sandbox','authorized','authorized') RETURNING id,credential_version`,
      [principal,randomUUID(),randomUUID()])).rows[0];devices.push(device.id);
      const key=(await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['inbox:read','interactions:respond']) RETURNING id",[device.id,hashToken(token)])).rows[0].id;
      actors.push({principalId:principal,deviceId:device.id,deviceCredentialId:key,deviceCredentialVersion:device.credential_version,credentialKind:"device",scopes:new Set(["inbox:read"])});
    }
    bus=await ApiChangeListener.listen(db);app=createApp(db,{currentChanges:bus.current,interactionChanges:bus.interactions});
  });
  afterEach(async()=>{for(const stream of streams.splice(0)){stream.abort.abort();await stream.reader.cancel();}await bus?.close();});
  afterAll(async()=>{await db.end();});
  async function open(token=phones[0]!,query=""){
    const abort=new AbortController(),response=await app.request(`/api/inbox/events${query}`,{signal:abort.signal,headers:{authorization:`Bearer ${token}`}});
    expect(response.status).toBe(200);expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");const reader=response.body!.getReader();streams.push({reader,abort});return reader;
  }
  async function frame(reader:ReadableStreamDefaultReader<Uint8Array>){
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([reader.read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("stream frame timeout")),2000);})]);}
    finally{clearTimeout(timer);}
  }
  async function hint(reader:ReadableStreamDefaultReader<Uint8Array>){
    const result=await frame(reader);expect(result.done).toBe(false);
    const text=new TextDecoder().decode(result.value);expect(text).toMatch(/^event: current\ndata: /);
    return JSON.parse(text.split("data: ")[1]!) as {subjectIds:string[];invalidateCounts:boolean};
  }
  async function event(target?:string){
    // Insert and admit in one commit, as createNotification does.
    const tx=await db.connect();
    try{
      await tx.query("BEGIN");
      const row=(await tx.query(`INSERT INTO notification_events(principal_id,source,title,body,idempotency_key,target_mode)
        VALUES ($1,'Stream','Title','Sensitive body',$2,$3) RETURNING id,created_at,idempotency_key`,[principal,randomUUID(),target?"explicit":"broadcast"])).rows[0];
      await admitOrdinaryEvent(tx,{principalId:principal,sourceId:`account:${principal}`},{kind:"notice",apnsMode:"disabled",
        eventId:row.id,createdAt:row.created_at,idempotencyKey:row.idempotency_key,intentHash:"f".repeat(64)});
      await tx.query("COMMIT");return row.id as string;
    }catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
  }
  async function subjectOf(eventId:string){
    return `sub_${(await db.query("SELECT subject_id FROM notification_relevance WHERE notification_event_id=$1",[eventId])).rows[0].subject_id}`;
  }
  async function ask(key=randomUUID(),generation=1,device=0){
    const response=await app.request("/api/interactions",{method:"POST",headers:{authorization:`Bearer ${owner}`,"content-type":"application/json","idempotency-key":randomUUID()},
      body:JSON.stringify({type:"yes_no",title:"Exact question",prompt:"Private test wording",expiresInSeconds:300,deviceIds:[`dev_${devices[device]}`],
      relevance:{subjectKey:key,generation,revision:1,operation:"replace",occurredAt:new Date().toISOString(),policy:{kind:"decision",actionSeconds:300}}})});
    expect(response.status).toBe(201);return await response.json() as any;
  }
  test("no hint escapes rollback; a bootstrap commit wakes immediately after the initial read",async()=>{
    const reader=await open();expect(await hint(reader)).toEqual({subjectIds:[],invalidateCounts:true});
    const subscription=bus.current.subscribe(principal,"test")!;await subscription.wait(100);subscription.take();
    const tx=await db.connect();
    try{
      await tx.query("BEGIN");await tx.query(`INSERT INTO notification_events(principal_id,source,title,body,idempotency_key) VALUES ($1,'x','x','SECRET',$2)`,[principal,randomUUID()]);
      expect(await subscription.wait(10)).toBe("timeout");await tx.query("ROLLBACK");expect(await subscription.wait(10)).toBe("timeout");
      const before=await app.request("/api/inbox/current",{headers:{authorization:`Bearer ${phones[0]}`}});expect((await before.json() as any).total).toBe(0);
      const id=await event();expect((await hint(reader)).subjectIds).toEqual([await subjectOf(id)]);
      const after=await app.request("/api/inbox/current",{headers:{authorization:`Bearer ${phones[0]}`}});expect((await after.json() as any).items[0].notificationId).toBe(`ntf_${id}`);
    }finally{await tx.query("ROLLBACK");tx.release();subscription.close();}
  });
  test("event hints resolve canonical IDs after commit and cannot disclose another device's exclusive work",async()=>{
    const first=await ask(),id=first.eventId;
    const expected=(await visibleCurrentHintIds(db,actors[0]!,[id]))[0]!;expect(expected).toMatch(/^sub_/);
    expect(await visibleCurrentHintIds(db,actors[1]!,[id,expected])).toEqual([]);
    expect(await visibleCurrentHintIds(db,{...actors[0]!,principalId:randomUUID()},[id,expected])).toEqual([]);
    const reader=await open();await hint(reader);
    await db.query("UPDATE notification_events SET read_at=clock_timestamp() WHERE id=$1",[id.slice(4)]);
    const value=await hint(reader);expect(value.subjectIds).toEqual([expected]);expect(JSON.stringify(value)).not.toContain("Private test wording");
  });
  test("replacement can retire a formerly visible pointer without disclosing newly exclusive identity",async()=>{
    const key=randomUUID(),first=await ask(key),subject=(await visibleCurrentHintIds(db,actors[0]!,[first.eventId]))[0]!;
    const newer=await ask(key,2,1);
    expect(await visibleCurrentHintIds(db,actors[0]!,[subject])).toEqual([subject]);
    expect(await visibleCurrentHintIds(db,actors[0]!,[newer.eventId])).toEqual([]);
    const response=await app.request(`/api/inbox/current?id=${subject}`,{headers:{authorization:`Bearer ${phones[0]}`}});
    expect((await response.json() as any).retired).toEqual([{subjectId:subject,reason:"not_found"}]);
  });
  test.each(["credential","device","principal","scope","version"])("%s revocation promptly closes the connected stream",async kind=>{
    const reader=await open();await hint(reader);
    const query=kind==="credential"?"UPDATE device_credentials SET revoked_at=clock_timestamp() WHERE id=$1":kind==="device"?"UPDATE devices SET revoked_at=clock_timestamp() WHERE id=$1":kind==="principal"?"UPDATE owner_principals SET disabled_at=clock_timestamp() WHERE id=$1":kind==="scope"?"UPDATE device_credentials SET scopes=ARRAY['device:self'] WHERE id=$1":"UPDATE devices SET credential_version=credential_version+1 WHERE id=$1";
    await db.query(query,[kind==="principal"?principal:kind==="credential" || kind==="scope"?actors[0]!.deviceCredentialId:devices[0]]);
    expect(await frame(reader)).toMatchObject({done:true});expect(await currentStreamAuthorized(db,actors[0]!)).toBe(false);
  });
  test("credential expiry closes without a mutation or new event",async()=>{
    await db.query("UPDATE device_credentials SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",[actors[0]!.deviceCredentialId]);
    const reader=await open();await hint(reader);expect(await frame(reader)).toMatchObject({done:true});
  });
  test("extending a credential cannot spin a connected stream past its original deadline",async()=>{
    await db.query("UPDATE device_credentials SET expires_at=clock_timestamp()+interval '200 milliseconds' WHERE id=$1",[actors[0]!.deviceCredentialId]);
    const reader=await open();await hint(reader);
    await db.query("UPDATE device_credentials SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[actors[0]!.deviceCredentialId]);
    let result=await frame(reader);if(!result.done)result=await frame(reader);expect(result.done).toBe(true);
  });
  test("authentication and resource last-seen maintenance do not generate refresh loops",async()=>{
    await db.query("INSERT INTO resource_sources(principal_id,source_key,kind,display_name,provenance) VALUES ($1,'fixture','cli','Fixture','credential')",[principal]);
    await db.query("INSERT INTO resource_projects(principal_id,project_key,display_name,provenance,palette_ordinal,icon) VALUES ($1,'fixture','Fixture','explicit',0,'build')",[principal]);
    const sub=bus.current.subscribe(principal,"maintenance")!;await sub.wait(100);sub.take();
    await app.request("/api/inbox/current",{headers:{authorization:`Bearer ${owner}`}});
    await db.query("UPDATE resource_sources SET last_seen_at=clock_timestamp() WHERE principal_id=$1",[principal]);
    await db.query("UPDATE resource_projects SET last_seen_at=clock_timestamp() WHERE principal_id=$1",[principal]);
    expect(await sub.wait(20)).toBe("timeout");
    await db.query("UPDATE resource_projects SET display_name='Renamed project' WHERE principal_id=$1",[principal]);
    expect(await sub.wait(1000)).toBe("changed");expect(sub.take().subjectIds).toEqual([]);sub.close();
  });
  test("principal credential revocation closes and device identity never becomes principal authority",async()=>{
    const reader=await open(owner);await hint(reader);
    await db.query("UPDATE principal_api_keys SET revoked_at=clock_timestamp() WHERE principal_id=$1",[principal]);
    expect(await frame(reader)).toMatchObject({done:true});
    await db.query("UPDATE device_credentials SET scopes=array_append(scopes,'notifications:send') WHERE id=$1",[actors[0]!.deviceCredentialId]);
    const response=await app.request("/api/notifications",{method:"POST",headers:{authorization:`Bearer ${phones[0]}`,"content-type":"application/json","idempotency-key":randomUUID()},body:JSON.stringify({sourceName:"Phone",title:"No",body:"No"})});
    expect(response.status).toBe(403);expect(await response.json()).toEqual({error:"principal_credential_required"});
  });
  test("lost listener and reconnected clients request fresh current state without replay IDs",async()=>{
    const reader=await open();await hint(reader);
    const active=await db.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND query='LISTEN relo_current_changes' AND state='idle'`);
    expect(active.rows).toHaveLength(1);await db.query("SELECT pg_terminate_backend($1)",[active.rows[0].pid]);
    // The loss and the listener's recovery land together (the stream merges wakes for a moment): one frame
    // invalidates the whole scope, sent after the listener is back, so it covers commits during the gap.
    expect((await hint(reader)).subjectIds).toEqual([]);await event();
    // The stream stays live after recovery: the next commit still reaches it.
    expect((await hint(reader)).subjectIds.length).toBeLessThanOrEqual(1);
    const reconnected=await open(phones[0],"?after=obsolete");expect((await hint(reconnected)).subjectIds).toEqual([]);
  });
  test("stream requires header authentication, inbox scope, and available fanout capacity",async()=>{
    expect((await app.request(`/api/inbox/events?token=${phones[0]}`)).status).toBe(401);
    await db.query("UPDATE device_credentials SET scopes=ARRAY['device:self'] WHERE id=$1",[actors[0]!.deviceCredentialId]);
    expect((await app.request("/api/inbox/events",{headers:{authorization:`Bearer ${phones[0]}`}})).status).toBe(403);
    const slots=Array.from({length:16},()=>bus.current.subscribe(principal,`device:${actors[1]!.deviceCredentialId}`));expect(slots.every(Boolean)).toBe(true);
    expect((await app.request("/api/inbox/events",{headers:{authorization:`Bearer ${phones[1]}`}})).status).toBe(429);
    const noHub=createApp(db);expect((await noHub.request("/api/inbox/events",{headers:{authorization:`Bearer ${phones[1]}`}})).status).toBe(503);
  });
});
