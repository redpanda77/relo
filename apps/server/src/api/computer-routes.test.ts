import { COMPUTER_ICONS,FACTS } from "@relo/notification-contracts";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { bootstrapOwner } from "../bootstrap.js";
import { loadComputerRecords } from "../computers/record.js";
import { effectiveIcon,findComputerByLogin,listComputers } from "../computers/store.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";

/** ADR 0011, plan 11 step 4.5: a computer reports its own setup; only a login's computer, only its own row. */
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("computer report route",() => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  const owner = "report_owner_abcdefghijklmnopqrstuvwxyz0123456789";
  const other = "report_other_abcdefghijklmnopqrstuvwxyz0123456789";
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); app = createApp(db,{ apnsMode: "disabled" }); });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    await bootstrapOwner(db,"owner",owner);
    await bootstrapOwner(db,"other",other);
  });

  const report = (patch: Record<string,unknown> = {}) => ({
    cli: { version: "0.17.13",latest: "0.17.14",update: "behind" },
    os: { platform: "darwin",release: "25.0.0" },
    machineKind: "laptop",
    harnesses: [{ id: "claude-code",detected: true,instructions: "set", level: "guide", modules: ["notify", "reporting", "planning"],skill: "current",hooks: "presence",hooksOutdated: false,mcp: "none" }],
    settings: [{ key: "server",source: "config",env: "RELO_API_URL",value: "https://relo.example.test" },{ key: "computer",source: "env",env: "RELO_COMPUTER" }],
    profiles: { count: 1,active: "default" },
    doctor: { at: "2026-10-16T09:00:00.000Z",ok: true,failing: [] },
    outbox: { pending: 0 },
    ...patch,
  });
  const put = async (token: string,body: unknown,raw?: string) => {
    const response = await app.request("/api/computers/self/report",{ method: "PUT",
      headers: { authorization: `Bearer ${token}`,"content-type": "application/json","idempotency-key": crypto.randomUUID() },
      body: raw ?? JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  };
  const loginIdOf = async (handle: string) => (await db.query<{ id: string }>(
    "SELECT k.id FROM principal_api_keys k JOIN owner_principals p ON p.id=k.principal_id WHERE p.handle=$1 AND k.kind='login'",[handle])).rows[0]!.id;
  const stored = async (handle: string) => (await db.query<{ report: any; report_hash: string | null; reported_at: Date | null }>(
    `SELECT c.report,c.report_hash,c.reported_at FROM computers c JOIN principal_api_keys k ON k.id=c.login_key_id
     JOIN owner_principals p ON p.id=k.principal_id WHERE p.handle=$1`,[handle])).rows[0]!;

  test("it stores the report on the caller's own computer, replaces it, and answers 204",async () => {
    expect((await stored("owner")).report).toBeNull();
    expect((await put(owner,report())).status).toBe(204);
    const first = await stored("owner");
    expect(first.report).toEqual(report());
    expect(first.report_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.reported_at).toBeInstanceOf(Date);

    expect((await put(owner,report({ cli: { version: "0.17.14",latest: "0.17.14",update: "current" },machineKind: "desktop" }))).status).toBe(204);
    const second = await stored("owner");
    expect(second.report.cli.version).toBe("0.17.14");
    expect(second.report_hash).not.toBe(first.report_hash);
    expect(Number((await db.query("SELECT count(*) AS n FROM computers c JOIN owner_principals p ON p.id=c.principal_id WHERE p.handle='owner'")).rows[0].n)).toBe(1);
  });

  test("the Connections record carries the stored report and its time, and the machine kind becomes the detected icon",async () => {
    const principalId = (await db.query<{ id: string }>("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0]!.id;
    const before = (await loadComputerRecords(db,principalId,25))[0]!;
    expect(before.report).toBeNull();
    expect(before.reportedAt).toBeNull();
    expect(before.iconSource).toBe("default");
    await put(owner,report({ machineKind: "server" }));
    const after = (await loadComputerRecords(db,principalId,25))[0]!;
    expect(after.report).toEqual(report({ machineKind: "server" }));
    expect(Date.parse(after.reportedAt!)).toBeGreaterThan(Date.now() - 60_000);
    expect(after.icon).toBe("server");
    expect(after.iconSource).toBe("detected");
    const row = (await listComputers(db,principalId,25))[0]!;
    expect(effectiveIcon(row).source).toBe("detected");
    expect(COMPUTER_ICONS).toContain(after.icon);
  });

  test("it only ever writes the caller's own computer: another account's stays empty",async () => {
    await put(owner,report());
    expect((await stored("other")).report).toBeNull();
    await put(other,report({ machineKind: "build" }));
    expect((await stored("owner")).report.machineKind).toBe("laptop");
    expect((await stored("other")).report.machineKind).toBe("build");
    const owners = await findComputerByLogin(db,await loginIdOf("owner"));
    const others = await findComputerByLogin(db,await loginIdOf("other"));
    expect(owners?.id).not.toBe(others?.id);
  });

  test("a CI token, a hooks credential and a body that names a computer are refused",async () => {
    const made = await app.request("/api/credentials",{ method: "POST",
      headers: { authorization: `Bearer ${owner}`,"content-type": "application/json","idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ name: "Pipeline",scopes: ["services:write"] }) });
    const ci = (await made.json() as any).token as string;
    const refused = await put(ci,report());
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("computer_report_not_allowed");
    const hooks = await app.request("/api/harness-credentials",{ method: "POST",
      headers: { authorization: `Bearer ${owner}`,"content-type": "application/json","idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ name: "owner hooks" }) });
    const hooksToken = (await hooks.json() as any).token as string;
    expect((await put(hooksToken,report())).status).toBe(403);
    expect((await stored("owner")).report).toBeNull();
    expect((await put(owner,{ ...report(),computerId: "cmp_00000000-0000-4000-8000-000000000000" })).status).toBe(400);
    expect((await put("not-a-token",report())).status).toBe(401);
  });

  test("a report over the cap is 413, and the schema is strict: unknown keys, bad values and bad JSON are 400",async () => {
    const huge = report({ settings: [{ key: "server",source: "config",value: "x".repeat(FACTS.computers.reportMaxBytes) }] });
    expect((await put(owner,huge)).status).toBe(413);
    expect((await put(owner,report({ env: { HOME: "/Users/x" } }))).status).toBe(400);
    expect((await put(owner,report({ os: { platform: "plan9",release: "1" } }))).status).toBe(400);
    expect((await put(owner,report({ settings: [{ key: "x",source: "env",token: "secret" }] }))).status).toBe(400);
    expect((await put(owner,null,"{not json")).status).toBe(400);
    expect((await stored("owner")).report).toBeNull();
  });
  const rename = async (token: string,body: unknown) => {
    const response = await app.request("/api/computers/self",{ method: "PUT",
      headers: { authorization: `Bearer ${token}`,"content-type": "application/json","idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  };
  const identity = async (handle: string) => (await db.query<{ display_name: string | null; icon: string | null; label: string }>(
    `SELECT c.display_name,c.icon,k.label FROM computers c JOIN principal_api_keys k ON k.id=c.login_key_id
     JOIN owner_principals p ON p.id=k.principal_id WHERE p.handle=$1`,[handle])).rows[0]!;

  test("PUT /api/computers/self sets the caller's own name and icon, never the login's label, and null clears",async () => {
    const label = (await identity("owner")).label;
    expect((await rename(owner,{ name: "  Studio Mac ",icon: "desktop" })).status).toBe(204);
    expect(await identity("owner")).toEqual({ display_name: "Studio Mac",icon: "desktop",label });
    expect((await rename(owner,{ icon: "cloud" })).status).toBe(204);
    expect(await identity("owner")).toMatchObject({ display_name: "Studio Mac",icon: "cloud" });
    expect((await identity("other")).display_name).toBeNull();
    expect((await rename(owner,{ name: null,icon: null })).status).toBe(204);
    expect(await identity("owner")).toEqual({ display_name: null,icon: null,label });
  });

  test("PUT /api/computers/self refuses a CI token and a hooks credential, an empty or unknown body, and a named computer",async () => {
    const made = await app.request("/api/credentials",{ method: "POST",
      headers: { authorization: `Bearer ${owner}`,"content-type": "application/json","idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ name: "Pipeline",scopes: ["services:write"] }) });
    const ci = (await made.json() as any).token as string;
    expect((await rename(ci,{ name: "x" })).status).toBe(403);
    const hooks = await app.request("/api/harness-credentials",{ method: "POST",
      headers: { authorization: `Bearer ${owner}`,"content-type": "application/json","idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ name: "owner hooks" }) });
    expect((await rename((await hooks.json() as any).token,{ name: "x" })).status).toBe(403);
    expect((await rename(owner,{})).status).toBe(400);
    expect((await rename(owner,{ name: "" })).status).toBe(400);
    expect((await rename(owner,{ name: "x".repeat(81) })).status).toBe(400);
    expect((await rename(owner,{ icon: "spaceship" })).status).toBe(400);
    expect((await rename(owner,{ name: "x",computerId: "cmp_00000000-0000-4000-8000-000000000000" })).status).toBe(400);
    expect((await rename("not-a-token",{ name: "x" })).status).toBe(401);
    expect(await identity("owner")).toMatchObject({ display_name: null,icon: null });
  });
});
