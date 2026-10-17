import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import type { ApnsOutcome,BackgroundSend } from "../apns-provider-cleanroom.js";
import { createDatabase,type Database } from "../db.js";
import { publicId } from "../ids.js";
import { cancelLockedInteraction } from "../interactions/commands.js";
import { settleQuestionCopies } from "../interactions/settle-copies.js";
import { expireLockedRequest,markRespondedEvent } from "../interactions/store.js";
import type { InteractionRow } from "../interactions/types.js";
import { migrate } from "../migrate.js";
import { createTransportTokenEncryption } from "../token-encryption.js";
import { persistWithdrawal } from "./store.js";
import { dispatchDueSettlePushes,settlePayload } from "./settle-pushes.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const encryption = createTransportTokenEncryption("test-only-settle-push-secret-0123456789abcdef");

suite("settle pushes for notifications that stop being active",() => {
  let db: Database,principalId: string;
  /** shown: its alert reached APNs; unsent: its alert job was canceled first; tokenless: shown, token gone since. */
  let devices: { shown: string; unsent: string; tokenless: string };
  beforeAll(async () => { db = createDatabase(databaseUrl!);await migrate(db); });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");
    principalId = (await db.query("INSERT INTO owner_principals(handle) VALUES ($1) RETURNING id",[randomUUID()])).rows[0].id;
    const device = async (token: string | null) => (await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,
      bundle_identifier,app_version,app_build,os_version,apns_environment,apns_token,notification_authorization)
      VALUES ($1,$2,$3,'Settle test','com.example.relo.notifications','1','1','26','sandbox',$4,'authorized') RETURNING id`,
    [principalId,randomUUID(),randomUUID(),token ? encryption.encrypt(token,"device.apns_token") : null])).rows[0].id as string;
    devices = { shown: await device("a".repeat(64)),unsent: await device("b".repeat(64)),tokenless: await device(null) };
  });

  async function question(options: { groupId?: string; deadlineSeconds?: number } = {}) {
    const seconds = options.deadlineSeconds ?? 600;
    const eventId = (await db.query(`INSERT INTO notification_events(principal_id,source,kind,title,body,idempotency_key,expires_at)
      VALUES ($1,'Settle','approval','Deploy?','Deploy?',$2,clock_timestamp()+$3*interval '1 second') RETURNING id`,
    [principalId,randomUUID(),seconds])).rows[0].id as string;
    const requestId = (await db.query(`INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,
      expires_at,decision_group_id) VALUES ($1,$2,'approval','Deploy?',$3,clock_timestamp()+$4*interval '1 second',$5) RETURNING id`,
    [principalId,eventId,randomUUID().replaceAll("-","").padEnd(64,"0"),seconds,options.groupId ?? null])).rows[0].id as string;
    const job = (deviceId: string,state: string) => db.query(`INSERT INTO delivery_jobs(notification_event_id,device_id,state,accepted_at)
      VALUES ($1,$2,$3::delivery_state,CASE WHEN $3='accepted' THEN now() END)`,[eventId,deviceId,state]);
    await job(devices.shown,"accepted");
    await job(devices.unsent,"canceled");
    await job(devices.tokenless,"accepted");
    const row = { id: requestId,principal_id: principalId,notification_event_id: eventId } as InteractionRow;
    return { eventId,requestId,row };
  }

  const queued = async (eventId: string) => (await db.query<{ device_id: string; state: string }>(
    "SELECT device_id,state FROM notification_settle_pushes WHERE notification_event_id=$1 ORDER BY device_id",[eventId])).rows;
  const expectQueuedForShownPhones = async (eventId: string) => {
    expect((await queued(eventId)).map((row) => row.device_id).sort()).toEqual([devices.shown,devices.tokenless].sort());
  };

  test("an answer queues one settle push per phone that was sent the alert, and never twice",async () => {
    const { eventId,row } = await question();
    expect(await queued(eventId)).toEqual([]);
    await db.query("UPDATE interaction_requests SET state='approved',responded_at=now() WHERE id=$1",[row.id]);
    await markRespondedEvent(db,row);
    await expectQueuedForShownPhones(eventId);
    // Answering again, or any later write of the event's state, queues nothing more.
    await markRespondedEvent(db,row);
    await db.query("UPDATE notification_events SET state='withdrawn' WHERE id=$1",[eventId]);
    expect(await queued(eventId)).toHaveLength(2);
  });

  test("expiry, cancelation, a settled decision group and a withdrawal each queue the same settle pushes",async () => {
    const expiring = await question({ deadlineSeconds: -1 });
    expect(await expireLockedRequest(db,expiring.row)).toBe(true);
    await expectQueuedForShownPhones(expiring.eventId);

    const canceled = await question();
    await cancelLockedInteraction(db,{ principalId,interactionId: canceled.requestId,notificationEventId: canceled.eventId,apnsMode: "disabled" });
    await expectQueuedForShownPhones(canceled.eventId);

    const groupId = randomUUID();
    const winner = await question({ groupId }),other = await question({ groupId });
    await settleQuestionCopies(db,{ scope: { decisionGroupId: groupId },winner: { interactionId: winner.requestId },
      outcome: { state: "approved",response: { value: "yes" } } });
    await expectQueuedForShownPhones(other.eventId);

    const withdrawn = await question();
    await persistWithdrawal(db,{ kind: "owner",principalId },{ eventId: withdrawn.eventId,idempotencyKey: randomUUID() });
    await expectQueuedForShownPhones(withdrawn.eventId);
  });

  test("a plain notice that is never sent queues nothing",async () => {
    const eventId = (await db.query(`INSERT INTO notification_events(principal_id,source,kind,title,body,idempotency_key)
      VALUES ($1,'Settle','notification','Hi','Hi',$2) RETURNING id`,[principalId,randomUUID()])).rows[0].id;
    await db.query("INSERT INTO delivery_jobs(notification_event_id,device_id,state) VALUES ($1,$2,'pending')",[eventId,devices.shown]);
    await persistWithdrawal(db,{ kind: "owner",principalId },{ eventId,idempotencyKey: randomUUID() });
    expect(await queued(eventId)).toEqual([]);
  });

  test("the worker sends one silent push per phone naming every settled notification, and skips a phone without a token",async () => {
    const first = await question(),second = await question();
    for (const { row } of [first,second]) await markRespondedEvent(db,row);
    const sent: BackgroundSend[] = [];
    const sender = { sendBackground: async (input: BackgroundSend): Promise<ApnsOutcome> => {
      sent.push(input);
      const recipient = await input.recipient.resolve();
      return recipient
        ? { accepted: true,category: "accepted",attempt: 1,apnsId: randomUUID(),payloadBytes: 1 }
        : { accepted: false,category: "stale-recipient",attempt: 0,apnsId: randomUUID(),payloadBytes: 0 };
    } };
    const cycle = await dispatchDueSettlePushes(db,{ sender,encryption,environment: "sandbox" });
    expect(cycle).toMatchObject({ claimed: 4,sent: 2,skipped: 2,failed: 0,retried: 0 });
    expect(sent).toHaveLength(2);
    const toShown = await Promise.all(sent.map(async (input) => (await input.recipient.resolve())?.token));
    const shownPush = sent[toShown.indexOf("a".repeat(64))]!;
    expect(shownPush.priority).toBe(5);
    expect(shownPush.customData).toEqual({ relo: { settled: expect.arrayContaining([publicId("ntf",first.eventId),publicId("ntf",second.eventId)]) } });
    expect((shownPush.customData.relo as { settled: string[] }).settled).toHaveLength(2);
    expect(Object.keys(shownPush.customData)).toEqual(["relo"]);
    const states = (await db.query<{ device_id: string; state: string }>(
      "SELECT DISTINCT device_id,state FROM notification_settle_pushes")).rows;
    expect(states).toEqual(expect.arrayContaining([{ device_id: devices.shown,state: "sent" },{ device_id: devices.tokenless,state: "skipped" }]));
    // Nothing left to send.
    expect(await dispatchDueSettlePushes(db,{ sender,encryption,environment: "sandbox" })).toMatchObject({ claimed: 0 });
  });

  test("a settle push waits for an alert still in flight, and is skipped if that alert never reached APNs",async () => {
    const { eventId,row } = await question();
    await db.query(`UPDATE delivery_jobs SET state='processing',claim_token=gen_random_uuid(),claim_phase='dispatch_started'
      WHERE notification_event_id=$1 AND device_id=$2`,[eventId,devices.shown]);
    await markRespondedEvent(db,row);
    await db.query("DELETE FROM notification_settle_pushes WHERE device_id=$1",[devices.tokenless]);
    const sender = { sendBackground: async (): Promise<ApnsOutcome> => { throw new Error("must not send"); } };
    expect(await dispatchDueSettlePushes(db,{ sender,encryption,environment: "sandbox" })).toMatchObject({ claimed: 0 });
    await db.query(`UPDATE delivery_jobs SET state='permanently_failed',claim_token=NULL,claim_phase=NULL
      WHERE notification_event_id=$1 AND device_id=$2`,[eventId,devices.shown]);
    expect(await dispatchDueSettlePushes(db,{ sender,encryption,environment: "sandbox" })).toMatchObject({ claimed: 0,skipped: 1 });
  });

  test("a retryable provider outcome is retried later; a rejected one is final",async () => {
    const { eventId,row } = await question();
    await markRespondedEvent(db,row);
    await db.query("DELETE FROM notification_settle_pushes WHERE device_id=$1",[devices.tokenless]);
    let category: ApnsOutcome["category"] = "indeterminate-transport";
    const sender = { sendBackground: async (): Promise<ApnsOutcome> => ({ accepted: false,category,attempt: 1,apnsId: randomUUID(),payloadBytes: 1 }) };
    expect(await dispatchDueSettlePushes(db,{ sender,encryption,environment: "sandbox" })).toMatchObject({ retried: 1 });
    expect((await queued(eventId))[0]!.state).toBe("pending");
    await db.query("UPDATE notification_settle_pushes SET available_at=clock_timestamp()");
    category = "permanent-apns-rejection";
    expect(await dispatchDueSettlePushes(db,{ sender,encryption,environment: "sandbox" })).toMatchObject({ failed: 1 });
    expect((await queued(eventId))[0]!.state).toBe("failed");
  });
});

describe("settle push payload",() => {
  test("names notifications by the public id their alert carried, and nothing else",() => {
    const id = randomUUID();
    expect(settlePayload([id])).toEqual({ relo: { settled: [`ntf_${id}`] } });
    expect(() => settlePayload([])).toThrow();
    expect(() => settlePayload(Array.from({ length: 51 },() => randomUUID()))).toThrow();
  });
});
