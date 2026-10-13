import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { currentTestPresentation } from "./test-current-presentation.js";
import { currentInboxResponseSchema } from "@relo/notification-contracts";
import { pendingInteractionBadgeCount } from "./badge.js";
import { applySubjectMutation } from "./relevance/commands.js";
import { admitFixtureNotices } from "./test-support/admit-notices.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Authoritative bounded current state", () => {
  let db: Database,app: ReturnType<typeof createApp>,principal: string,devices: string[];
  const owner = "current-state-owner-abcdefghijklmnopqrstuvwxyz";
  const phones = ["current-state-phone-A-abcdefghijklmnopqrstuvwxyz","current-state-phone-B-abcdefghijklmnopqrstuvwxyz"];
  beforeAll(async () => { db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db); });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");await bootstrapOwner(db,"current-state",owner);
    principal=(await db.query("SELECT id FROM owner_principals WHERE handle='current-state'")).rows[0].id;devices=[];
    for (const token of phones) {
      const id=(await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
        app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization)
        VALUES ($1,$2,$3,'Fixture','com.example.relo.notifications','1','1','27','sandbox','authorized','authorized') RETURNING id`,
        [principal,randomUUID(),randomUUID()])).rows[0].id;
      devices.push(id);await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['inbox:read','interactions:respond'])",[id,hashToken(token)]);
    }
    app=createApp(db,{apnsMode:"disabled"});
  });
  async function current(query="",phone=0) {
    const response=await app.request(`/api/inbox/current${query}`,{headers:{authorization:`Bearer ${phones[phone]}`}});
    const body=await response.json() as any;
    if(response.status===200)currentInboxResponseSchema.parse(body);
    return {status:response.status,body};
  }
  async function mutation(path: string,body: unknown,method="POST") {
    const response=await app.request(path,{method,headers:{authorization:`Bearer ${owner}`,"content-type":"application/json","idempotency-key":randomUUID()},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json() as any};
  }
  async function notices(count: number,age=0,admit=true) {
    const rows=(await db.query(`INSERT INTO notification_events(principal_id,source,title,body,idempotency_key,created_at)
      SELECT $1,'Current fixture','Notice',repeat('x',65536),gen_random_uuid()::text,clock_timestamp()-($3*interval '1 second')
      FROM generate_series(1,$2) RETURNING id`,[principal,count,age])).rows;
    return admit?admitFixtureNotices(db,principal,rows):rows;
  }
  async function subjectOf(eventId: string) {
    return `sub_${(await db.query("SELECT subject_id FROM notification_relevance WHERE notification_event_id=$1",[eventId])).rows[0].subject_id}`;
  }
  async function ask(subjectKey=randomUUID(),generation=1) {
    const result=await mutation("/api/interactions",{type:"yes_no",title:"Decision",prompt:"Continue?",expiresInSeconds:300,
      relevance:{subjectKey,generation,revision:1,operation:"replace",occurredAt:new Date().toISOString(),policy:{kind:"decision",actionSeconds:300}}});
    expect(result.status).toBe(201);
    const subject=(await db.query("SELECT subject_id FROM notification_relevance WHERE notification_event_id=$1",[result.body.eventId.slice(4)])).rows[0].subject_id;
    return {...result.body,subjectId:`sub_${subject}`};
  }
  test("a 50-summary page retains whole-scope actionable counts beyond recent history",async () => {
    const decision=await ask();await notices(250);await notices(5,3600);
    const result=await current();expect(result.status).toBe(200);
    expect(result.body.items).toHaveLength(50);expect(result.body.hasMore).toBe(true);
    expect(result.body.total).toBe(251);expect(result.body.counts).toEqual({actionable:1,currentUnread:251});
    expect(JSON.stringify(result.body).length).toBeLessThan(70_000);
    expect(result.body.items.every((item:any)=>item.body===undefined && item.payload===undefined)).toBe(true);
    const selected=await current(`?id=${decision.subjectId}`);
    expect(selected.body.items).toHaveLength(1);expect(selected.body.items[0].interaction.id).toBe(decision.interaction.id);
    expect(selected.body.total).toBe(251);expect(selected.body.counts.actionable).toBe(1);
    expect(selected.body.hasMore).toBe(false);expect(selected.body.cursor).toBeNull();
  });
  test("a newer revision replaces only its own subject and keeps an independent decision",async () => {
    const first=await ask("same"),independent=await ask("independent"),replacement=await ask("same",2);
    expect(replacement.subjectId).toBe(first.subjectId);
    const result=await current();expect(result.body.total).toBe(2);expect(result.body.counts.actionable).toBe(2);
    const selected=await current(`?id=${first.subjectId}`);
    expect(selected.body.items[0]).toMatchObject({subjectId:first.subjectId,notificationId:replacement.eventId,version:{generation:2,revision:1}});
    expect(result.body.items.map((item:any)=>item.notificationId)).toContain(independent.eventId);
  });
  test("targeted reads report expired and hidden subjects without leaking hidden identity metadata",async () => {
    const decision=await ask();const [visible,hidden]=await notices(2);
    await db.query("UPDATE notification_events SET target_mode='explicit' WHERE id=$1",[hidden.id]);
    await db.query("INSERT INTO notification_event_targets(notification_event_id,device_id) VALUES ($1,$2)",[hidden.id,devices[1]]);
    await db.query("UPDATE interaction_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[decision.interaction.id.slice(4)]);
    const missing=`sub_${randomUUID()}`;
    const hiddenSubject=await subjectOf(hidden.id),visibleSubject=await subjectOf(visible.id);
    const result=await current(`?id=${decision.subjectId}&id=${hiddenSubject}&id=${missing}&id=${visibleSubject}`);
    expect(result.body.total).toBe(1);expect(result.body.counts.actionable).toBe(0);expect(result.body.items).toHaveLength(1);
    expect(result.body.retired).toContainEqual(expect.objectContaining({subjectId:decision.subjectId,reason:"expired"}));
    expect(result.body.retired).toContainEqual({subjectId:hiddenSubject,reason:"not_found"});
    expect(result.body.retired).toContainEqual({subjectId:missing,reason:"not_found"});
    expect(result.body.retired).toHaveLength(3);
  });
  test("pages are scope-bound and continue after their anchor is read and retired",async () => {
    await notices(101);
    const first=await current("?limit=50");expect(first.status).toBe(200);expect(first.body.items).toHaveLength(50);
    const anchor=first.body.items.at(-1).notificationId.slice(4);
    await db.query("UPDATE notification_events SET read_at=clock_timestamp(),expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[anchor]);
    const second=await current(`?limit=50&after=${first.body.cursor}`),third=await current(`?limit=50&after=${second.body.cursor}`);
    expect(second.body.total).toBe(100);expect(second.body.items).toHaveLength(50);expect(third.body.items).toHaveLength(1);
    expect(new Set([...first.body.items,...second.body.items,...third.body.items].map((item:any)=>item.subjectId)).size).toBe(101);
    expect((await current(`?after=${first.body.cursor}`,1)).status).toBe(410);
  });
  test("declared progress freshness becomes stale without deleting the current subject",async () => {
    const [event]=await notices(1,0,false);const tx=await db.connect();
    try {
      await tx.query("BEGIN");
      await applySubjectMutation(tx,{principalId:principal,sourceId:"current-progress"},{eventId:event.id,intentHash:"a".repeat(64),command:{
        subjectKey:"run",generation:1,revision:1,operation:"replace",occurredAt:new Date().toISOString(),
        policy:{kind:"progress",heartbeat:{intervalSeconds:1,lastHeartbeatAt:new Date(Date.now()-5000).toISOString()}},
      }});await tx.query("COMMIT");
    } catch(error) { await tx.query("ROLLBACK");throw error; } finally { tx.release(); }
    const result=await current();expect(result.status).toBe(200);expect(result.body.total).toBe(1);
    expect(result.body.items[0].kind).toBe("progress");expect(result.body.items[0].freshness).toBe("stale");
    expect(result.body.counts.actionable).toBe(0);expect(result.body.nextExpiryAt).toBeNull();
  });
  test("an explicitly persistent incident remains current until canonical resolution",async () => {
    const [event]=await notices(1,3600,false);const tx=await db.connect();
    try {
      await tx.query("BEGIN");
      await applySubjectMutation(tx,{principalId:principal,sourceId:"current-incident"},{eventId:event.id,intentHash:"b".repeat(64),command:{
        subjectKey:"outage",generation:1,revision:1,operation:"replace",occurredAt:new Date(Date.now()-3600_000).toISOString(),
        policy:{kind:"incident",mode:"until_resolved"},
      }});await tx.query("COMMIT");
    } catch(error) { await tx.query("ROLLBACK");throw error; } finally { tx.release(); }
    const result=await current();expect(result.body.total).toBe(1);expect(result.body.items[0].kind).toBe("incident");
    expect(result.body.items[0].currentUntil).toBeNull();expect(result.body.nextExpiryAt).toBeNull();
    await db.query("UPDATE notification_relevance SET relevance=jsonb_set(relevance,'{status}','\"resolved\"') WHERE notification_event_id=$1",[event.id]);
    const resolved=await current(`?id=${result.body.items[0].subjectId}`);
    expect(resolved.body.total).toBe(0);expect(resolved.body.items).toEqual([]);
    expect(resolved.body.retired[0].reason).toBe("resolved");
  });
  test("active informational native cards are current without inventing an action or heartbeat",async () => {
    const base=currentTestPresentation();
    const started=await mutation("/api/live-activities",{presentation:{...base,behavior:{type:"informational"}},deviceIds:[`dev_${devices[0]}`]});
    expect(started.status).toBe(201);
    const result=await current();expect(result.body.total).toBe(1);expect(result.body.counts.actionable).toBe(0);
    expect(result.body.items[0]).toMatchObject({subjectId:started.body.activity.id,kind:"progress",interaction:null,freshness:"unknown",freshUntil:null,occurredAt:null});
  });
  test("one native activity appears once and its terminal state is returned as retirement",async () => {
    const started=await mutation("/api/live-activities",{presentation:currentTestPresentation(),deviceIds:[`dev_${devices[0]}`]});
    expect(started.status,JSON.stringify(started.body)).toBe(201);const id=started.body.activity.id;
    await mutation(`/api/live-activities/${id}`,{presentation:currentTestPresentation("Updated")},"PATCH");
    const result=await current();expect(result.status).toBe(200);expect(result.body.total).toBe(1);
    expect(result.body.items[0]).toMatchObject({subjectId:id,kind:"progress",title:"Updated"});
    expect((await current("",1)).body.total).toBe(0);
    const ended=await mutation(`/api/live-activities/${id}/end`,{});expect(ended.status).toBe(200);
    const retired=await current(`?id=${id}`);expect(retired.body.items).toEqual([]);
    expect(retired.body.retired).toContainEqual(expect.objectContaining({subjectId:id,reason:"ended"}));
    expect(retired.body.total).toBe(0);
  });
  test("private summaries stay private and read state changes current unread without changing total",async () => {
    const [event]=await notices(1);await db.query("UPDATE notification_events SET payload=$2 WHERE id=$1",[event.id,{privacy:"private"}]);
    const first=await current();expect(first.body.items[0].summary).toBe("Private notification");expect(first.body.counts.currentUnread).toBe(1);
    await db.query("UPDATE notification_events SET read_at=clock_timestamp() WHERE id=$1",[event.id]);
    const second=await current();expect(second.body.total).toBe(1);expect(second.body.counts.currentUnread).toBe(0);
    expect(second.body.items[0].readAt).not.toBeNull();
  });
  test("historical private native decisions redact status, use parent resources and agree with badge and pending inventory",async () => {
    const base=currentTestPresentation("Private decision","Private fixture body");
    const presentation={...base,behavior:{type:"yes_no",primary:{action:"yes",label:"Yes"},secondary:{action:"no",label:"No"}}};
    const started=await mutation("/api/live-activities",{presentation,deviceIds:[`dev_${devices[0]}`]});
    expect(started.status,JSON.stringify(started.body)).toBe(201);
    // Current admission sanitizes private native presentations to informational.
    // Historical private decision rows must nevertheless never leak their status.
    await db.query("UPDATE live_activities SET privacy='private' WHERE id=$1",[started.body.activity.id.slice(4)]);
    const result=await current();expect(result.body.total).toBe(1);expect(result.body.counts.actionable).toBe(1);
    expect(result.body.items[0].kind).toBe("decision");expect(result.body.items[0].summary).toBe("Private notification");
    expect(result.body.items[0].activity.status).toBeNull();expect(result.body.items[0].resources.project.id).toMatch(/^prj_/);
    expect(JSON.stringify(result.body)).not.toContain("Private fixture body");
    const pending=await app.request("/api/inbox/pending",{headers:{authorization:`Bearer ${phones[0]}`}});
    expect((await pending.json() as any).total).toBe(1);expect(await pendingInteractionBadgeCount(db,devices[0]!)).toBe(1);
    expect((await current("",1)).body.total).toBe(0);
  });
  test("native decision summaries show the original question when the notification body is empty",async () => {
    const base=currentTestPresentation("Approval","Deploy this exact revision?");
    const presentation={...base,behavior:{type:"yes_no",primary:{action:"yes",label:"Yes"},secondary:{action:"no",label:"No"}}};
    const started=await mutation("/api/live-activities",{presentation,deviceIds:[`dev_${devices[0]}`]});
    expect(started.status).toBe(201);
    expect((await current()).body.items[0].summary).toBe("Deploy this exact revision?");
    const pending=await app.request("/api/inbox/pending",{headers:{authorization:`Bearer ${phones[0]}`}});
    expect((await pending.json() as any).items[0].summary).toBe("Deploy this exact revision?");
  });
  test("native details bind to the current sequence even when an older event has a later timestamp",async () => {
    const started=await mutation("/api/live-activities",{presentation:currentTestPresentation(),deviceIds:[`dev_${devices[0]}`]});
    expect(started.status).toBe(201);const id=started.body.activity.id;
    const old=(await current()).body.items[0].notificationId;
    await mutation(`/api/live-activities/${id}`,{presentation:currentTestPresentation("Next state")},"PATCH");
    await db.query("UPDATE notification_events SET created_at=clock_timestamp()+interval '1 minute' WHERE id=$1",[old.slice(4)]);
    const next=await current();expect(next.body.items[0].notificationId).not.toBe(old);expect(next.body.items[0].title).toBe("Next state");
    expect(next.body.items[0].occurredAt).toBeNull();expect(next.body.items[0].freshness).toBe("unknown");
  });
  test("next expiry remains whole-scope in targeted mode and native text respects scalar bounds",async () => {
    const decision=await ask();const [event]=await notices(1);
    const deadline=new Date(Date.now()+20_000).toISOString();
    await db.query("UPDATE notification_events SET expires_at=$2,title=$3,body=$4 WHERE id=$1",[event.id,deadline,"🟢".repeat(200),"🟠".repeat(500)]);
    const result=await current(`?id=${decision.subjectId}`);expect(result.body.nextExpiryAt).toBe(deadline);
    expect(result.body.counts).toEqual({actionable:1,currentUnread:2});
    const selected=await current(`?id=${await subjectOf(event.id)}`);expect(Array.from(selected.body.items[0].summary)).toHaveLength(240);
  });
  test("anonymous, unauthorized and revoked credentials cannot read current state",async () => {
    await notices(1);expect((await app.request("/api/inbox/current")).status).toBe(401);
    await db.query("UPDATE device_credentials SET scopes=ARRAY['interactions:respond'] WHERE device_id=$1",[devices[0]]);
    expect((await current()).status).toBe(403);
    await db.query("UPDATE device_credentials SET scopes=ARRAY['inbox:read'],revoked_at=clock_timestamp() WHERE device_id=$1",[devices[0]]);
    expect((await current()).status).toBe(401);
  });
  test.each(["?limit=0","?limit=51","?limit=1e1","?limit=","?id=invalid","?id=act_not-a-uuid"])("rejects invalid queries %s",async query=>{
    expect((await current(query)).status).toBe(400);
  });
  test("rejects oversized target sets and mixed pagination; deduplicates targets",async () => {
    const ids=Array.from({length:51},()=>`id=ntf_${randomUUID()}`);expect((await current(`?${ids.join("&")}`)).status).toBe(400);
    expect((await current(`?id=ntf_${randomUUID()}&after=invalid`)).status).toBe(400);
    const [row]=await notices(1);const subject=await subjectOf(row.id);const result=await current(`?id=${subject}&id=${subject}`);
    expect(result.body.items).toHaveLength(1);expect(result.body.retired).toHaveLength(0);
    expect((await current("?after=invalid")).status).toBe(410);
  });
});
