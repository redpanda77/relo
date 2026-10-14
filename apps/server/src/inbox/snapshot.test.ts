import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { inboxSnapshotResponseSchema } from "@relo/notification-contracts";
import { createApp } from "../app.js";
import { bootstrapOwner } from "../bootstrap.js";
import { hashToken } from "../auth.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { loadInboxSnapshot } from "./queries.js";
import { createNotificationContentCipher,persistNotificationContent,prepareNotificationContent } from "../notification-content.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Bounded authoritative history repair", () => {
  let db: Database, app: ReturnType<typeof createApp>, principal: string, devices: string[];
  const owner = "history-repair-owner-abcdefghijklmnopqrstuvwxyz";
  const phones = ["history-repair-phone-A-abcdefghijklmnopqrstuvwxyz", "history-repair-phone-B-abcdefghijklmnopqrstuvwxyz"];
  beforeAll(async () => { db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db); });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");await bootstrapOwner(db,"history-repair",owner);
    principal=(await db.query("SELECT id FROM owner_principals WHERE handle='history-repair'")).rows[0].id;devices=[];
    for (const token of phones) {
      const id=(await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
        app_version,app_build,os_version,apns_environment,notification_authorization)
        VALUES ($1,$2,$3,'Fixture','com.example.relo.notifications','1','1','27','sandbox','authorized') RETURNING id`,
        [principal,randomUUID(),randomUUID()])).rows[0].id;
      devices.push(id);await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['inbox:read'])",[id,hashToken(token)]);
    }
    app=createApp(db,{apnsMode:"disabled"});
  });
  async function snapshot(phone=0) {
    const response=await app.request("/api/inbox/snapshot",{headers:{authorization:`Bearer ${phones[phone]}`}});
    expect(response.status).toBe(200);
    return inboxSnapshotResponseSchema.parse(await response.json());
  }
  async function seed(count: number, body="Short body") {
    return (await db.query(`INSERT INTO notification_events(principal_id,source,title,body,idempotency_key)
      SELECT $1,'Fixture','History event',$3,gen_random_uuid()::text FROM generate_series(1,$2) RETURNING id`,[principal,count,body])).rows as {id:string}[];
  }

  test("a late commit is recovered by the next snapshot",async () => {
    const a=await db.connect();
    try {
      await a.query("BEGIN");
      const early=(await a.query("SELECT now() AS at")).rows[0].at;
      // Awaiting these operations is the explicit commit barrier: B commits while A remains open.
      const [b]=await seed(1);
      const before=await snapshot();expect(before.items.map(item=>item.id)).toEqual([`ntf_${b!.id}`]);
      const late=(await a.query(`INSERT INTO notification_events(principal_id,source,title,body,idempotency_key)
        VALUES ($1,'A','Late commit','Still visible',gen_random_uuid()::text) RETURNING id,created_at`,[principal])).rows[0];
      expect(late.created_at).toEqual(early);
      await a.query("COMMIT");
      const repaired=await snapshot();expect(repaired.items.map(item=>item.id)).toContain(`ntf_${late.id}`);
      expect(repaired.total).toBe(2);expect(repaired.unread.account).toBe(2);
    } finally { await a.query("ROLLBACK");a.release(); }
  });

  test("a server notice linking a screen in the app, or a stored link the contract rejects, never fails the snapshot",async () => {
    await db.query(`INSERT INTO notification_events(principal_id,source,title,body,idempotency_key,deep_link)
      VALUES ($1,'Relo','A new phone wants your encrypted messages','Approve it',gen_random_uuid()::text,'relo://settings/security'),
             ($1,'Fixture','Old link','Body',gen_random_uuid()::text,'http://example.com/plain')`,[principal]);
    const result=await snapshot();
    expect(result.items.map(item=>item.destinationUrl).sort()).toEqual([null,"relo://settings/security"]);
  });

  test("251 rows repair to exactly 250 summaries and preserve whole-scope unread totals",async () => {
    await seed(251,"x".repeat(65_536));
    const result=await snapshot();
    expect(result.items).toHaveLength(250);expect(result.total).toBe(251);expect(result.unread.account).toBe(251);
    expect(result.items.every(item=>item.contentSummary.byteLength===65_536 && item.contentSummary.summary.length===240)).toBe(true);
    const encoded=JSON.stringify(result);
    expect(encoded.length).toBeLessThan(400_000);expect(encoded).not.toContain("x".repeat(241));
    expect(result.items.every(item=>!("detail" in item) && !("content" in item) && !("liveActivity" in item))).toBe(true);
    const detail=await app.request(`/api/inbox/${result.items[0]!.id}`,{headers:{authorization:`Bearer ${phones[0]}`}});
    expect(detail.status).toBe(200);expect((await detail.json() as any).item.detail).toBe("x".repeat(65_536));
  });

  test("the next repair replaces changed rows, preserves withdrawal evidence and removes pruned history",async () => {
    const [first,second]=await seed(2);
    await snapshot();
    await db.query("UPDATE notification_events SET title='Edited',body='Changed summary',read_at=now() WHERE id=$1",[first!.id]);
    await db.query("UPDATE notification_events SET withdrawn_at=now(),withdrawn_by_kind='credential',withdrawn_by_id=$2 WHERE id=$1",[second!.id,randomUUID()]);
    const repaired=await snapshot();
    expect(repaired.items.find(item=>item.id===`ntf_${first!.id}`)).toMatchObject({title:"Edited",contentSummary:{summary:"Changed summary"}});
    expect(repaired.items.find(item=>item.id===`ntf_${second!.id}`)?.withdrawnAt).not.toBeNull();
    expect(repaired.unread.account).toBe(0);
    await db.query("DELETE FROM notification_events WHERE id=$1",[first!.id]);
    expect((await snapshot()).items.map(item=>item.id)).toEqual([`ntf_${second!.id}`]);
  });

  test("exclusive targets scope rows and metadata together; revoked devices cannot read",async () => {
    const [exclusive]=await seed(1);
    await db.query("UPDATE notification_events SET target_mode='explicit' WHERE id=$1",[exclusive!.id]);
    await db.query("INSERT INTO notification_event_targets(notification_event_id,device_id) VALUES ($1,$2)",[exclusive!.id,devices[0]]);
    expect((await snapshot()).unread.account).toBe(1);
    expect(await snapshot(1)).toMatchObject({items:[],total:0,unread:{account:0,projects:{}}});
    expect((await app.request("/api/inbox/snapshot")).status).toBe(401);
    await db.query("UPDATE devices SET revoked_at=now() WHERE id=$1",[devices[0]]);
    expect((await app.request("/api/inbox/snapshot",{headers:{authorization:`Bearer ${phones[0]}`}})).status).toBe(401);
  });

  test("list metadata never decrypts or selects an encrypted full body",async () => {
    const [event]=await seed(1,"Preview");
    const client=await db.connect();
    try {
      await persistNotificationContent(client,
        createNotificationContentCipher("relo-test-notification-content-secret-v1"),event!.id,
        prepareNotificationContent({body:"Secret large body".repeat(1000),summary:"Small stored summary"}));
    } finally { client.release(); }
    const result=await snapshot();
    expect(result.items[0]!.contentSummary.summary).toBe("Small stored summary");
    expect(JSON.stringify(result)).not.toContain("Secret large body");
    expect(JSON.stringify(result)).not.toContain("body_ciphertext");
    const detail=await app.request(`/api/inbox/${result.items[0]!.id}`,{headers:{authorization:`Bearer ${phones[0]}`}});
    expect(detail.status).toBe(200);expect((await detail.json() as any).item.content.body).toBe("Secret large body".repeat(1000));
  });

  test("rows and unread counts keep one snapshot even if a writer commits before response publication",async () => {
    const [event]=await seed(1);
    const writer=await db.connect();let queries=0;
    try {
      await writer.query("BEGIN");
      await writer.query("UPDATE notification_events SET title='After commit',read_at=now() WHERE id=$1",[event!.id]);
      const original=db.query.bind(db);
      const observed=Object.create(db) as Database;
      observed.query=(async (sql: string, values: unknown[]) => {
        const result=await original(sql,values);
        if (++queries===1) await writer.query("COMMIT");
        return result;
      }) as typeof db.query;
      const before=await loadInboxSnapshot(observed,{principalId:principal,deviceId:devices[0]!});
      expect(queries).toBe(1);expect(before.items[0]!.title).toBe("History event");
      expect(before.items[0]!.readAt).toBeNull();expect(before.unread.account).toBe(1);
      const after=await snapshot();expect(after.items[0]!.title).toBe("After commit");expect(after.unread.account).toBe(0);
    } finally { await writer.query("ROLLBACK");writer.release(); }
  });

  test("a held history query does not serialize current reads",async () => {
    await seed(1);
    const lock=await db.connect();
    try {
      await lock.query("BEGIN");
      // Hold only receipt evidence; current summaries do not read receipt history.
      await lock.query("LOCK TABLE interactions IN ACCESS EXCLUSIVE MODE");
      const history=loadInboxSnapshot(db,{principalId:principal,deviceId:devices[0]!});
      const current=await app.request("/api/inbox/current",{headers:{authorization:`Bearer ${phones[0]}`}});
      expect(current.status).toBe(200);
      await lock.query("COMMIT");
      expect((await history).items).toHaveLength(1);
    } finally { await lock.query("ROLLBACK");lock.release(); }
  });
});

suite("Inbox origin labels", () => {
  let db: Database, app: ReturnType<typeof createApp>, principal: string;
  const owner = "origin-label-owner-abcdefghijklmnopqrstuvwxyz";
  const phone = "origin-label-phone-abcdefghijklmnopqrstuvwxyz";
  beforeAll(async () => { db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db); });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");await bootstrapOwner(db,"origin-label",owner);
    principal=(await db.query("SELECT id FROM owner_principals WHERE handle='origin-label'")).rows[0].id;
    const id=(await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization)
      VALUES ($1,$2,$3,'Fixture','com.example.relo.notifications','1','1','27','sandbox','authorized') RETURNING id`,
      [principal,randomUUID(),randomUUID()])).rows[0].id;
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['inbox:read'])",[id,hashToken(phone)]);
    app=createApp(db,{apnsMode:"disabled"});
  });
  async function eventFor(label: string, context: Record<string,string>) {
    const key=(await db.query(`INSERT INTO principal_api_keys(principal_id,label,token_hash) VALUES ($1,$2,$3) RETURNING id`,
      [principal,label,hashToken(randomUUID()+randomUUID())])).rows[0].id;
    await db.query(`INSERT INTO notification_events(principal_id,requester_credential_id,source,title,body,idempotency_key,payload)
      VALUES ($1,$2,'Fixture',$3,'b',gen_random_uuid()::text,$4)`,[principal,key,label,{ context }]);
  }
  test("computer and account come only from the card's context, never from the login name",async () => {
    await eventFor("Studio Mac",{ project: "Relo" });
    await eventFor("Relo CLI",{ project: "Relo" });
    await eventFor("Laptop",{ project: "Relo",computer: "Explicit",account: "personal" });
    const response=await app.request("/api/inbox/snapshot",{headers:{authorization:`Bearer ${phone}`}});
    expect(response.status).toBe(200);
    const items=inboxSnapshotResponseSchema.parse(await response.json()).items;
    const byTitle=Object.fromEntries(items.map(item=>[item.title,item.context]));
    // Login names are not machine names ("Codex CLI"), so they never stand in for one.
    expect(byTitle["Studio Mac"]?.computer).toBeUndefined();
    expect(byTitle["Relo CLI"]?.computer).toBeUndefined();
    expect(byTitle["Laptop"]).toMatchObject({ computer: "Explicit",account: "personal" });
  });
});
