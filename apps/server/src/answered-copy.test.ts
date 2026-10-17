import { randomBytes,randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
// @ts-expect-error The CLI's crypto module is plain JavaScript; the test uses it as the phone's reference signer.
import { answerSigningInput,b64u,generateKeyPair,keyId,questionAnswerSigningInput,signBytes } from "../../../packages/cli/src/crypto/e2ee.mjs";
// @ts-expect-error Plain JavaScript: the computer's own check of an answer, run against what the server relays.
import { answerProblem } from "../../../packages/cli/src/crypto/answer-verify.mjs";
// @ts-expect-error Plain JavaScript.
import { trustKey } from "../../../packages/cli/src/crypto/keystore.mjs";
import { createAccountAuth } from "./account-auth.js";
import { createApp } from "./app.js";
import { resetAuthAttempts } from "./auth-throttle.js";
import { generateToken,hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createAuthDatabase,createDatabase,type Database } from "./db.js";
import { callbackPayload } from "./interaction-callbacks.js";
import { createLiveActivityCredential } from "./live-activity-interaction.js";
import { migrate } from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const appUrl = "http://127.0.0.1:8180";
const secret = "test-only-answered-copy-secret-0123456789abcdef";
type Keys = { privateKey: Buffer; publicKey: Buffer };
type Copy = { interactionId: string; notificationId: string };
type Phone = { id: string; publicId: string; credential: string; keys: Keys };
const b64 = (length: number) => randomBytes(length).toString("base64url");

describe("a callback for a copy answered elsewhere",() => {
  test("names the answered copy and the phone that signed it; a copy answered itself names none",() => {
    const [waited,event,answered,answeredEvent,device] = [randomUUID(),randomUUID(),randomUUID(),randomUUID(),randomUUID()];
    const row = { interaction_request_id: waited,notification_event_id: event,correlation_id: null,kind: "approval",request_state: "approved",
      response: { e2eeKeyId: "k_1",e2eeSignedAt: "2026-10-15T10:00:00.000Z",e2eeSignature: "sig" },responded_at: new Date(),response_device_id: device };
    expect(callbackPayload({ ...row,response_request_id: answered,response_event_id: answeredEvent })).toMatchObject({
      interactionId: `int_${waited}`,device: { id: `dev_${device}` },answeredCopy: { id: `int_${answered}`,eventId: `ntf_${answeredEvent}` } });
    expect(callbackPayload(row)).not.toHaveProperty("answeredCopy");
  });
});

// docs/ENCRYPTION-PROTOCOL.md, "Answers on another copy": a question folded onto a card has one copy
// per phone, and a long one continues as a notification. The computer follows one copy; when a phone
// answers another copy, the waited copy names that copy and the phone that answered it, and the
// computer accepts the phone's signature over that copy's ids only bound to the context it sealed.
suite("an answer on another copy of the question",() => {
  let db: Database,authDb: Database,app: ReturnType<typeof createApp>;
  let principalId: string;
  const apiKey = "answered_copy_owner_abcdefghijklmnopqrstuvwxyz_0123456";
  const sender = `k_${b64(16)}`;

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    authDb = createAuthDatabase(databaseUrl!);
    await migrate(db);
    app = createApp(db,{ accountAuth: createAccountAuth(authDb,appUrl,secret),bootstrapOwnerHandle: "owner",
      credentialDerivationSecret: secret,appUrl,apnsMode: "sandbox" });
  });
  afterAll(async () => { await Promise.all([db.end(),authDb.end()]); });
  beforeEach(async () => {
    resetAuthAttempts();
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    await bootstrapOwner(db,"owner",apiKey);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  });

  async function call(token: string,method: string,path: string,body?: unknown) {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json",
      origin: appUrl,"idempotency-key": randomUUID() },body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }

  async function phone(): Promise<Phone> {
    const id = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token,capabilities)
      VALUES ($1,$2,$3,'iPhone','com.example.relo.notifications','1','1','26','sandbox','authorized','authorized','fixture-alert',
      ARRAY['choice_questions']) RETURNING id`,[principalId,randomUUID(),randomUUID()])).rows[0]!.id;
    const credential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read','interactions:respond'])",
      [id,hashToken(credential)]);
    return { id,publicId: `dev_${id}`,credential,keys: generateKeyPair() };
  }

  const envelope = (context: string,recipients: string[]) => ({ v: "relo.e2e.v1",kind: "question",context,sender,
    recipients: recipients.map((device) => ({ device,prekey: "pk_1",enc: b64(65),key: b64(48) })),nonce: b64(12),ct: b64(272),sig: b64(64) });

  /** A sealed question on a new card, sealed to `phones` with `context`; returns the copy the computer waits on and each phone's copy. */
  async function cardQuestion(phones: Phone[],context: string,expiresInSeconds = 600) {
    const started = await call(apiKey,"POST","/api/live-activities",{ key: `work-${randomUUID()}`,title: "Release",status: "Working" });
    expect(started.status,JSON.stringify(started.body)).toBe(201);
    const ids = phones.map((device) => device.publicId);
    const asked = await call(apiKey,"POST",`/api/live-activities/${started.body.activity.id}/wait`,{ type: "approval",expiresInSeconds,
      sealed: { alerts: ids.map((device) => envelope(context,[device])),content: envelope(context,ids) } });
    expect(asked.status,JSON.stringify(asked.body)).toBe(201);
    const rows = (await db.query<{ id: string; event_id: string; device_id: string }>(
      `SELECT r.id,r.notification_event_id AS event_id,t.device_id FROM interaction_requests r
       JOIN notification_events e ON e.id=r.notification_event_id
       JOIN notification_event_targets t ON t.notification_event_id=e.id
       WHERE e.principal_id=$1 AND e.idempotency_key LIKE $2`,
      [principalId,`activity:${started.body.activity.id.slice(4)}:%:update:%`])).rows;
    const copyOf = (device: Phone): Copy => {
      const row = rows.find((entry) => entry.device_id === device.id)!;
      return { interactionId: `int_${row.id}`,notificationId: `ntf_${row.event_id}` };
    };
    return { waited: asked.body.interaction.id as string,copyOf };
  }

  /** The phone's signed answer on its own copy, bound to the context of the envelope it opened. */
  function signedValue(device: Phone,copy: Copy,context: string,value = "approve") {
    const signedAt = new Date().toISOString();
    const fields = { interactionId: copy.interactionId,notificationId: copy.notificationId,deviceId: device.publicId,value,respondedAt: signedAt };
    return { e2eeKeyId: keyId(device.keys.publicKey),e2eeSignedAt: signedAt,
      e2eeSignature: b64u(signBytes(device.keys.privateKey,answerSigningInput(fields))),
      e2eeQuestion: context,e2eeQuestionSignature: b64u(signBytes(device.keys.privateKey,questionAnswerSigningInput({ ...fields,question: context }))) };
  }

  /** Answered in Relo on the phone (the app's in-app buttons). */
  async function answerInApp(device: Phone,copy: Copy,context: string) {
    const answered = await call(device.credential,"POST",`/api/notifications/${copy.notificationId}/interactions`,{
      kind: "approve",expectedInteractionId: copy.interactionId,value: signedValue(device,copy,context),idempotencyKey: `tap-${randomUUID()}` });
    expect(answered.status,JSON.stringify(answered.body)).toBe(201);
  }

  /** Answered with the card's Lock Screen buttons (the widget's signed ActivityKit capability). */
  async function answerOnLockScreen(device: Phone,copy: Copy,context: string) {
    const request = (await db.query<{ expires_at: Date }>("SELECT expires_at FROM interaction_requests WHERE id=$1",[copy.interactionId.slice(4)])).rows[0]!;
    const version = (await db.query<{ credential_version: number }>("SELECT credential_version FROM devices WHERE id=$1",[device.id])).rows[0]!;
    const credential = createLiveActivityCredential(secret,{ interactionId: copy.interactionId.slice(4),notificationEventId: copy.notificationId.slice(4),
      deviceId: device.id,principalId,credentialVersion: Number(version.credential_version),expiresAt: request.expires_at });
    const response = await app.request(`/api/live-activity-responses/${copy.interactionId}`,{ method: "POST",
      headers: { "content-type": "application/json" },body: JSON.stringify({ notificationId: copy.notificationId,deviceId: device.publicId,
        action: "approve",credential,idempotencyKey: `lock-${randomUUID()}`,signature: signedValue(device,copy,context) }) });
    expect(response.status,await response.clone().text()).toBe(200);
  }

  /** What the asking computer, trusting both phones, decides about the copy it waits on. */
  async function computerVerdict(phones: Phone[],waited: string,questionContext?: string) {
    const read = await call(apiKey,"GET",`/api/interactions/${waited}`);
    const store = { identity: {},strict: false,trusted: Object.fromEntries(phones.map((device) => [trustKey(appUrl,device.publicId),
      { deviceId: device.publicId,publicKey: b64u(device.keys.publicKey),level: "auto" }])) };
    return { interaction: read.body.interaction,problem: answerProblem(read.body.interaction,store,appUrl,
      { interactionId: waited,...(questionContext ? { questionContext } : {}),askedAt: new Date(Date.now() - 60_000).toISOString() },
      Date.now(),{ devices: [] }) };
  }

  test("a second phone answers its own copy: the waited copy names it and the phone, and the computer accepts it",async () => {
    const first = await phone();
    const second = await phone();
    const context = "ntf:two-phones-context-0000000000";
    const { waited,copyOf } = await cardQuestion([first,second],context);
    // The computer follows one phone's copy (both are made at the same moment); the other phone answers its own.
    const answerer = copyOf(first).interactionId === waited ? second : first;
    const answeredCopy = copyOf(answerer);
    expect(answeredCopy.interactionId).not.toBe(waited);
    await answerInApp(answerer,answeredCopy,context);
    const verdict = await computerVerdict([first,second],waited,context);
    expect(verdict.interaction).toMatchObject({ state: "approved",respondingDevice: { id: answerer.publicId },
      answeredCopy: { id: answeredCopy.interactionId,eventId: answeredCopy.notificationId } });
    expect(verdict.problem).toBeNull();
    // The answered copy itself carries no answeredCopy: it was answered there.
    expect((await call(apiKey,"GET",`/api/interactions/${answeredCopy.interactionId}`)).body.interaction.answeredCopy).toBeUndefined();
    // Without the sealed context (asked elsewhere, or not sealed) the server's word about the copy does not count.
    expect((await computerVerdict([first,second],waited)).problem).toMatch(/only for a question this computer sealed/u);
  });

  test("the Lock Screen buttons answer a long question: the notification it continues as names the card's copy",async () => {
    const first = await phone();
    const second = await phone();
    const context = "ntf:long-question-context-000000";
    const { waited,copyOf } = await cardQuestion([first,second],context,2 * 86_400);
    const cardCopy = copyOf(first);
    await answerOnLockScreen(first,cardCopy,context);
    const verdict = await computerVerdict([first,second],waited,context);
    expect(verdict.interaction).toMatchObject({ state: "approved",respondingDevice: { id: first.publicId },
      answeredCopy: { id: cardCopy.interactionId,eventId: cardCopy.notificationId } });
    expect(verdict.problem).toBeNull();
    // The other phone's card copy names the same answered copy.
    expect((await call(apiKey,"GET",`/api/interactions/${copyOf(second).interactionId}`)).body.interaction)
      .toMatchObject({ state: "approved",answeredCopy: { id: cardCopy.interactionId },respondingDevice: { id: first.publicId } });
  });

  test("answered in Relo on the long question's notification: every card copy names that notification",async () => {
    const first = await phone();
    const second = await phone();
    const context = "ntf:long-in-app-context-00000000";
    const { waited,copyOf } = await cardQuestion([first,second],context,2 * 86_400);
    const notification = (await call(apiKey,"GET",`/api/interactions/${waited}`)).body.interaction;
    await answerInApp(second,{ interactionId: waited,notificationId: notification.eventId },context);
    expect((await computerVerdict([first,second],waited,context)).interaction.answeredCopy).toBeUndefined();
    for (const device of [first,second]) {
      expect((await call(apiKey,"GET",`/api/interactions/${copyOf(device).interactionId}`)).body.interaction)
        .toMatchObject({ state: "approved",answeredCopy: { id: waited },respondingDevice: { id: second.publicId } });
    }
  });

  test("a server that passes off another question's answer as a copy of this one is refused",async () => {
    const first = await phone();
    const second = await phone();
    const asked = await cardQuestion([first,second],"ntf:production-deploy-context-000");
    const benign = await cardQuestion([first,second],"ntf:staging-deploy-context-000000");
    const benignCopy = benign.copyOf(second);
    await answerInApp(second,benignCopy,"ntf:staging-deploy-context-000000");
    // The server copies the benign approval onto the asked question and names the benign copy as answered.
    const winner = (await db.query("SELECT response FROM interaction_requests WHERE id=$1",[benignCopy.interactionId.slice(4)])).rows[0];
    await db.query("UPDATE interaction_requests SET state='approved',responded_at=now(),response=$2,answered_on_request_id=$3 WHERE id=$1",
      [asked.waited.slice(4),winner.response,benignCopy.interactionId.slice(4)]);
    const verdict = await computerVerdict([first,second],asked.waited,"ntf:production-deploy-context-000");
    expect(verdict.interaction).toMatchObject({ state: "approved",respondingDevice: { id: second.publicId } });
    expect(verdict.problem).toBe("the phone approved a different question");
  });
});
