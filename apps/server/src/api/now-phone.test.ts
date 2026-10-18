import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { nowSummarySchema,type NowItem,type NowSummary } from "@relo/notification-contracts";
import { createApp } from "../app.js";
import { generateToken,hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { loadNowSummary } from "./now-routes.js";
import { caller,OWNER_TOKEN,resetOwner,SECRET,startWork } from "../works/works-fixture.js";

/**
 * The phone's Now: its envelopes next to the placeholders (docs/ENCRYPTION-PROTOCOL.md "Phone
 * surfaces"), and the owner's dismissal of a missed question (STATE-SPEC 6.2).
 */
const b64 = (bytes: number,fill = 7) => Buffer.alloc(bytes,fill).toString("base64url");
function envelope(kind: "card" | "question",devices: string[],alert = false) {
  return { v: "relo.e2e.v1",kind,context: `ntf:${"0".repeat(32)}`,sender: `k_${"A".repeat(22)}`,
    recipients: devices.map((device,index) => ({ device,prekey: `pk_${index}`,enc: b64(65),key: b64(48) })),
    nonce: b64(12),ct: b64(256 + 16,alert ? 1 : 2),sig: b64(64) };
}
const notice = (kind: "card" | "question",devices: string[]) => ({
  alerts: devices.map((device) => envelope(kind,[device],true)),content: envelope(kind,devices),
});

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("the phone's Now",() => {
  let db: Database,app: ReturnType<typeof createApp>,call: ReturnType<typeof caller>;
  let principalId: string,deviceId: string,phone: string;
  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: SECRET });
    call = caller(app);
  });
  afterAll(async () => db.end());
  beforeEach(async () => {
    ({ principalId,deviceId } = await resetOwner(db));
    phone = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)",[deviceId,hashToken(phone)]);
  });

  async function as(token: string,method: string,path: string,body?: unknown) {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }
  const now = async (token: string): Promise<NowSummary> => {
    const read = await as(token,"GET","/api/now");
    expect(read.status,JSON.stringify(read.body)).toBe(200);
    return nowSummarySchema.parse(read.body);
  };
  const items = (summary: NowSummary): NowItem[] =>
    [...summary.needsYou,...summary.recent,...summary.waitingOnYou,...summary.running,...summary.quiet,...summary.paused];
  const raw = (id: string) => id.replace(/^[a-z]+_/,"");

  /** A work with its card and a question on it; returns the card and the question's public id. */
  async function askedWork() {
    const work = await startWork(call);
    const asked = await call("POST",`/api/live-activities/${work.card.id}/wait`,{ type: "approval",prompt: "Deploy now?",expiresInSeconds: 120 },null);
    expect(asked.status,JSON.stringify(asked.body)).toBe(201);
    const question = (await db.query<{ id: string; notification_event_id: string }>(
      "SELECT id,notification_event_id FROM interaction_requests ORDER BY created_at DESC LIMIT 1")).rows[0]!;
    return { cardId: work.card.id as string,questionId: `int_${question.id}`,eventId: question.notification_event_id };
  }
  async function miss(questionId: string) {
    await db.query("UPDATE interaction_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[raw(questionId)]);
    await call("GET",`/api/interactions/${questionId}`,undefined,null);
    expect((await db.query("SELECT state::text FROM interaction_requests WHERE id=$1",[raw(questionId)])).rows[0].state).toBe("expired");
  }

  describe("sealed envelopes",() => {
    test("a phone gets its card and question content envelopes; the owner's other readers never do",async () => {
      const { cardId,eventId } = await askedWork();
      const device = `dev_${deviceId}`;
      // Unsealed: no envelopes, so no `sealed` field at all.
      expect(items(await now(phone)).find((item) => item.id === cardId)).not.toHaveProperty("sealed");

      const card = notice("card",[device]);
      const question = notice("question",[device]);
      await db.query("UPDATE live_activities SET sealed=$2 WHERE id=$1",[raw(cardId),card]);
      await db.query("UPDATE notification_events SET payload=payload||jsonb_build_object('sealed',$2::jsonb) WHERE id=$1",[eventId,question]);

      const item = items(await now(phone)).find((entry) => entry.id === cardId)!;
      expect(item.question?.standing).toBe("pending");
      expect(item.sealed).toEqual({ card: card.content,question: question.content });

      // The CLI reads /api/now with a principal credential, the Dashboard through loadNowSummary: never an envelope.
      const reader = generateToken();
      await db.query("INSERT INTO principal_api_keys(principal_id,label,token_hash,scopes) VALUES ($1,'reader',$2,$3)",
        [principalId,hashToken(reader),["inbox:read"]]);
      for (const entry of items(await now(reader))) expect(entry).not.toHaveProperty("sealed");
      for (const entry of items(await loadNowSummary(db,principalId,undefined,undefined))) expect(entry).not.toHaveProperty("sealed");
    });

    test("envelopes not sealed to this phone, or of the wrong kind, are left out; a card alone is enough",async () => {
      const { cardId,eventId } = await askedWork();
      const elsewhere = `dev_${randomUUID()}`;
      await db.query("UPDATE live_activities SET sealed=$2 WHERE id=$1",[raw(cardId),notice("card",[elsewhere])]);
      await db.query("UPDATE notification_events SET payload=payload||jsonb_build_object('sealed',$2::jsonb) WHERE id=$1",
        [eventId,notice("card",[`dev_${deviceId}`])]);
      expect(items(await now(phone)).find((item) => item.id === cardId)).not.toHaveProperty("sealed");

      const card = notice("card",[elsewhere,`dev_${deviceId}`]);
      await db.query("UPDATE live_activities SET sealed=$2 WHERE id=$1",[raw(cardId),card]);
      expect(items(await now(phone)).find((item) => item.id === cardId)!.sealed).toEqual({ card: card.content,question: null });
    });

    test("an answered question's envelope is not carried",async () => {
      const { cardId,questionId,eventId } = await askedWork();
      await db.query("UPDATE notification_events SET payload=payload||jsonb_build_object('sealed',$2::jsonb) WHERE id=$1",
        [eventId,notice("question",[`dev_${deviceId}`])]);
      await db.query("UPDATE interaction_requests SET state='approved',responded_at=now(),response='{}'::jsonb WHERE id=$1",[raw(questionId)]);
      const item = items(await now(phone)).find((entry) => entry.id === cardId);
      expect(item?.question?.standing ?? "answered").toBe("answered");
      expect(item).not.toHaveProperty("sealed");
    });
  });

  describe("dismissing a missed question",() => {
    const dismiss = (token: string,id: string) => as(token,"POST",`/api/devices/self/questions/${id}/dismiss`);

    test("a missed question never needs the owner: it leaves Needs you on its own; dismissing it stays idempotent",async () => {
      const { cardId,questionId } = await askedWork();
      expect((await now(phone)).needsYou.map((item) => item.id)).toEqual([cardId]);
      await miss(questionId);
      const summary = await now(phone);
      expect(summary.needsYou).toEqual([]);
      expect([summary.sinceYouLooked.needsYou,summary.lockScreen.needsYouCount]).toEqual([0,0]);
      // The work is still open (declared state is untouched) and the card shows the work's own state.
      expect((await db.query("SELECT lifecycle FROM works")).rows[0].lifecycle).toBe("open");
      expect(items(summary).find((item) => item.id === cardId)?.owner.needsYou ?? null).toBeNull();

      expect(await dismiss(phone,questionId)).toEqual({ status: 200,body: { dismissed: true } });
      const stored = (await db.query("SELECT owner_dismissed_at,dismissed_by_device FROM interaction_requests WHERE id=$1",[raw(questionId)])).rows[0];
      expect(stored.dismissed_by_device).toBe(deviceId);
      expect(await dismiss(phone,questionId)).toEqual({ status: 200,body: { dismissed: true } });
      expect((await db.query("SELECT owner_dismissed_at FROM interaction_requests WHERE id=$1",[raw(questionId)])).rows[0].owner_dismissed_at)
        .toEqual(stored.owner_dismissed_at);
    });

    test("a dismissed question refuses a late answer",async () => {
      const { questionId,eventId } = await askedWork();
      await miss(questionId);
      expect((await dismiss(phone,questionId)).status).toBe(200);
      const late = await as(phone,"POST",`/api/notifications/ntf_${eventId}/interactions`,{ kind: "approve",idempotencyKey: randomUUID() });
      expect(late).toMatchObject({ status: 409,body: { error: "question_dismissed" } });
      expect((await db.query("SELECT late_response FROM interaction_requests WHERE id=$1",[raw(questionId)])).rows[0].late_response).toBeNull();
    });

    test("only a missed question can be dismissed: pending and late-answered ones are 404",async () => {
      const { questionId,eventId } = await askedWork();
      expect(await dismiss(phone,questionId)).toMatchObject({ status: 404,body: { error: "not_found" } });
      await miss(questionId);
      const late = await as(phone,"POST",`/api/notifications/ntf_${eventId}/interactions`,{ kind: "approve",idempotencyKey: randomUUID() });
      expect(late).toMatchObject({ status: 200,body: { late: true } });
      expect(await dismiss(phone,questionId)).toMatchObject({ status: 404,body: { error: "not_found" } });
      expect(await dismiss(phone,"int_not-an-id")).toMatchObject({ status: 404 });
      expect((await db.query("SELECT count(*)::int AS n FROM interaction_requests WHERE owner_dismissed_at IS NOT NULL")).rows[0].n).toBe(0);
    });

    test("another account's phone cannot dismiss it, and the owner's credential is not a phone",async () => {
      const { questionId } = await askedWork();
      await miss(questionId);
      await bootstrapOwner(db,"other","other_owner_token_abcdefghijklmnopqrstuvwxyz0123456789");
      const otherDevice = randomUUID();
      await db.query(`INSERT INTO devices (id,principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
          os_version,model,apns_environment,notification_authorization,live_activity_authorization,credential_version)
        SELECT $1,id,$2,$3,'Phone','com.example.relo.notifications','1','1','18','iPhone','sandbox','authorized','authorized',1
        FROM owner_principals WHERE handle='other'`,[otherDevice,`stable-${otherDevice}`,randomUUID()]);
      const otherPhone = generateToken();
      await db.query("INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)",[otherDevice,hashToken(otherPhone)]);
      expect(await dismiss(otherPhone,questionId)).toMatchObject({ status: 404,body: { error: "not_found" } });
      expect((await dismiss(OWNER_TOKEN,questionId)).status).toBe(403);
      expect((await db.query("SELECT owner_dismissed_at FROM interaction_requests WHERE id=$1",[raw(questionId)])).rows[0].owner_dismissed_at).toBeNull();
    });
  });
});
