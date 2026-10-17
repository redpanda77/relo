import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { ApiChangeListener } from "../api-change-listener.js";
import { createApp } from "../app.js";
import { bootstrapOwner } from "../bootstrap.js";
import { CurrentChangeHub } from "../current-change-hub.js";
import { createDatabase, type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { DASHBOARD_CHANGED_FRAME, registerDashboardEventRoutes } from "./dashboard-events.js";
import type { OwnerAccount } from "./owner-account.js";

const appOrigin = "http://127.0.0.1:8180";

function owner(principalId: string, sessionId = randomUUID()): OwnerAccount {
  return {
    principalId, accountId: `acc_${principalId}`,
    session: { id: sessionId, userId: `user-${principalId}`, expiresAt: new Date(Date.now() + 3_600_000) },
    user: { id: `user-${principalId}`, name: "Owner", email: "owner@example.test" },
  };
}

type Stream = { reader: ReadableStreamDefaultReader<Uint8Array>; abort: AbortController };
const streams: Stream[] = [];

async function frame(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 1_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([reader.read(), new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
const text = (result: Awaited<ReturnType<typeof frame>>) =>
  result === "timeout" ? "timeout" : result.done ? "done" : new TextDecoder().decode(result.value);

async function connect(app: Hono, cookie = "session=a", headers: Record<string, string> = {}) {
  const abort = new AbortController();
  const response = await app.request("/api/dashboard/events", { signal: abort.signal, headers: { cookie, ...headers } });
  if (response.status === 200) streams.push({ reader: response.body!.getReader(), abort });
  return response;
}

afterEach(async () => {
  for (const stream of streams.splice(0)) { stream.abort.abort(); await stream.reader.cancel().catch(() => {}); }
});

describe("GET /api/dashboard/events", () => {
  let hub: CurrentChangeHub;
  let sessions: Map<string, OwnerAccount>;
  let app: Hono;
  const a = randomUUID(), b = randomUUID();
  const notify = (principalId: string, subjectId: string | null = null) =>
    hub.receive({ channel: "relo_current_changes", processId: 1, payload: JSON.stringify({ principalId, subjectId }) });

  beforeEach(() => {
    hub = new CurrentChangeHub();
    sessions = new Map([["session=a", owner(a)], ["session=b", owner(b)]]);
    app = new Hono();
    registerDashboardEventRoutes(app, {
      hub, appOrigin,
      getAccount: async headers => sessions.get(headers.get("cookie") ?? "") ?? null,
    }, { keepaliveMs: 100, writeTimeoutMs: 1_000 });
  });
  afterEach(() => hub.close());

  test("without a signed-in session it answers 401 and opens nothing", async () => {
    const response = await connect(app, "");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  test("a foreign Origin is refused; the same origin is allowed", async () => {
    expect((await connect(app, "session=a", { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await connect(app, "session=a", { origin: appOrigin })).status).toBe(200);
  });

  test("streams hints with no-store, unbuffered SSE headers; the connect hint comes first", async () => {
    const response = await connect(app);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(text(await frame(streams[0]!.reader))).toBe(DASHBOARD_CHANGED_FRAME);
  });

  test("a change for the owner wakes their stream with a hint carrying no ids or state; another owner's change does not", async () => {
    await connect(app, "session=a");
    await connect(app, "session=b");
    const [streamA, streamB] = streams;
    expect(text(await frame(streamA!.reader))).toBe(DASHBOARD_CHANGED_FRAME);
    expect(text(await frame(streamB!.reader))).toBe(DASHBOARD_CHANGED_FRAME);
    const subject = `sub_${randomUUID()}`;
    notify(a, subject);
    expect(text(await frame(streamA!.reader))).toBe(DASHBOARD_CHANGED_FRAME);
    expect(DASHBOARD_CHANGED_FRAME).not.toContain(subject);
    // B only ever sees keepalives.
    expect(text(await frame(streamB!.reader, 300))).toBe(": keepalive\n\n");
  });

  test("an idle stream sends keepalive comments", async () => {
    await connect(app);
    await frame(streams[0]!.reader);
    expect(text(await frame(streams[0]!.reader, 500))).toBe(": keepalive\n\n");
  });

  test("signing out closes the open stream at its next wake", async () => {
    await connect(app);
    await frame(streams[0]!.reader);
    sessions.delete("session=a");
    notify(a);
    expect(text(await frame(streams[0]!.reader))).toBe("done");
  });

  test("the stream limit counts per browser session, not per owner", async () => {
    for (let index = 0; index < 16; index++) expect((await connect(app, "session=a")).status).toBe(200);
    expect((await connect(app, "session=a")).status).toBe(429);
    sessions.set("session=a2", owner(a));
    expect((await connect(app, "session=a2")).status).toBe(200);
  });

  test("without a change hub the route answers 503", async () => {
    const bare = new Hono();
    registerDashboardEventRoutes(bare, { hub: undefined, appOrigin, getAccount: async () => owner(a) });
    expect((await bare.request("/api/dashboard/events")).status).toBe(503);
  });
});

describe("createApp wiring", () => {
  test("the integrated app serves the route and refuses a request without a session", async () => {
    const db = { query: async () => ({ rows: [], rowCount: 0 }) };
    const accountAuth = { api: { getSession: async () => null }, handler: async () => new Response("null") };
    const app = createApp(db as any, { accountAuth: accountAuth as any, bootstrapOwnerHandle: "owner", appUrl: appOrigin,
      credentialDerivationSecret: "test-only-dashboard-events-secret-0123456789abcdef", apnsMode: "disabled", currentChanges: new CurrentChangeHub() });
    const response = await app.request("/api/dashboard/events");
    expect(response.status).toBe(401);
  });
});

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("dashboard hints from committed writes (PostgreSQL NOTIFY)", () => {
  let db: Database, bus: ApiChangeListener, app: Hono, principals: string[];
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");
    principals = [];
    for (const handle of ["dash-a", "dash-b"]) {
      await bootstrapOwner(db, handle, `${handle}-owner-token-abcdefghijklmnopqrstuvwxyz`);
      principals.push((await db.query("SELECT id FROM owner_principals WHERE handle=$1", [handle])).rows[0].id);
    }
    bus = await ApiChangeListener.listen(db);
    const accounts = new Map([["session=a", owner(principals[0]!)], ["session=b", owner(principals[1]!)]]);
    app = new Hono();
    registerDashboardEventRoutes(app, { hub: bus.current, appOrigin,
      getAccount: async headers => accounts.get(headers.get("cookie") ?? "") ?? null }, { keepaliveMs: 200, writeTimeoutMs: 1_000 });
  });
  afterEach(async () => { await bus?.close(); });
  afterAll(async () => { await db.end(); });

  test("a committed notification for owner A hints A's Dashboard within a second and never B's", async () => {
    await connect(app, "session=a");
    await connect(app, "session=b");
    const [streamA, streamB] = streams;
    await frame(streamA!.reader); await frame(streamB!.reader);
    await db.query(`INSERT INTO notification_events(principal_id,source,title,body,idempotency_key)
      VALUES ($1,'Dashboard','Title','Private body',$2)`, [principals[0], randomUUID()]);
    expect(text(await frame(streamA!.reader))).toBe(DASHBOARD_CHANGED_FRAME);
    expect(text(await frame(streamB!.reader, 500))).toBe(": keepalive\n\n");
  });
});
