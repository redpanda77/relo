import { randomBytes,randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
// @ts-expect-error The CLI's crypto module is plain JavaScript; the test uses it as the reference signer.
import { answerSigningInput as cliAnswerInput,b64u,generateKeyPair,keyId,linkSigningInput,prekeySigningInput,questionAnswerSigningInput as cliQuestionInput,signBytes } from "../../../packages/cli/src/crypto/e2ee.mjs";
// @ts-expect-error Plain JavaScript: the computer's own check of an answer, run against what the server relays.
import { answerProblem } from "../../../packages/cli/src/crypto/answer-verify.mjs";
// @ts-expect-error Plain JavaScript.
import { trustKey } from "../../../packages/cli/src/crypto/keystore.mjs";
import { loadNowSummary } from "./api/now-routes.js";
import { createAccountAuth } from "./account-auth.js";
import { createApp } from "./app.js";
import { resetAuthAttempts } from "./auth-throttle.js";
import { generateToken,hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { answerSigningInput,questionActions,questionAnswerSigningInput } from "./browser-answers.js";
import { createAuthDatabase,createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";

const b64 = (length: number) => randomBytes(length).toString("base64url");

describe("the browser signs exactly the bytes a phone signs",() => {
  test("answer and answer-to inputs match the CLI's",() => {
    const fields = { interactionId: "int_1",notificationId: "ntf_1",deviceId: "brw_1",value: "approve",respondedAt: "2026-10-15T10:00:00.000Z" };
    expect(answerSigningInput(fields).toString()).toBe(cliAnswerInput(fields).toString());
    expect(answerSigningInput(fields).toString()).toBe("relo.e2e.v1 answer\nint_1\nntf_1\nbrw_1\napprove\n2026-10-15T10:00:00.000Z");
    expect(questionAnswerSigningInput({ ...fields,question: "ntf:abc" }).toString()).toBe(cliQuestionInput({ ...fields,question: "ntf:abc" }).toString());
  });

  test("buttons carry the sender's own labels, negative first",() => {
    expect(questionActions("approval",null,{ type: "approval",primary: { action: "approve",label: "Ship it" },secondary: { action: "deny",label: "Hold" } }))
      .toEqual([{ action: "deny",label: "Hold" },{ action: "approve",label: "Ship it" }]);
    expect(questionActions("yes_no",null,null)).toEqual([{ action: "no",label: "No" },{ action: "yes",label: "Yes" }]);
    expect(questionActions("choice",[{ id: "ship",label: "Ship" },{ id: "wait",label: "Wait" }],null))
      .toEqual([{ action: "choose",label: "Ship",optionId: "ship" },{ action: "choose",label: "Wait",optionId: "wait" }]);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const appUrl = "http://127.0.0.1:8180";
const secret = "test-only-browser-answers-secret-0123456789abcdef";
type Keys = { privateKey: Buffer; publicKey: Buffer };

// docs/ENCRYPTION-PROTOCOL.md, "Answering from a linked browser".
suite("answering from a linked browser",() => {
  let db: Database,authDb: Database,app: ReturnType<typeof createApp>;
  let session: string,principalId: string;
  const apiKey = "browser_answers_owner_abcdefghijklmnopqrstuvwxyz_01234";
  const password = "browser-answers-password-123";

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
    await db.query("TRUNCATE auth.sessions, auth.accounts, auth.verifications, auth.two_factors, auth.users CASCADE");
    await db.query("UPDATE server_settings SET registration_mode='closed'");
    await bootstrapOwner(db,"owner",apiKey);
    const email = "owner@answers.example";
    const signup = await app.request("/api/auth/sign-up/email",{ method: "POST",headers: { "content-type": "application/json",origin: appUrl },
      body: JSON.stringify({ name: "Owner",email,password }) });
    expect(signup.status,await signup.clone().text()).toBe(200);
    const signin = await app.request("/api/auth/sign-in/email",{ method: "POST",headers: { "content-type": "application/json",origin: appUrl },
      body: JSON.stringify({ email,password,rememberMe: true }) });
    session = signin.headers.get("set-auth-token")!;
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  });

  async function call(token: string,method: string,path: string,body?: unknown,headers: Record<string,string> = {}) {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json",
      origin: appUrl,"idempotency-key": randomUUID(),...headers },body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }

  async function phone(owner = principalId) {
    const id = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,apns_token,capabilities) VALUES ($1,$2,$3,'iPhone',
      'com.example.relo.notifications','1','1','26','sandbox','authorized','fixture-alert',ARRAY['choice_questions']) RETURNING id`,
    [owner,randomUUID(),randomUUID()])).rows[0]!.id;
    const credential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read','interactions:respond'])",
      [id,hashToken(credential)]);
    return { id,publicId: `dev_${id}`,credential };
  }

  /** A browser registered by the Dashboard and, when `linker` is given, linked from that phone (signed with its keys when given). */
  async function browser(linker?: { credential: string; publicId?: string; keys?: Keys }) {
    const identity: Keys = generateKeyPair();
    const prekey: Keys = generateKeyPair();
    const browserId = `brw_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const registered = await call(session,"POST","/api/dashboard/browser",{ browserId,name: "Chrome on macOS",
      identityKey: b64u(identity.publicKey),prekey: { prekeyId: "pk_1",publicKey: b64u(prekey.publicKey),createdAt,
        signature: b64u(signBytes(identity.privateKey,prekeySigningInput({ deviceId: browserId,prekeyId: "pk_1",publicKey: prekey.publicKey,createdAt }))) } });
    expect(registered.status).toBe(200);
    if (linker) {
      const signedAt = new Date().toISOString();
      const signature = linker.keys && linker.publicId ? b64u(signBytes(linker.keys.privateKey,linkSigningInput({ browserId,
        identityKey: b64u(identity.publicKey),phoneDeviceId: linker.publicId,signedAt }))) : b64(64);
      expect((await call(linker.credential,"POST","/api/devices/self/links",{ browserId,identityKey: b64u(identity.publicKey),
        signedAt,signature })).status).toBe(200);
    }
    return { browserId,identity };
  }

  async function ask(device: { publicId: string },type: "approval" | "yes_no" | "choice" = "approval") {
    const asked = await call(apiKey,"POST","/api/interactions",{ title: "Deploy",prompt: "Deploy to production?",type,deviceIds: [device.publicId],
      ...(type === "choice" ? { options: [{ id: "ship",label: "Ship" },{ id: "wait",label: "Wait" }] } : {}) });
    expect(asked.status,JSON.stringify(asked.body)).toBe(201);
    return { interactionId: asked.body.interaction.id as string,notificationId: asked.body.eventId as string };
  }

  /** The browser's signature over what a phone signs, with the browser as the answering device. */
  function signed(answerer: { browserId: string; identity: Keys },question: { interactionId: string; notificationId: string },
    action: string,{ optionId,signedAt = new Date().toISOString(),context,key = answerer.identity }: { optionId?: string; signedAt?: string;
      context?: string; key?: Keys } = {}) {
    const fields = { interactionId: question.interactionId,notificationId: question.notificationId,deviceId: answerer.browserId,
      value: action === "choose" ? `choose:${optionId}` : action,respondedAt: signedAt };
    return {
      notificationId: question.notificationId,action,...(optionId ? { optionId } : {}),idempotencyKey: `tap-${randomUUID()}`,
      signature: { e2eeKeyId: keyId(answerer.identity.publicKey),e2eeSignedAt: signedAt,
        e2eeSignature: b64u(signBytes(key.privateKey,cliAnswerInput(fields))),
        ...(context ? { e2eeQuestion: context,e2eeQuestionSignature: b64u(signBytes(key.privateKey,cliQuestionInput({ ...fields,question: context }))) } : {}) },
    };
  }

  const answer = (question: { interactionId: string },browserId: string,body: unknown,token = session) =>
    call(token,"POST",`/api/dashboard/questions/${question.interactionId}/answer`,body,{ "x-relo-browser": browserId });

  test("a linked browser's signed approval reaches the computer as the phone's would, naming the browser",async () => {
    const device = await phone();
    const linked = await browser(device);
    const question = await ask(device);
    const shown = await call(session,"GET",`/api/dashboard/questions/${question.interactionId}`);
    expect(shown.body.question).toMatchObject({ id: question.interactionId,notificationId: question.notificationId,kind: "approval",
      prompt: "Deploy to production?",encrypted: false,state: "pending",actions: [{ action: "deny",label: "Deny" },{ action: "approve",label: "Approve" }] });
    const body = signed(linked,question,"approve");
    const answered = await answer(question,linked.browserId,body);
    expect(answered.status,JSON.stringify(answered.body)).toBe(201);
    expect(answered.body).toMatchObject({ interactionId: question.interactionId,state: "approved",replayed: false,late: false });

    const read = await call(apiKey,"GET",`/api/interactions/${question.interactionId}`);
    const interaction = read.body.interaction ?? read.body;
    expect(interaction.state).toBe("approved");
    expect(interaction.respondingDevice).toEqual({ id: linked.browserId,name: "Chrome on macOS" });
    expect(interaction.response).toEqual(body.signature);
    // A retry of the same tap is one answer; a second tap (or the phone) finds it decided.
    expect((await answer(question,linked.browserId,body)).body).toMatchObject({ replayed: true,state: "approved" });
    expect((await answer(question,linked.browserId,signed(linked,question,"deny"))).body).toMatchObject({ error: "interaction_not_pending" });
    const phoneLate = await call(device.credential,"POST",`/api/notifications/${question.notificationId}/interactions`,
      { kind: "deny",value: {},idempotencyKey: "ios:after-browser",expectedInteractionId: question.interactionId });
    expect(phoneLate.status).toBe(409);
    // The same tap key with another body is a conflict, never a second answer.
    expect((await answer(question,linked.browserId,{ ...signed(linked,question,"deny"),idempotencyKey: body.idempotencyKey })).status).toBe(409);
  });

  test("a picked option is signed as choose:<id>",async () => {
    const device = await phone();
    const linked = await browser(device);
    const question = await ask(device,"choice");
    const answered = await answer(question,linked.browserId,signed(linked,question,"choose",{ optionId: "wait" }));
    expect(answered.status,JSON.stringify(answered.body)).toBe(201);
    const read = await call(apiKey,"GET",`/api/interactions/${question.interactionId}`);
    expect((read.body.interaction ?? read.body).response).toMatchObject({ optionId: "wait",label: "Wait" });
  });

  test("an unlinked, revoked, stale or foreign browser cannot answer (403)",async () => {
    const device = await phone();
    const question = await ask(device);
    const unlinked = await browser();
    expect(await answer(question,unlinked.browserId,signed(unlinked,question,"approve"))).toMatchObject({ status: 403,body: { error: "browser_not_linked" } });

    const stale = await browser(device);
    await db.query("UPDATE linked_browsers SET link_signed_at=$2 WHERE id=$1",
      [stale.browserId.slice(4),new Date(Date.now() - 15 * 86_400_000).toISOString()]);
    expect((await answer(question,stale.browserId,signed(stale,question,"approve"))).status).toBe(403);

    const revoked = await browser(device);
    expect((await call(session,"DELETE",`/api/dashboard/browser/${revoked.browserId}`)).status).toBe(204);
    expect((await answer(question,revoked.browserId,signed(revoked,question,"approve"))).status).toBe(403);

    // Tenant isolation: another account's linked browser is not this account's.
    await bootstrapOwner(db,"other","browser_answers_other_abcdefghijklmnopqrstuvwxyz_0123");
    const otherPrincipal = (await db.query("SELECT id FROM owner_principals WHERE handle='other'")).rows[0].id;
    const otherPhone = await phone(otherPrincipal);
    const foreign = { browserId: `brw_${randomUUID()}`,identity: generateKeyPair() as Keys };
    await db.query(`INSERT INTO linked_browsers(id,principal_id,name,key_id,identity_key,prekey_id,prekey_public_key,prekey_signature,
      prekey_created_at,linked_by_device,link_signed_at,link_signature,linked_at) VALUES ($1,$2,'Other',$3,$4,'pk_1',$5,$6,$7,$8,$7,$6,now())`,
    [foreign.browserId.slice(4),otherPrincipal,keyId(foreign.identity.publicKey),b64u(foreign.identity.publicKey),b64(65),b64(64),
      new Date().toISOString(),otherPhone.id]);
    expect((await answer(question,foreign.browserId,signed(foreign,question,"approve"))).status).toBe(403);
    // And this account's browser cannot reach the other account's question.
    const mine = await browser(device);
    const otherQuestion = await call("browser_answers_other_abcdefghijklmnopqrstuvwxyz_0123","POST","/api/interactions",
      { title: "Deploy",prompt: "Deploy?",type: "approval",deviceIds: [otherPhone.publicId] });
    const theirs = { interactionId: otherQuestion.body.interaction.id,notificationId: otherQuestion.body.eventId };
    expect((await answer(theirs,mine.browserId,signed(mine,theirs,"approve"))).status).toBe(404);
    expect((await call(session,"GET",`/api/dashboard/questions/${theirs.interactionId}`)).status).toBe(404);
    expect((await call(apiKey,"GET",`/api/interactions/${question.interactionId}`)).body.interaction?.state ?? "pending").toBe("pending");
  });

  test("a bad, foreign-key, old or misbound signature is refused (400) and decides nothing",async () => {
    const device = await phone();
    const linked = await browser(device);
    const question = await ask(device);
    const other = await ask(device);
    const cases = [
      { ...signed(linked,question,"approve"),signature: { ...signed(linked,question,"approve").signature,e2eeSignature: b64(64) } },
      signed(linked,question,"approve",{ key: generateKeyPair() }),
      signed(linked,question,"approve",{ signedAt: new Date(Date.now() - 3_600_000).toISOString() }),
      { ...signed(linked,other,"approve"),notificationId: question.notificationId },
      { ...signed(linked,question,"deny"),action: "approve" },
    ];
    for (const body of cases) expect((await answer(question,linked.browserId,body)).status).toBe(400);
    expect((await answer(question,linked.browserId,{ nonsense: true })).status).toBe(400);
    // The Dashboard session is required, from the Dashboard's origin.
    const anonymous = await app.request(`/api/dashboard/questions/${question.interactionId}/answer`,{ method: "POST",
      headers: { "content-type": "application/json",origin: appUrl,"x-relo-browser": linked.browserId },
      body: JSON.stringify(signed(linked,question,"approve")) });
    expect(anonymous.status).toBe(401);
    expect((await call(session,"POST",`/api/dashboard/questions/${question.interactionId}/answer`,signed(linked,question,"approve"),
      { origin: "https://evil.example","x-relo-browser": linked.browserId })).status).toBe(403);
    const read = await call(apiKey,"GET",`/api/interactions/${question.interactionId}`);
    expect((read.body.interaction ?? read.body).state).toBe("pending");
  });

  test("a sealed question is answered only by a browser it was sealed to, bound to the envelope's context",async () => {
    const device = await phone();
    const reader = await browser(device);
    const outsider = await browser(device);
    const question = await ask(device);
    const envelope = (recipients: string[]) => ({ v: "relo.e2e.v1",kind: "question",context: "ntf:question-context",sender: `k_${b64(16)}`,
      recipients: recipients.map((device) => ({ device,prekey: "pk_1",enc: b64(65),key: b64(48) })),nonce: b64(12),ct: b64(272),sig: b64(64) });
    await db.query("UPDATE notification_events SET payload=payload||jsonb_build_object('sealed',$2::jsonb) WHERE id=$1",
      [question.notificationId.slice(4),JSON.stringify({ alerts: [{ ...envelope([device.publicId]) }],content: envelope([device.publicId,reader.browserId]) })]);
    expect((await call(session,"GET",`/api/dashboard/questions/${question.interactionId}`)).body.question.encrypted).toBe(true);
    expect(await answer(question,outsider.browserId,signed(outsider,question,"approve",{ context: "ntf:question-context" })))
      .toMatchObject({ status: 403,body: { error: "question_unreadable" } });
    expect((await answer(question,reader.browserId,signed(reader,question,"approve"))).status).toBe(400);
    expect((await answer(question,reader.browserId,signed(reader,question,"approve",{ context: "ntf:another" }))).status).toBe(400);
    const answered = await answer(question,reader.browserId,signed(reader,question,"approve",{ context: "ntf:question-context" }));
    expect(answered.status,JSON.stringify(answered.body)).toBe(201);
  });

  test("a late answer from the browser is recorded as a fact, never as the decision",async () => {
    const device = await phone();
    const linked = await browser(device);
    const question = await ask(device);
    await db.query("UPDATE interaction_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[question.interactionId.slice(4)]);
    await db.query("UPDATE interaction_requests SET state='expired',responded_at=now() WHERE id=$1",[question.interactionId.slice(4)]);
    const late = await answer(question,linked.browserId,signed(linked,question,"approve"));
    expect(late.status,JSON.stringify(late.body)).toBe(200);
    expect(late.body).toMatchObject({ late: true,state: "expired" });
    const read = await call(apiKey,"GET",`/api/interactions/${question.interactionId}`);
    const interaction = read.body.interaction ?? read.body;
    expect(interaction.state).toBe("expired");
    expect(interaction.late).toMatchObject({ state: "approved" });
  });
  // One question folded onto a card has one copy per phone, and a long one continues as a
  // notification; the computer follows exactly one copy and verifies the answer over its ids.
  describe("a question with a copy per phone",() => {
    const sender = `k_${b64(16)}`;
    const envelope = (kind: string,context: string,recipients: string[]) => ({ v: "relo.e2e.v1",kind,context,sender,
      recipients: recipients.map((device) => ({ device,prekey: "pk_1",enc: b64(65),key: b64(48) })),nonce: b64(12),ct: b64(272),sig: b64(64) });

    async function cardPhones() {
      const keys: Keys = generateKeyPair();
      const first = { ...await phone(),keys };
      const second = await phone();
      await db.query("UPDATE devices SET live_activity_authorization='authorized' WHERE principal_id=$1",[principalId]);
      return { first,second };
    }

    async function cardQuestion(body: Record<string,unknown>) {
      const started = await call(apiKey,"POST","/api/live-activities",{ key: `work-${randomUUID()}`,title: "Release",status: "Working" });
      expect(started.status,JSON.stringify(started.body)).toBe(201);
      const asked = await call(apiKey,"POST",`/api/live-activities/${started.body.activity.id}/wait`,body);
      expect(asked.status,JSON.stringify(asked.body)).toBe(201);
      const copies = (await db.query<{ id: string; event_id: string }>(
        `SELECT r.id,r.notification_event_id AS event_id FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id
         WHERE e.principal_id=$1 AND e.idempotency_key LIKE $2 ORDER BY r.id`,
        [principalId,`activity:${started.body.activity.id.slice(4)}:%:update:%`])).rows
        .map((row) => ({ interactionId: `int_${row.id}`,notificationId: `ntf_${row.event_id}` }));
      return { activityId: started.body.activity.id as string,waited: asked.body.interaction.id as string,copies };
    }

    /** What the asking computer decides about the answer it reads back (packages/cli/src/crypto/answer-verify.mjs). */
    async function computerVerdict(first: { publicId: string; keys: Keys },waited: string,questionContext?: string) {
      const read = await call(apiKey,"GET",`/api/interactions/${waited}`);
      const listing = await call(apiKey,"GET","/api/devices/keys");
      const store = { identity: {},strict: false,trusted: {
        [trustKey(appUrl,first.publicId)]: { deviceId: first.publicId,publicKey: b64u(first.keys.publicKey),level: "auto" } } };
      return { interaction: read.body.interaction,problem: answerProblem(read.body.interaction,store,appUrl,
        { interactionId: waited,...(questionContext ? { questionContext } : {}),askedAt: new Date(Date.now() - 60_000).toISOString() },
        Date.now(),{ devices: listing.body.devices }) };
    }

    test("the browser answers from Now's item id on the copy the computer waits on, and the computer accepts it",async () => {
      const { first } = await cardPhones();
      const linked = await browser(first);
      const { activityId,waited,copies } = await cardQuestion({ type: "approval",prompt: "Deploy to production?",expiresInSeconds: 600 });
      expect(copies).toHaveLength(2);
      // Now names the question by its newest copy, which need not be the one the computer follows.
      const now = await loadNowSummary(db,principalId,undefined,undefined);
      const item = now.needsYou.find((entry) => entry.id === activityId);
      expect(copies.map((copy) => copy.interactionId)).toContain(item?.question?.id);
      const asked = copies.find((copy) => copy.interactionId === waited)!;
      for (const id of [item!.question!.id,...copies.map((copy) => copy.interactionId)]) {
        const shown = await call(session,"GET",`/api/dashboard/questions/${id}`);
        expect(shown.body.question).toMatchObject({ id: waited,notificationId: asked.notificationId,state: "pending",encrypted: false });
      }
      // An answer signed for another phone's copy names a question the computer did not ask: refused, nothing decided.
      const other = copies.find((copy) => copy.interactionId !== waited)!;
      expect(await answer(other,linked.browserId,signed(linked,other,"approve"))).toMatchObject({ status: 409,body: { error: "not_asked_copy" } });
      expect((await call(apiKey,"GET",`/api/interactions/${waited}`)).body.interaction.state).toBe("pending");

      const shown = (await call(session,"GET",`/api/dashboard/questions/${item!.question!.id}`)).body.question;
      const target = { interactionId: shown.id,notificationId: shown.notificationId };
      const answered = await answer(target,linked.browserId,signed(linked,target,"approve"));
      expect(answered.status,JSON.stringify(answered.body)).toBe(201);
      const verdict = await computerVerdict(first,waited);
      expect(verdict.interaction).toMatchObject({ state: "approved",respondingDevice: { id: linked.browserId } });
      expect(verdict.problem).toBeNull();
    });

    test("a sealed question that outlives its card stays sealed: the browser answers the waiting copy, bound to the asked context",async () => {
      const { first,second } = await cardPhones();
      const linked = await browser(first);
      const context = "ntf:long-question-context";
      const phones = [first.publicId,second.publicId];
      const sealed = { alerts: phones.map((device) => envelope("question",context,[device])),
        content: envelope("question",context,[...phones,linked.browserId]) };
      const { waited,copies } = await cardQuestion({ type: "approval",expiresInSeconds: 2 * 86_400,sealed });
      expect(copies.map((copy) => copy.interactionId)).not.toContain(waited);
      for (const copy of copies) {
        const shown = (await call(session,"GET",`/api/dashboard/questions/${copy.interactionId}`,undefined,{ "x-relo-browser": linked.browserId })).body.question;
        expect(shown).toMatchObject({ id: waited,encrypted: true,readableHere: true,state: "pending" });
      }
      const shown = (await call(session,"GET",`/api/dashboard/questions/${waited}`)).body.question;
      const target = { interactionId: shown.id,notificationId: shown.notificationId };
      const answered = await answer(target,linked.browserId,signed(linked,target,"approve",{ context }));
      expect(answered.status,JSON.stringify(answered.body)).toBe(201);
      expect((await computerVerdict(first,waited,context)).problem).toBeNull();
    });

    test("a question sealed only to the phones says so to the browser, which cannot answer it",async () => {
      const { first,second } = await cardPhones();
      const linked = await browser(first);
      const phones = [first.publicId,second.publicId];
      const sealed = { alerts: phones.map((device) => envelope("question","ntf:phones-only",[device])),
        content: envelope("question","ntf:phones-only",phones) };
      const { waited,copies } = await cardQuestion({ type: "approval",expiresInSeconds: 600,sealed });
      const shown = (await call(session,"GET",`/api/dashboard/questions/${copies.at(-1)!.interactionId}`,undefined,
        { "x-relo-browser": linked.browserId })).body.question;
      expect(shown).toMatchObject({ id: waited,encrypted: true,readableHere: false });
      const target = { interactionId: shown.id,notificationId: shown.notificationId };
      expect(await answer(target,linked.browserId,signed(linked,target,"approve",{ context: "ntf:phones-only" })))
        .toMatchObject({ status: 403,body: { error: "question_unreadable" } });
    });

    test("an expired copy resolves to the asked copy's own state",async () => {
      const { first } = await cardPhones();
      await browser(first);
      const { waited,copies } = await cardQuestion({ type: "yes_no",prompt: "Keep the preview?",expiresInSeconds: 600 });
      await db.query("UPDATE interaction_requests SET state='expired',responded_at=now(),expires_at=now()-interval '1 second' WHERE id=ANY($1::uuid[])",
        [copies.map((copy) => copy.interactionId.slice(4))]);
      for (const copy of copies) {
        expect((await call(session,"GET",`/api/dashboard/questions/${copy.interactionId}`)).body.question).toMatchObject({ id: waited,state: "expired" });
      }
    });
  });
});
