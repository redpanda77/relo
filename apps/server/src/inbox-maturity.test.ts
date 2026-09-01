import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";

describe("0036 Inbox maturity contract",() => {
  test("pins encryption, account read state, withdrawal evidence, and append-only enforcement",async () => {
    const sql = await readFile(new URL("../migrations/0036_inbox_maturity.sql",import.meta.url),"utf8");
    expect(sql).toContain("notification_contents");
    expect(sql).toContain("body_bytes BETWEEN 1 AND 65536");
    expect(sql).toContain("notification_events_unread_idx");
    expect(sql).toContain("UNIQUE NULLS NOT DISTINCT");
    expect(sql).toContain("notification_withdrawal_evidence_no_update");
    expect(sql).not.toContain("body_ciphertext text NOT NULL DEFAULT");
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseSuite = databaseUrl ? describe : describe.skip;

databaseSuite("Inbox maturity PostgreSQL and API behavior",() => {
  let db: Database;
  const ownerToken = "inbox_owner_abcdefghijklmnopqrstuvwxyz_0123456789";
  const otherToken = "inbox_other_abcdefghijklmnopqrstuvwxyz_0123456789";
  const deviceToken = "inbox_device_abcdefghijklmnopqrstuvwxyz_0123456789";
  const encryptionSecret = "inbox-test-purpose-secret-with-at-least-32-characters";

  beforeAll(async () => {
    db=createDatabase(databaseUrl!);
    await migrate(db);
  });
  beforeEach(async () => {
    await db.query("TRUNCATE interactions,delivery_jobs,notification_events,device_credentials,devices,principal_api_keys,owner_principals CASCADE");
    await bootstrapOwner(db,"inbox-owner",ownerToken);
    await bootstrapOwner(db,"inbox-other",otherToken);
    const principal = (await db.query<{ id:string }>(
      "SELECT principal_id AS id FROM principal_api_keys WHERE token_hash=$1",[hashToken(ownerToken)],
    )).rows[0]!.id;
    const device = (await db.query<{ id:string }>(
      `INSERT INTO devices(
         principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
         os_version,apns_environment,notification_authorization,live_activity_authorization
       ) VALUES ($1,$2,$3,'Inbox phone','com.example.relo.notifications','0.9.0','12','26.0',
         'sandbox','authorized','authorized') RETURNING id`,
      [principal,`stable-${randomUUID()}`,randomUUID()],
    )).rows[0]!.id;
    await db.query(
      `INSERT INTO device_credentials(device_id,token_hash,scopes)
       VALUES ($1,$2,ARRAY['inbox:read'])`,[device,hashToken(deviceToken)],
    );
  });
  afterAll(async () => db.end());

  const request = (path:string,token:string,init:RequestInit={}) => createApp(db,{
    apnsMode:"disabled",credentialDerivationSecret:encryptionSecret,
  }).request(path,{ ...init,headers:{ authorization:`Bearer ${token}`,
    "content-type":"application/json",...init.headers } });

  test("retains encrypted long detail, reconciles snapshot reads, and withdraws only owned events",async () => {
    const longBody = `# Release\n\n${"Private implementation detail. ".repeat(400)}`;
    const normalizedLongBody = longBody.trim();
    const first = await request("/api/notifications",ownerToken,{
      method:"POST",headers:{ "idempotency-key":"inbox-long-first" },
      body:JSON.stringify({ sourceName:"Codex",title:"Inbox release",body:longBody,
        summary:"Release detail is ready",bodyFormat:"markdown" }),
    });
    expect(first.status).toBe(201);
    const firstId = (await first.json() as any).eventId;
    const stored = (await db.query<any>(
      `SELECT e.body,c.body_ciphertext,c.body_bytes FROM notification_events e
       JOIN notification_contents c ON c.notification_event_id=e.id WHERE e.id=$1`,
      [firstId.slice(4)],
    )).rows[0];
    expect(stored.body).toBe("Release detail is ready");
    expect(stored.body_ciphertext).not.toContain("Private implementation detail");
    expect(Number(stored.body_bytes)).toBe(Buffer.byteLength(normalizedLongBody,"utf8"));

    const page = await (await request("/api/inbox",deviceToken)).json() as any;
    expect(page.items[0].content).toMatchObject({ body:normalizedLongBody,format:"markdown" });
    expect(page.unread.account).toBe(1);
    expect(page.readWatermark).toEqual(expect.any(String));

    const second = await request("/api/notifications",ownerToken,{
      method:"POST",headers:{ "idempotency-key":"inbox-late-second" },
      body:JSON.stringify({ sourceName:"Codex",title:"Late arrival",body:"Committed later" }),
    });
    expect(second.status).toBe(201);
    const marked = await request("/api/inbox/read",deviceToken,{
      method:"POST",body:JSON.stringify({ watermark:page.readWatermark }),
    });
    expect(marked.status).toBe(200);
    expect((await marked.json() as any).unread.account).toBe(1);

    const forbidden = await request(`/api/notifications/${firstId}/withdraw`,otherToken,{
      method:"POST",headers:{ "idempotency-key":"wrong-owner" },body:"{}",
    });
    expect(forbidden.status).toBe(404);
    const withdrawal = await request(`/api/notifications/${firstId}/withdraw`,ownerToken,{
      method:"POST",headers:{ "idempotency-key":"withdraw-first" },body:"{}",
    });
    expect(withdrawal.status).toBe(200);
    expect((await withdrawal.json() as any).state).toBe("withdrawn");
    const tombstone = await (await request(`/api/inbox/${firstId}`,deviceToken)).json() as any;
    expect(tombstone.item.withdrawnAt).toBeTruthy();
    expect(tombstone.item.content.body).toBe(normalizedLongBody);
    expect(tombstone.evidence.withdrawals.some((row:any) => row.outcome === "canonical_withdrawn")).toBe(true);
  });
});
