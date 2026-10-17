import { createECDH,randomUUID } from "node:crypto";
import { LOGIN_SCOPES } from "@relo/notification-contracts";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createAccountAuth } from "./account-auth.js";
import { createApp } from "./app.js";
import { resetAuthAttempts } from "./auth-throttle.js";
import type { ActivitySend,ApnsOutcome } from "./apns-provider-cleanroom.js";
import { generateToken,hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { dispatchInviteActivityPushes,type InviteActivitySender } from "./computer-invite-activity.js";
import { createAuthDatabase,createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { createTransportTokenEncryption } from "./token-encryption.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const appUrl = "http://127.0.0.1:8180";
const secret = "test-only-invite-activity-secret-0123456789abcdef";
const encryption = createTransportTokenEncryption(secret);
const activityToken = "ab".repeat(32);

suite("the wizard's Live Activity pushes",() => {
  let db: Database,authDb: Database,app: ReturnType<typeof createApp>,principalId: string,owner: string;
  let sent: ActivitySend[];
  let outcome: ApnsOutcome["category"];
  const sender: InviteActivitySender = {
    async sendInviteActivity(input) {
      sent.push(input);
      return { accepted: outcome === "accepted",category: outcome,attempt: 1,apnsId: "x",payloadBytes: 1 } as ApnsOutcome;
    },
  };
  const dispatch = () => dispatchInviteActivityPushes(db,{ sender,encryption,environment: "sandbox",now: () => new Date(1_800_000_000_000) });

  beforeAll(async () => {
    resetAuthAttempts();
    db = createDatabase(databaseUrl!);
    authDb = createAuthDatabase(databaseUrl!);
    await migrate(db);
    app = createApp(db,{ accountAuth: createAccountAuth(authDb,appUrl,secret),bootstrapOwnerHandle: "owner",
      credentialDerivationSecret: secret,appUrl,apnsMode: "sandbox" });
  });
  afterAll(async () => { await Promise.all([db.end(),authDb.end()]); });
  beforeEach(async () => {
    sent = [];
    outcome = "accepted";
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    owner = "invite_activity_owner_abcdefghijklmnopqrstuvwxyz_0123456";
    await bootstrapOwner(db,"owner",owner);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  });

  async function call(token: string | null,method: string,path: string,body?: unknown) {
    const response = await app.request(path,{ method,headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json","idempotency-key": randomUUID() },body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }
  async function phone(account = principalId) {
    const id = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment) VALUES ($1,$2,$3,'iPhone','com.example.relo.notifications','1','1','26','sandbox')
      RETURNING id`,[account,randomUUID(),randomUUID()])).rows[0]!.id;
    const credential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read'])",
      [id,hashToken(credential)]);
    return credential;
  }
  const report = { cli: { version: "0.17.40",latest: null,update: "current" },os: { platform: "linux",release: "6.8" },machineKind: "server",
    harnesses: [
      { id: "claude-code",detected: true,instructions: "set",level: "guide",modules: [],skill: "current",hooks: "presence",hooksOutdated: false,mcp: "none" },
      { id: "codex",detected: true,instructions: "set",level: "none",modules: [],skill: "current",hooks: "presence",hooksOutdated: false,mcp: "none" }],
    settings: [],profiles: { count: 1,active: "default" },doctor: { at: "2026-10-17T10:00:00Z",ok: true,failing: [] },outbox: { pending: 0 } };

  test("the token route: scope, 404 for unknown or another account's invite, 400 for a bad token, sealed at rest",async () => {
    const credential = await phone();
    const made = await call(credential,"POST","/api/devices/self/computer-invites",{});
    const path = `/api/devices/self/computer-invites/${made.body.inviteId}/activity`;
    expect((await call(null,"PUT",path,{ pushToken: activityToken })).status).toBe(401);
    expect((await call(owner,"PUT",path,{ pushToken: activityToken })).status).toBeGreaterThanOrEqual(401);
    expect((await call(credential,"PUT",path,{ pushToken: "not hex" })).status).toBe(400);
    expect((await call(credential,"PUT",`/api/devices/self/computer-invites/cin_${randomUUID()}/activity`,{ pushToken: activityToken })).status).toBe(404);
    expect((await call(credential,"PUT","/api/devices/self/computer-invites/nope/activity",{ pushToken: activityToken })).status).toBe(404);
    const otherId = (await db.query<{ id: string }>("INSERT INTO owner_principals(handle) VALUES ('other') RETURNING id")).rows[0]!.id;
    expect((await call(await phone(otherId),"PUT",path,{ pushToken: activityToken })).status).toBe(404);
    expect((await db.query("SELECT activity_push_token FROM computer_invites")).rows[0].activity_push_token).toBeNull();
    const response = await app.request(path,{ method: "PUT",headers: { authorization: `Bearer ${credential}`,"content-type": "application/json" },
      body: JSON.stringify({ pushToken: activityToken.toUpperCase() }) });
    expect(response.status).toBe(204);
    const row = (await db.query("SELECT activity_push_token,activity_device_id FROM computer_invites")).rows[0];
    expect(row.activity_push_token).not.toContain(activityToken);
    expect(encryption.decrypt(row.activity_push_token,"computer_invite_activity.token")).toBe(activityToken);
    expect(row.activity_device_id).not.toBeNull();
  });

  test("redemption, key and report each push one update; reported ends it with a dismissal date and clears the token",async () => {
    const credential = await phone();
    const made = await call(credential,"POST","/api/devices/self/computer-invites",{});
    await call(credential,"PUT",`/api/devices/self/computer-invites/${made.body.inviteId}/activity`,{ pushToken: activityToken });
    // Registered while waiting: the activity already shows waiting, so nothing is pushed.
    await dispatch();
    expect(sent).toHaveLength(0);

    const joined = await call(null,"POST","/api/computer-invites/redeem",{ code: made.body.code,clientName: "build-box",scopes: LOGIN_SCOPES,expiresInSeconds: 86_400 });
    const cli = joined.body.accessToken as string;
    await dispatch();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ operation: "update",contentState: { state: "redeemed",computerName: "build-box",agents: [],updatedAt: 1_800_000_000 } });
    expect(sent[0]!.dismissalDate).toBeUndefined();
    expect(await sent[0]!.recipient.resolve()).toMatchObject({ token: activityToken });

    // Nothing moved: no duplicate push.
    await db.query("UPDATE computer_invites SET activity_push_pending=true");
    await dispatch();
    expect(sent).toHaveLength(1);

    await call(cli,"PUT","/api/clients/self/keys",{ identityKey: createECDH("prime256v1").generateKeys().toString("base64url") });
    await dispatch();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ operation: "update",contentState: { state: "key_published",computerName: "build-box",agents: [] } });

    expect((await call(cli,"PUT","/api/computers/self/report",report)).status).toBe(204);
    const cycle = await dispatch();
    expect(cycle.ended).toBe(1);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ operation: "end",dismissalDate: 1_800_000_000 + 900,
      contentState: { state: "reported",computerName: "build-box",agents: ["claude-code"],updatedAt: 1_800_000_000 } });
    const row = (await db.query("SELECT activity_push_token,activity_device_id,activity_last_state FROM computer_invites")).rows[0];
    expect(row).toEqual({ activity_push_token: null,activity_device_id: null,activity_last_state: "reported" });
    // The token is gone: later events push nothing.
    await call(cli,"PUT","/api/computers/self/report",report);
    await dispatch();
    expect(sent).toHaveLength(3);
  });

  test("no token, no push; a push APNs refuses drops the token; a retryable failure is tried again",async () => {
    const credential = await phone();
    const made = await call(credential,"POST","/api/devices/self/computer-invites",{});
    await call(null,"POST","/api/computer-invites/redeem",{ code: made.body.code,clientName: "build-box",scopes: LOGIN_SCOPES,expiresInSeconds: 86_400 });
    await dispatch();
    expect(sent).toHaveLength(0);

    const second = await call(credential,"POST","/api/devices/self/computer-invites",{});
    await call(credential,"PUT",`/api/devices/self/computer-invites/${second.body.inviteId}/activity`,{ pushToken: activityToken });
    await call(null,"POST","/api/computer-invites/redeem",{ code: second.body.code,clientName: "other-box",scopes: LOGIN_SCOPES,expiresInSeconds: 86_400 });
    outcome = "indeterminate-transport";
    expect((await dispatch()).retried).toBe(1);
    expect(sent).toHaveLength(1);
    outcome = "accepted";
    await dispatch();
    expect(sent).toHaveLength(2);
    outcome = "stale-recipient";
    await db.query("UPDATE computer_invites SET activity_last_state='waiting',activity_push_pending=true WHERE activity_push_token IS NOT NULL");
    expect((await dispatch()).dropped).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM computer_invites WHERE activity_push_token IS NOT NULL")).rows[0].n).toBe(0);
  });
});
