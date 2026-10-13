import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { pendingInteractionBadgeCount } from "./badge.js";
import { currentTestPresentation } from "./test-current-presentation.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Pending action inventory independent of recent history", () => {
  let db: Database, app: ReturnType<typeof createApp>, principal: string, devices: string[];
  const owner = "pending-inventory-owner-abcdefghijklmnopqrstuvwxyz";
  const phones = ["pending-inventory-phone-A-abcdefghijklmnopqrstuvwxyz", "pending-inventory-phone-B-abcdefghijklmnopqrstuvwxyz"];
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE"); await bootstrapOwner(db,"inventory",owner);
    principal = (await db.query("SELECT id FROM owner_principals WHERE handle='inventory'")).rows[0].id;
    devices = [];
    for (const token of phones) {
      const device = (await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
        app_version,app_build,os_version,apns_environment,notification_authorization)
        VALUES ($1,$2,$3,'Fixture','com.example.relo.notifications','1','1','27','sandbox','authorized') RETURNING id`,
        [principal,randomUUID(),randomUUID()])).rows[0].id;
      devices.push(device);
      await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['inbox:read','interactions:respond'])",[device,hashToken(token)]);
    }
    app = createApp(db,{apnsMode:"disabled"});
  });
  async function page(query = "", phone = 0) {
    const response = await app.request(`/api/inbox/pending${query}`,{headers:{authorization:`Bearer ${phones[phone]}`}});
    return {status:response.status,body:await response.json() as any};
  }
  async function seed(count: number) {
    return (await db.query(`WITH events AS (
      INSERT INTO notification_events(principal_id,source,kind,title,body,idempotency_key)
      SELECT $1,'Fixture','question','Still valid',repeat('x',65536),gen_random_uuid()::text FROM generate_series(1,$2)
      RETURNING id
    ) INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at)
      SELECT $1,id,'yes_no',repeat('p',65536),gen_random_uuid()::text,now()+interval '15 minutes' FROM events
      RETURNING id,notification_event_id,expires_at`,[principal,count])).rows;
  }
  test("a valid decision survives 250 newer unrelated events and summaries omit full content", async () => {
    const [decision] = await seed(1);
    await db.query(`INSERT INTO notification_events(principal_id,source,title,body,idempotency_key)
      SELECT $1,'Fixture','Unrelated','Notice',gen_random_uuid()::text FROM generate_series(1,250)`,[principal]);
    const result = await page();
    expect(result.status).toBe(200); expect(result.body.total).toBe(1);
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0].notificationId).toBe(`ntf_${decision.notification_event_id}`);
    expect(result.body.items[0].interaction.id).toBe(`int_${decision.id}`);
    expect(JSON.stringify(result.body).length).toBeLessThan(2_500);
    expect(await pendingInteractionBadgeCount(db,devices[0]!)).toBe(1);
    await db.query("UPDATE interaction_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[decision.id]);
    expect((await page()).body.total).toBe(0);
    expect(await pendingInteractionBadgeCount(db,devices[0]!)).toBe(0);
  });
  test("all 101 decisions remain reachable after the cursor anchor is answered", async () => {
    await seed(101);
    const first = await page("?limit=50"); expect(first.status).toBe(200);
    expect(first.body.total).toBe(101); expect(first.body.items).toHaveLength(50); expect(first.body.hasMore).toBe(true);
    const anchor = first.body.items.at(-1).interaction.id.slice(4);
    await db.query("UPDATE interaction_requests SET state='yes',responded_at=now() WHERE id=$1",[anchor]);
    const second = await page(`?limit=50&after=${first.body.cursor}`);
    const third = await page(`?limit=50&after=${second.body.cursor}`);
    expect(second.body.total).toBe(100); expect(second.body.items).toHaveLength(50);
    expect(third.body.items).toHaveLength(1); expect(third.body.hasMore).toBe(false); expect(third.body.cursor).toBeNull();
    const ids = [...first.body.items,...second.body.items,...third.body.items].map(item=>item.interaction.id);
    expect(new Set(ids).size).toBe(101);
    expect((await page(`?after=${first.body.cursor}`,1)).status).toBe(410);
  });
  test("device-exclusive, withdrawn, answered and expired requests agree with badge count", async () => {
    const rows = await seed(4);
    await db.query("UPDATE notification_events SET target_mode='explicit' WHERE id=$1",[rows[0].notification_event_id]);
    await db.query("INSERT INTO notification_event_targets(notification_event_id,device_id) VALUES ($1,$2)",[rows[0].notification_event_id,devices[0]]);
    await db.query("UPDATE notification_events SET withdrawn_at=now(),withdrawn_by_kind='credential',withdrawn_by_id=$2 WHERE id=$1",
      [rows[1].notification_event_id,randomUUID()]);
    await db.query("UPDATE interaction_requests SET state='yes',responded_at=now() WHERE id=$1",[rows[2].id]);
    await db.query("UPDATE interaction_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[rows[3].id]);
    expect((await page()).body.total).toBe(1); expect((await page("",1)).body.total).toBe(0);
    expect(await pendingInteractionBadgeCount(db,devices[0]!)).toBe(1);
    expect(await pendingInteractionBadgeCount(db,devices[1]!)).toBe(0);
  });
  test.each(["0","101","-1","1.5","1e2",""])("rejects invalid limit %s",async limit => {
    expect((await page(`?limit=${limit}`)).status).toBe(400);
  });
  test("rejects malformed or foreign-format cursors before querying a page",async () => {
    expect((await page("?after=garbage")).status).toBe(410);
    expect((await page(`?after=${Buffer.from(JSON.stringify([new Date().toISOString(),randomUUID()])).toString("base64url")}`)).status).toBe(410);
  });
  test("canonical head replacement and settlement hide pending rows without cleanup",async () => {
    const response = await app.request("/api/interactions",{method:"POST",headers:{
      authorization:`Bearer ${owner}`,"content-type":"application/json","idempotency-key":randomUUID(),
    },body:JSON.stringify({type:"yes_no",title:"Exact decision",prompt:"Ship?",expiresInSeconds:300})});
    expect(response.status).toBe(201);
    const body = await response.json() as any;
    const event = body.eventId.slice(4);
    const initial = await page(); expect(initial.body.total).toBe(1);
    expect(initial.body.items[0].version).toEqual({generation:1,revision:1});
    // Alert delivery expiry does not end the decision's useful life.
    await db.query("UPDATE notification_relevance SET deliver_until=now()-interval '1 second' WHERE notification_event_id=$1",[event]);
    expect((await page()).body.total).toBe(1); expect(await pendingInteractionBadgeCount(db,devices[0]!)).toBe(1);
    await db.query("UPDATE relevance_subjects SET revision=revision+1 WHERE current_event_id=$1",[event]);
    expect((await page()).body.total).toBe(0); expect(await pendingInteractionBadgeCount(db,devices[0]!)).toBe(0);
    await db.query("UPDATE relevance_subjects SET revision=revision-1 WHERE current_event_id=$1",[event]);
    await db.query("UPDATE notification_relevance SET relevance=jsonb_set(relevance,'{status}','\"settled\"') WHERE notification_event_id=$1",[event]);
    expect((await page()).body.total).toBe(0); expect(await pendingInteractionBadgeCount(db,devices[0]!)).toBe(0);
    expect((await db.query("SELECT state FROM interaction_requests WHERE notification_event_id=$1",[event])).rows[0].state).toBe("pending");
  });
  test("native decisions require a live parent in the original generation",async () => {
    const [row] = await seed(1);
    const started = await app.request("/api/live-activities",{method:"POST",headers:{
      authorization:`Bearer ${owner}`,"content-type":"application/json","idempotency-key":randomUUID(),
    },body:JSON.stringify({presentation:currentTestPresentation(),expiresInSeconds:300})});
    expect(started.status).toBe(201);
    const activity = (await started.json() as any).activity.id.slice(4);
    await db.query("UPDATE notification_events SET kind='live_activity',payload=$2 WHERE id=$1",
      [row.notification_event_id,{liveActivity:{activityId:`act_${activity}`,generation:1}}]);
    expect((await page()).body.total).toBe(1); expect(await pendingInteractionBadgeCount(db,devices[0]!)).toBe(1);
    await db.query("UPDATE live_activities SET generation=2 WHERE id=$1",[activity]);
    expect((await page()).body.total).toBe(0); expect(await pendingInteractionBadgeCount(db,devices[0]!)).toBe(0);
    await db.query("UPDATE live_activities SET generation=1,state='ended' WHERE id=$1",[activity]);
    expect((await page()).body.total).toBe(0); expect(await pendingInteractionBadgeCount(db,devices[0]!)).toBe(0);
    await db.query("UPDATE live_activities SET state='active',stale_at=NULL,expires_at=now()-interval '1 second' WHERE id=$1",[activity]);
    expect((await page()).body.total).toBe(0); expect(await pendingInteractionBadgeCount(db,devices[0]!)).toBe(0);
    await db.query("UPDATE notification_events SET payload=$2 WHERE id=$1",[row.notification_event_id,
      {liveActivity:{activityId:`act_${"-".repeat(36)}`,generation:1}}]);
    expect((await page()).status).toBe(200); expect((await page()).body.total).toBe(0);
  });
  test("expiry metadata uses the earliest effective deadline; private content remains private",async () => {
    const rows = await seed(2);
    const deadline = new Date(Date.now()+60_000).toISOString();
    await db.query("UPDATE notification_events SET expires_at=$2,payload=$3 WHERE id=$1",
      [rows[0].notification_event_id,deadline,{privacy:"private"}]);
    const result = await page("?limit=1");
    expect(result.body.total).toBe(2); expect(result.body.items).toHaveLength(1);
    expect(result.body.nextExpiryAt).toBe(deadline);
    expect(new Date(result.body.serverTime).getTime()).toBeLessThan(new Date(deadline).getTime());
    const full = await page();
    expect(full.body.items.find((item:any)=>item.notificationId===`ntf_${rows[0].notification_event_id}`).summary).toBe("Private notification");
    await db.query("UPDATE interaction_requests SET state='yes',responded_at=now()");
    expect((await page()).body).toMatchObject({items:[],total:0,nextExpiryAt:null,hasMore:false,cursor:null});
  });
  test("microsecond ties paginate exactly, and reload discovers earlier late commits",async () => {
    const rows = await seed(3);
    const base = new Date(Date.now()+60_000).toISOString().slice(0,-5);
    for (let i=0;i<rows.length;i++) {
      await db.query("UPDATE interaction_requests SET expires_at=$2 WHERE id=$1",[rows[i].id,`${base}.12300${i+1}Z`]);
    }
    const first = await page("?limit=1");
    expect(first.body.items[0].interaction.id).toBe(`int_${rows[0].id}`);
    const second = await page(`?limit=1&after=${first.body.cursor}`);
    expect(second.body.items[0].interaction.id).toBe(`int_${rows[1].id}`);
    const third = await page(`?limit=1&after=${second.body.cursor}`);
    expect(third.body.items[0].interaction.id).toBe(`int_${rows[2].id}`);
    const [late] = await seed(1);
    await db.query("UPDATE interaction_requests SET expires_at=$2 WHERE id=$1",[late.id,`${base}.122999Z`]);
    expect((await page("?limit=1")).body.items[0].interaction.id).toBe(`int_${late.id}`);
  });
  test("authorization, revocation and principal isolation apply to inventory and badge",async () => {
    await seed(1);
    expect((await app.request("/api/inbox/pending")).status).toBe(401);
    await db.query("UPDATE device_credentials SET scopes=ARRAY['interactions:respond'] WHERE device_id=$1",[devices[0]]);
    expect((await page()).status).toBe(403);
    await db.query("UPDATE device_credentials SET scopes=ARRAY['inbox:read'] WHERE device_id=$1",[devices[0]]);
    await db.query("UPDATE devices SET revoked_at=now() WHERE id=$1",[devices[0]]);
    expect((await page()).status).toBe(401); expect(await pendingInteractionBadgeCount(db,devices[0]!)).toBe(0);
    const other = "other-inventory-owner-abcdefghijklmnopqrstuvwxyz";
    await bootstrapOwner(db,"other-inventory",other);
    await db.query("UPDATE principal_api_keys SET scopes=array_append(scopes,'inbox:read') WHERE token_hash=$1",[hashToken(other)]);
    const response = await app.request("/api/inbox/pending",{headers:{authorization:`Bearer ${other}`}});
    expect(response.status).toBe(200); expect((await response.json() as any).total).toBe(0);
  });
});
