import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../app.js";
import { generateToken, hashToken } from "../auth.js";
import { recordObservedSnapshot } from "../agent-sessions.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase, type Database } from "../db.js";
import { migrate } from "../migrate.js";
import type { SealedEnvelope } from "../sealed-content.js";
import { createDashboardInboxHandlers, type InboxDashboardBootstrap } from "./dashboard-inbox.js";

const b64 = (length: number) => randomBytes(length).toString("base64url");

/** Well-formed envelopes; the server checks shape only and never opens them. */
function envelope(devices: string[], kind: SealedEnvelope["kind"] = "notice"): SealedEnvelope {
  return {
    v: "relo.e2e.v1", kind, context: "acct:a/idem:1", sender: "k_AAAAAAAAAAAAAAAAAAAAAA",
    recipients: devices.map((device) => ({ device, prekey: "pk_1", enc: b64(65), key: b64(48) })),
    nonce: b64(12), ct: b64(256 + 16), sig: b64(64),
  };
}

/** Nothing of an envelope may reach the Dashboard: only the `encrypted` boolean. */
function expectNoEnvelopes(bootstrap: unknown, sealed: Array<{ content: SealedEnvelope }>) {
  const json = JSON.stringify(bootstrap);
  expect(json).not.toContain("relo.e2e.v1");
  expect(json).not.toContain("\"sealed\"");
  for (const item of sealed) {
    expect(json).not.toContain(item.content.ct);
    expect(json).not.toContain(item.content.sig);
  }
}

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Dashboard marks end-to-end sealed items without their envelopes (ADR 0005)", () => {
  let db: Database, principalId: string, app: ReturnType<typeof createApp>;
  const owner = "dashboard_sealed_owner_abcdefghijklmnopqrstuvwxy0";
  const secret = "dashboard-sealed-secret-with-at-least-32-characters";
  const context = { providerName: "Claude Code", project: "p-abcdefghijklmnop", threadName: "t-abcdefghijklmnop" };

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db, { apnsMode: "sandbox", credentialDerivationSecret: secret });
  });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE"); await bootstrapOwner(db, "owner", owner);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  });

  async function request(method: string, path: string, body: unknown) {
    const response = await app.request(path, { method, headers: { authorization: `Bearer ${owner}`, "content-type": "application/json",
      "idempotency-key": randomUUID() }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  }
  async function cardPhone() {
    const id = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,apns_token,
      live_activity_authorization,live_activity_push_to_start_token) VALUES ($1,$2,$3,'Phone',
      'com.example.relo.notifications','1','1','26','sandbox','authorized','fixture-alert','authorized','fixture-start') RETURNING id`,
    [principalId, randomUUID(), randomUUID()])).rows[0]!.id;
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read'])",
      [id, hashToken(generateToken())]);
    return { id, publicId: `dev_${id}` };
  }
  function dashboard() {
    const web = new Hono();
    const handlers = createDashboardInboxHandlers({
      db, releaseIdentity: "test-release",
      getAccount: async () => ({ principalId, accountId: "acc_test", user: { name: "Owner", email: "owner@example.test" } }),
      renderDocument: async (bootstrap) => JSON.stringify(bootstrap),
    });
    web.get("/dashboard", handlers.overview);
    web.get("/dashboard/inbox/notifications", handlers.history);
    web.get("/dashboard/inbox/notifications/:notificationId", handlers.detail);
    web.get("/dashboard/inbox/delivery", handlers.delivery);
    return async <Kind extends InboxDashboardBootstrap["kind"]>(path: string) => {
      const response = await web.request(path);
      expect(response.status).toBe(200);
      return JSON.parse(await response.text()) as Extract<InboxDashboardBootstrap, { kind: Kind }>;
    };
  }

  test("sealed notices, questions and cards say encrypted; readable ones do not", async () => {
    const phone = await cardPhone();
    const sealedNotice = { alerts: [envelope([phone.publicId])], content: envelope([phone.publicId]) };
    const sealedQuestion = { alerts: [envelope([phone.publicId], "question")], content: envelope([phone.publicId], "question") };
    const sealedCard = { alerts: [envelope([phone.publicId], "card")], content: envelope([phone.publicId], "card") };
    const sealed = [sealedNotice, sealedQuestion, sealedCard];

    const notice = await request("POST", "/api/notifications", { sourceName: "Claude Code", context, sealed: sealedNotice });
    expect(notice.status).toBe(201);
    const plain = await request("POST", "/api/notifications", { sourceName: "Claude Code", title: "Build passed", body: "All green" });
    expect(plain.status).toBe(201);
    const question = await request("POST", "/api/interactions", { type: "approval", context, answerInApp: true, sealed: sealedQuestion });
    expect(question.status).toBe(201);
    const card = await request("POST", "/api/live-activities", { key: "sealed-card", title: "Encrypted card", status: "Updating…",
      context, deviceIds: [phone.publicId], sealed: sealedCard });
    expect(card.status).toBe(201);
    const plainCard = await request("POST", "/api/live-activities", { key: "plain-card", title: "Release", status: "Working",
      deviceIds: [phone.publicId] });
    expect(plainCard.status).toBe(201);

    const read = dashboard();
    const overview = await read<"inbox-overview">("/dashboard");
    expectNoEnvelopes(overview, sealed);
    const byId = new Map(overview.recentNotifications.map((item) => [item.id, item]));
    expect(byId.get(notice.body.eventId)?.encrypted).toBe(true);
    expect(byId.get(plain.body.eventId)?.encrypted).toBe(false);
    expect(byId.get(question.body.eventId)?.encrypted).toBe(true);
    const cardRow = overview.recentNotifications.find((item) => item.activity?.id === card.body.activity.id)!;
    expect(cardRow).toMatchObject({ encrypted: true, activity: { encrypted: true, title: "Encrypted card" } });
    const plainCardRow = overview.recentNotifications.find((item) => item.activity?.id === plainCard.body.activity.id)!;
    expect(plainCardRow).toMatchObject({ encrypted: false, activity: { encrypted: false, title: "Release" } });
    expect(overview.runningActivities?.find((item) => item.activity?.id === card.body.activity.id)?.encrypted).toBe(true);
    const pending = overview.pendingResponses.find((item) => item.notificationId === question.body.eventId);
    expect(pending?.encrypted).toBe(true);

    const history = await read<"notification-history">("/dashboard/inbox/notifications");
    expectNoEnvelopes(history, sealed);
    expect(history.notifications.find((item) => item.id === notice.body.eventId)?.encrypted).toBe(true);
    expect(history.notifications.find((item) => item.id === plain.body.eventId)?.encrypted).toBe(false);

    const delivery = await read<"delivery-history">("/dashboard/inbox/delivery");
    expectNoEnvelopes(delivery, sealed);
    expect(delivery.deliveries.find((item) => item.notificationId === notice.body.eventId)?.encrypted).toBe(true);
    expect(delivery.deliveries.find((item) => item.notificationId === plain.body.eventId)?.encrypted).toBe(false);

    const sealedDetail = await read<"notification-detail">(`/dashboard/inbox/notifications/${notice.body.eventId}`);
    expectNoEnvelopes(sealedDetail, sealed);
    expect(sealedDetail.notification.encrypted).toBe(true);
    const plainDetail = await read<"notification-detail">(`/dashboard/inbox/notifications/${plain.body.eventId}`);
    expect(plainDetail.notification.encrypted).toBe(false);
    const questionDetail = await read<"notification-detail">(`/dashboard/inbox/notifications/${question.body.eventId}`);
    expectNoEnvelopes(questionDetail, sealed);
    expect(questionDetail.interaction?.encrypted).toBe(true);
    const cardDetail = await read<"notification-detail">(`/dashboard/inbox/notifications/${cardRow.id}`);
    expectNoEnvelopes(cardDetail, sealed);
    expect(cardDetail.notification.encrypted).toBe(true);
    expect(cardDetail.activity?.encrypted).toBe(true);
  });
  test("pages name the agent sessions whose sealed names cover their handles, ids only", async () => {
    const phone = await cardPhone();
    const sealedCard = { alerts: [envelope([phone.publicId], "card")], content: envelope([phone.publicId], "card") };
    const card = await request("POST", "/api/live-activities", { key: "named-card", title: "Encrypted card", status: "Updating…",
      context, deviceIds: [phone.publicId], sealed: sealedCard });
    expect(card.status).toBe(201);
    const names = envelope([phone.publicId], "names" as SealedEnvelope["kind"]);
    const now = new Date().toISOString();
    const session = async (hash: string, project: string, sealedNames?: unknown) => recordObservedSnapshot(db, principalId, {
      session: hash, harness: "claude-code", phase: "working", phaseSince: now, lastSeenAt: now, openToolSince: null, seq: 1,
      project, ...(sealedNames ? { sealedNames } : {}) });
    await session("named-session-0000000000", context.project, names);
    await session("unsealed-session-00000000", context.project);
    await session("other-session-0000000000", "p-qqqqqqqqqqqqqqqq", envelope([phone.publicId], "names" as SealedEnvelope["kind"]));
    const named = (await db.query<{ id: string }>("SELECT id FROM agent_sessions WHERE session_hash='named-session-0000000000'")).rows[0]!.id;

    const read = dashboard();
    const history = await read<"notification-history">("/dashboard/inbox/notifications");
    expect(history.namesFrom).toEqual([`ags_${named}`]);
    expectNoEnvelopes(history, [{ content: names }]);
    const row = history.notifications.find((item) => item.activity?.id === card.body.activity.id)!;
    expect(row.activity?.context.project).toBe(context.project);
    const detail = await read<"notification-detail">(`/dashboard/inbox/notifications/${row.id}`);
    expect(detail.namesFrom).toEqual([`ags_${named}`]);
    expectNoEnvelopes(detail, [{ content: names }]);
    expect((await read<"inbox-overview">("/dashboard")).namesFrom).toContain(`ags_${named}`);

  });
});
