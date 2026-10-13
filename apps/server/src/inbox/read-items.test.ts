import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { inboxReadItemsResponseSchema } from "@relo/notification-contracts";
import { createApp } from "../app.js";
import { bootstrapOwner } from "../bootstrap.js";
import { hashToken } from "../auth.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";

(process.env.TEST_DATABASE_URL ? describe : describe.skip)("Scoped exact read batches",()=>{
  let db: Database,app: ReturnType<typeof createApp>,principal:string,devices:string[];
  const owner="read-items-owner-abcdefghijklmnopqrstuvwxyz";
  const phones=["read-items-phone-A-abcdefghijklmnopqrstuvwxyz","read-items-phone-B-abcdefghijklmnopqrstuvwxyz"];
  beforeAll(async()=>{db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);});
  afterAll(async()=>{await db.end();});
  beforeEach(async()=>{
    await db.query("TRUNCATE owner_principals CASCADE");await bootstrapOwner(db,"read-items",owner);
    principal=(await db.query("SELECT id FROM owner_principals WHERE handle='read-items'")).rows[0].id;devices=[];
    for(const token of phones){
      const id=(await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
        app_version,app_build,os_version,apns_environment,notification_authorization)
        VALUES ($1,$2,$3,'Read fixture','com.example.relo.notifications','1','1','27','sandbox','authorized') RETURNING id`,
      [principal,randomUUID(),randomUUID()])).rows[0].id;
      devices.push(id);await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['inbox:read'])",[id,hashToken(token)]);
    }
    app=createApp(db,{apnsMode:"disabled"});
  });
  const request=(body:unknown,token=phones[0])=>app.request("/api/inbox/read-items",{method:"POST",
    headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});
  async function seed(count=1,device?:string,ownerId=principal){
    const rows=(await db.query(`INSERT INTO notification_events(principal_id,source,title,body,idempotency_key,target_mode)
      SELECT $1,'Read fixture','Exact read','Content',gen_random_uuid()::text,$3 FROM generate_series(1,$2) RETURNING id`,
    [ownerId,count,device ? "explicit":"broadcast"])).rows;
    if(device) for(const row of rows) await db.query("INSERT INTO notification_event_targets(notification_event_id,device_id) VALUES ($1,$2)",[row.id,device]);
    return rows.map(row=>`ntf_${row.id}` as string);
  }
  async function mark(ids:string[],token=phones[0]){
    const response=await request({notificationIds:ids},token);expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");return inboxReadItemsResponseSchema.parse(await response.json());
  }
  test("marks only captured IDs; duplicates coalesce, later arrivals remain unread, retries do not write",async()=>{
    const captured=await seed(2),later=await seed();
    const result=await mark([captured[0]!,captured[0]!,captured[1]!]);
    expect(result.results).toEqual(captured.map(notificationId=>({notificationId,outcome:"read"})));
    expect(result.unread.account).toBe(1);
    const before=(await db.query("SELECT id,read_at,updated_at FROM notification_events ORDER BY id")).rows;
    expect((await mark(captured)).results).toEqual(captured.map(notificationId=>({notificationId,outcome:"already_read"})));
    expect((await db.query("SELECT id,read_at,updated_at FROM notification_events ORDER BY id")).rows).toEqual(before);
    expect(before.find(row=>`ntf_${row.id}`===later[0]).read_at).toBeNull();
    expect((await db.query("SELECT (SELECT count(*) FROM delivery_jobs)::int AS jobs,(SELECT count(*) FROM interactions)::int AS receipts")).rows[0]).toEqual({jobs:0,receipts:0});
  });
  test("hidden, foreign and absent IDs are indistinguishable and cannot mutate another phone's exclusive item",async()=>{
    const own=await seed(1,devices[0]),hidden=await seed(1,devices[1]);
    const foreignOwner=(await db.query("INSERT INTO owner_principals(handle) VALUES ('foreign') RETURNING id")).rows[0].id;
    const foreign=await seed(1,undefined,foreignOwner),absent=`ntf_${randomUUID()}`;
    const result=await mark([...own,...hidden,...foreign,absent]);
    expect(result.results.map(value=>value.outcome)).toEqual(["read","not_found","not_found","not_found"]);
    expect(result.unread.account).toBe(0);
    expect((await mark(hidden,phones[1])).results[0]!.outcome).toBe("read");
    expect((await db.query("SELECT read_at FROM notification_events WHERE id=$1",[foreign[0]!.slice(4)])).rows[0].read_at).toBeNull();
  });
  test("concurrent retries have exactly one read winner",async()=>{
    const ids=await seed();
    const results=await Promise.all([mark(ids),mark(ids)]);
    expect(results.map(value=>value.results[0]!.outcome).sort()).toEqual(["already_read","read"]);
    expect(results.map(value=>value.unread.account)).toEqual([0,0]);
  });
  test("250 exact IDs work while invalid, oversized and authority-widening inputs fail before mutation",async()=>{
    const ids=await seed(251);
    for(const body of [{notificationIds:[]},{notificationIds:ids},{notificationIds:["ntf_not-a-uuid"]},
      {notificationIds:[ids[0]],watermark:"all"},{notificationIds:[ids[0]],principalId:randomUUID()}]) {
      expect((await request(body)).status).toBe(400);
    }
    expect((await db.query("SELECT count(*)::int AS count FROM notification_events WHERE read_at IS NOT NULL")).rows[0].count).toBe(0);
    const result=await mark(ids.slice(0,250));expect(result.results).toHaveLength(250);expect(result.unread.account).toBe(1);
  });
  test("anonymous, owner without inbox scope and revoked device credentials cannot replay a queue",async()=>{
    const ids=await seed();
    expect((await request({notificationIds:ids},"missing")).status).toBe(401);
    expect((await request({notificationIds:ids},owner)).status).toBe(403);
    await db.query("UPDATE devices SET revoked_at=clock_timestamp() WHERE id=$1",[devices[0]]);
    expect((await request({notificationIds:ids})).status).toBe(401);
    expect((await db.query("SELECT read_at FROM notification_events WHERE id=$1",[ids[0]!.slice(4)])).rows[0].read_at).toBeNull();
  });
});
