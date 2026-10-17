import { randomBytes,randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
// @ts-expect-error The CLI's crypto module is plain JavaScript; the test uses it as the phone's reference signer.
import { answerSigningInput,b64u,generateKeyPair,keyId,questionAnswerSigningInput,signBytes } from "../../../../packages/cli/src/crypto/e2ee.mjs";
import { createAccountAuth } from "../account-auth.js";
import { createApp } from "../app.js";
import { resetAuthAttempts } from "../auth-throttle.js";
import { generateToken,hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createAuthDatabase,createDatabase,type Database } from "../db.js";
import { expireDueInteractiveActivities } from "../interactive-activity-lifecycle.js";
import { migrate } from "../migrate.js";

// Plan 10 C1 (decision 13): a question folded onto a CURRENT work card has one copy per phone (an
// interaction_requests row and a notification_events row each). Whoever settles it, every copy must
// take the outcome, the card resumes exactly once, and no copy is left asking.
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const appUrl = "http://127.0.0.1:8180";
const secret = "test-only-two-phone-races-secret-0123456789abcdef";
type Keys = { privateKey: Buffer; publicKey: Buffer };
type Copy = { interactionId: string; notificationId: string; requestId: string; eventId: string };
type Phone = { id: string; publicId: string; credential: string; keys: Keys };
const b64 = (length: number) => randomBytes(length).toString("base64url");

suite("a folded question answered from several phones",() => {
  let db: Database,authDb: Database,app: ReturnType<typeof createApp>;
  let principalId: string;
  const apiKey = "two_phone_races_owner_abcdefghijklmnopqrstuvwxyz_01";
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

  /** A sealed question folded onto a running work card, with one copy per phone. */
  async function cardQuestion(phones: Phone[],context: string,expiresInSeconds = 600) {
    const started = await call(apiKey,"POST","/api/live-activities",{ key: `work-${randomUUID()}`,title: "Release",status: "Working" });
    expect(started.status,JSON.stringify(started.body)).toBe(201);
    const ids = phones.map((device) => device.publicId);
    const asked = await call(apiKey,"POST",`/api/live-activities/${started.body.activity.id}/wait`,{ type: "approval",expiresInSeconds,
      sealed: { alerts: ids.map((device) => envelope(context,[device])),content: envelope(context,ids) } });
    expect(asked.status,JSON.stringify(asked.body)).toBe(201);
    const activityId = (started.body.activity.id as string).slice(4);
    const rows = (await db.query<{ id: string; event_id: string; device_id: string }>(
      `SELECT r.id,r.notification_event_id AS event_id,t.device_id FROM interaction_requests r
       JOIN notification_events e ON e.id=r.notification_event_id
       JOIN notification_event_targets t ON t.notification_event_id=e.id
       WHERE e.principal_id=$1 AND e.payload#>>'{liveActivity,activityId}'=$2`,
      [principalId,`act_${activityId}`])).rows;
    const copyOf = (device: Phone): Copy => {
      const row = rows.find((entry) => entry.device_id === device.id)!;
      return { interactionId: `int_${row.id}`,notificationId: `ntf_${row.event_id}`,requestId: row.id,eventId: row.event_id };
    };
    return { activityId,copyOf };
  }

  function signedValue(device: Phone,copy: Copy,context: string,value = "approve") {
    const signedAt = new Date().toISOString();
    const fields = { interactionId: copy.interactionId,notificationId: copy.notificationId,deviceId: device.publicId,value,respondedAt: signedAt };
    return { e2eeKeyId: keyId(device.keys.publicKey),e2eeSignedAt: signedAt,
      e2eeSignature: b64u(signBytes(device.keys.privateKey,answerSigningInput(fields))),
      e2eeQuestion: context,e2eeQuestionSignature: b64u(signBytes(device.keys.privateKey,questionAnswerSigningInput({ ...fields,question: context }))) };
  }

  /** The phone taps Approve on its own copy; returns the raw response (no status assertion). */
  const tap = (device: Phone,copy: Copy,context: string) =>
    call(device.credential,"POST",`/api/notifications/${copy.notificationId}/interactions`,{
      kind: "approve",expectedInteractionId: copy.interactionId,value: signedValue(device,copy,context),idempotencyKey: `tap-${randomUUID()}` });

  async function states(copies: Copy[]) {
    return Promise.all(copies.map(async (copy) => ({
      request: (await db.query("SELECT state,late_response IS NOT NULL AS late FROM interaction_requests WHERE id=$1",[copy.requestId])).rows[0] as { state: string; late: boolean },
      event: (await db.query("SELECT state FROM notification_events WHERE id=$1",[copy.eventId])).rows[0].state as string,
      openJobs: Number((await db.query("SELECT count(*) AS n FROM delivery_jobs WHERE notification_event_id=$1 AND state IN ('pending','retry')",
        [copy.eventId])).rows[0].n),
    })));
  }
  const card = async (activityId: string) => (await db.query<{ sequence: string; resume_presentation: unknown; state: string }>(
    "SELECT sequence,resume_presentation,state FROM live_activities WHERE id=$1",[activityId])).rows[0]!;
  const pastDeadline = (requestId: string) => db.query(
    "UPDATE interaction_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[requestId]);

  test("phone A answers; phone B's later answer is refused and every copy is settled consistently",async () => {
    const [a,b] = [await phone(),await phone()];
    const context = "ntf:first-then-second-000000000000";
    const { activityId,copyOf } = await cardQuestion([a,b],context);
    const [copyA,copyB] = [copyOf(a),copyOf(b)];
    expect((await card(activityId)).resume_presentation).not.toBeNull();

    expect((await tap(a,copyA,context)).status).toBe(201);
    const second = await tap(b,copyB,context);
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(second.body)).toMatch(/interaction_not_pending/u);

    const [sa,sb] = await states([copyA,copyB]);
    expect(sa!.request.state).toBe("approved");
    expect(sb!.request.state).toBe("approved");
    expect(sa!.event).toBe("responded");
    expect(sb!.openJobs).toBe(0);
    const winner = (await db.query("SELECT answered_on_request_id FROM interaction_requests WHERE id=$1",[copyB.requestId])).rows[0];
    expect(winner.answered_on_request_id).toBe(copyA.requestId);
    expect((await card(activityId)).resume_presentation).toBeNull();
  });

  test("two answers at once: one winner, one refusal, one card resume, consistent copies",async () => {
    const [a,b] = [await phone(),await phone()];
    const context = "ntf:answers-at-once-00000000000000";
    const { activityId,copyOf } = await cardQuestion([a,b],context);
    const [copyA,copyB] = [copyOf(a),copyOf(b)];
    const before = Number((await card(activityId)).sequence);

    const results = await Promise.all([tap(a,copyA,context),tap(b,copyB,context)]);
    const statuses = results.map((result) => result.status).sort();
    expect(statuses[0],JSON.stringify(results.map((r) => r.body))).toBe(201);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(results.find((result) => result.status >= 400)!.body)).toMatch(/interaction_not_pending/u);

    const after = await card(activityId);
    expect(Number(after.sequence)).toBe(before + 1);
    expect(after.resume_presentation).toBeNull();
    const settled = await states([copyA,copyB]);
    expect(settled.map((entry) => entry.request.state)).toEqual(["approved","approved"]);
    expect(settled.map((entry) => entry.openJobs)).toEqual([0,0]);
    const answeredOn = (await db.query("SELECT id,answered_on_request_id FROM interaction_requests WHERE id=ANY($1::uuid[])",
      [[copyA.requestId,copyB.requestId]])).rows;
    expect(answeredOn.filter((row) => row.answered_on_request_id === null)).toHaveLength(1);
  });

  test("an answer racing the expiry pass: one wins, never both, copies stay consistent",async () => {
    const [a,b] = [await phone(),await phone()];
    const context = "ntf:answer-vs-expiry-000000000000";
    const { activityId,copyOf } = await cardQuestion([a,b],context);
    const [copyA,copyB] = [copyOf(a),copyOf(b)];
    await pastDeadline(copyA.requestId);
    await pastDeadline(copyB.requestId);
    const before = Number((await card(activityId)).sequence);

    const [answer,expired] = await Promise.all([tap(a,copyA,context),expireDueInteractiveActivities(db,"sandbox")]);
    const settled = await states([copyA,copyB]);
    const requestStates = settled.map((entry) => entry.request.state);
    // The deadline had already passed, so expiry (or the answer's own expiry check) wins: never "approved".
    expect(new Set(requestStates).size,JSON.stringify({ answer: answer.body,expired,settled })).toBe(1);
    expect(requestStates[0]).toBe("expired");
    expect(settled[0]!.event).toBe("expired");
    expect(settled.map((entry) => entry.openJobs)).toEqual([0,0]);
    expect(expired).toBeGreaterThanOrEqual(0);
    expect(Number((await card(activityId)).sequence)).toBe(before + 1);
    expect((await card(activityId)).resume_presentation).toBeNull();
  });

  test("an answer racing a deadline that has not passed yet is approved on every copy, or expired on every copy",async () => {
    const [a,b] = [await phone(),await phone()];
    const context = "ntf:answer-vs-expiry-live-0000000";
    const { activityId,copyOf } = await cardQuestion([a,b],context);
    const [copyA,copyB] = [copyOf(a),copyOf(b)];
    const before = Number((await card(activityId)).sequence);
    const [answer] = await Promise.all([tap(a,copyA,context),expireDueInteractiveActivities(db,"sandbox")]);
    expect(answer.status).toBe(201);
    const settled = await states([copyA,copyB]);
    expect(settled.map((entry) => entry.request.state)).toEqual(["approved","approved"]);
    expect(Number((await card(activityId)).sequence)).toBe(before + 1);
  });

  test("a late answer on a sibling copy after expiry is stored as late; the request stays expired",async () => {
    const [a,b] = [await phone(),await phone()];
    const context = "ntf:late-sibling-answer-0000000000";
    const { activityId,copyOf } = await cardQuestion([a,b],context);
    const [copyA,copyB] = [copyOf(a),copyOf(b)];
    await pastDeadline(copyA.requestId);
    await pastDeadline(copyB.requestId);
    // The pass reaches one copy first; the other copy must expire with it.
    expect(await expireDueInteractiveActivities(db,"sandbox")).toBeGreaterThanOrEqual(1);
    expect((await states([copyA,copyB])).map((entry) => entry.request.state)).toEqual(["expired","expired"]);
    const seq = (await card(activityId)).sequence;

    const late = await tap(b,copyB,context);
    expect(late.status,JSON.stringify(late.body)).toBe(200);
    expect(late.body).toMatchObject({ late: true,decision: { state: "expired" } });
    const [sa,sb] = await states([copyA,copyB]);
    expect(sb!.request).toEqual({ state: "expired",late: true });
    expect(sa!.request).toEqual({ state: "expired",late: false });
    expect((await card(activityId)).sequence).toBe(seq);
  });

  test("every sibling notification event reflects the outcome (responded after an answer, expired after expiry)",async () => {
    const [a,b] = [await phone(),await phone()];
    const context = "ntf:sibling-event-state-0000000000";
    const { copyOf } = await cardQuestion([a,b],context);
    const [copyA,copyB] = [copyOf(a),copyOf(b)];
    expect((await tap(a,copyA,context)).status).toBe(201);
    expect((await states([copyA,copyB])).map((entry) => entry.event)).toEqual(["responded","responded"]);
    const second = await cardQuestion([a,b],"ntf:sibling-event-expired-00000000");
    const [x,y] = [second.copyOf(a),second.copyOf(b)];
    await pastDeadline(x.requestId);
    await pastDeadline(y.requestId);
    await expireDueInteractiveActivities(db,"sandbox");
    expect((await states([x,y])).map((entry) => entry.event)).toEqual(["expired","expired"]);
  });

  // One question has one deadline (its copies are made together), so the first copy's expiry is the question's.
  test("when one copy of a question expires, every copy and its notification expire with it",async () => {
    const [a,b] = [await phone(),await phone()];
    const context = "ntf:different-deadline-0000000000";
    const { copyOf } = await cardQuestion([a,b],context);
    const [copyA,copyB] = [copyOf(a),copyOf(b)];
    await pastDeadline(copyA.requestId);
    expect(await expireDueInteractiveActivities(db,"sandbox")).toBeGreaterThanOrEqual(1);
    const [sa,sb] = await states([copyA,copyB]);
    expect(sa!.request.state).toBe("expired");
    expect(sb!.request.state).toBe("expired");
    expect(sb!.event).toBe("expired");
  });
});
