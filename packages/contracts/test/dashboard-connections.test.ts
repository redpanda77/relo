import assert from "node:assert/strict";
import test from "node:test";
import { CI_TOKEN_DEFAULT_DAYS, CI_TOKEN_EXPIRY_CHOICES, CI_TOKEN_MAX_DAYS, LOGIN_SCOPES, SERVICE_SCOPES, connectionsOverviewSchema } from "../src/dashboard/connections.js";
import { FACTS } from "../src/facts.js";
import { scopesFor } from "../src/scopes.js";

const service = {
  id: "svc_1",
  title: "Shop",
  prefix: "hook_ab",
  imageUrl: null,
  destinationUrl: null,
  liveActivityPolicy: null,
  effectiveLiveActivityPolicy: { colorStrategy: "project" },
  liveActivityPolicySource: "system",
  readableAllowed: true,
  scopes: ["hooks:notify", "hooks:read"],
  lastUsedAt: "2026-10-15T08:00:00.000Z",
  createdAt: null,
};

const login = {
  id: "key_1",
  kind: "login",
  label: "Studio Mac",
  prefix: "relo_ab",
  scopes: [...LOGIN_SCOPES],
  createdAt: "2026-10-01T08:00:00.000Z",
  expiresAt: null,
  lastUsedAt: null,
  liveActivityPolicy: null,
  effectiveLiveActivityPolicy: { colorStrategy: "project" },
  liveActivityPolicySource: "system",
  maxActiveCards: null,
};
const ciToken = { ...login, id: "key_2", kind: "ci-token", label: "Deploy pipeline", scopes: ["activities:write"],
  expiresAt: "2026-11-14T08:00:00.000Z", lastUsedAt: "2026-10-15T08:00:00.000Z" };

const computer = {
  id: "cmp_1", loginId: "key_1", name: "Studio Mac", label: "studio-mac-ab", icon: "laptop", iconSource: "default",
  tools: ["claude-code"], openCards: 2, lastSeenAt: "2026-10-15T08:00:00.000Z", createdAt: "2026-10-01T08:00:00.000Z",
  expiresAt: null, prefix: "relo_ab", scopes: [...LOGIN_SCOPES], encryption: "encrypts",
  hooks: [{ id: "hck_1", name: "studio-mac", prefix: "relo_cd", createdAt: "2026-10-02T08:00:00.000Z", lastUsedAt: null }],
  liveActivityPolicy: null, effectiveLiveActivityPolicy: { colorStrategy: "project" },
  liveActivityPolicySource: "system", maxActiveCards: null, report: null, reportedAt: null,
};

function overview(services: unknown[], ciTokens: unknown[] = [], computers: unknown[] = []) {
  return {
    version: 1,
    kind: "connections",
    route: { path: "/dashboard/connections", page: 1 },
    shell: {
      title: "Connections", description: "", active: "connections", releaseIdentity: "test",
      account: { id: "acc", initial: "O", name: "Owner", email: "owner@example.test" },
      counts: { pending: 0, notifications: 0, deliveries: 0 },
    },
    summary: { services: services.length, phones: 0, clients: 0 },
    pagination: { page: 1, pageSize: 25, total: 0, pageCount: 1, previousHref: null, nextHref: null },
    phones: [], computers, unlinkedHooks: [], ciTokens, services,
  };
}

test("a service in the Connections payload carries its access settings and last use", () => {
  const parsed = connectionsOverviewSchema.parse(overview([service]));
  assert.equal(parsed.services[0]?.readableAllowed, true);
  assert.deepEqual(parsed.services[0]?.scopes, ["hooks:notify", "hooks:read"]);
  assert.equal(parsed.services[0]?.lastUsedAt, "2026-10-15T08:00:00.000Z");
  assert.equal(connectionsOverviewSchema.safeParse(overview([{ ...service, lastUsedAt: null }])).success, true);
});

test("a service's scopes come from the registry, at least one", () => {
  assert.deepEqual(SERVICE_SCOPES, scopesFor("service"));
  for (const scopes of [[], ["notifications:send"], ["hooks:everything"]]) {
    assert.equal(connectionsOverviewSchema.safeParse(overview([{ ...service, scopes }])).success, false, JSON.stringify(scopes));
  }
  const { readableAllowed: _omitted, ...withoutReadable } = service;
  assert.equal(connectionsOverviewSchema.safeParse(overview([withoutReadable])).success, false);
});

test("a CI token always expires and only CI tokens ride in ciTokens", () => {
  const parsed = connectionsOverviewSchema.parse(overview([], [ciToken]));
  assert.deepEqual(parsed.ciTokens.map((client) => client.kind), ["ci-token"]);
  const { label, scopes, expiresAt, lastUsedAt, prefix, createdAt } = parsed.ciTokens[0]!;
  assert.deepEqual({ label, scopes, expiresAt, lastUsedAt, prefix, createdAt },
    { label: "Deploy pipeline", scopes: ["activities:write"], expiresAt: ciToken.expiresAt, lastUsedAt: ciToken.lastUsedAt,
      prefix: "relo_ab", createdAt: ciToken.createdAt });
  assert.equal(connectionsOverviewSchema.safeParse(overview([], [{ ...ciToken, expiresAt: null }])).success, false);
  assert.equal(connectionsOverviewSchema.safeParse(overview([], [{ ...login, kind: "harness" }])).success, false);
  const { kind: _omitted, ...withoutKind } = login;
  assert.equal(connectionsOverviewSchema.safeParse(overview([], [withoutKind])).success, false);
});

test("a computer carries its name, icon, tools, open cards, hooks and the login's settings", () => {
  const parsed = connectionsOverviewSchema.parse(overview([], [], [computer]));
  const row = parsed.computers[0]!;
  assert.deepEqual({ id: row.id, loginId: row.loginId, name: row.name, label: row.label, icon: row.icon, iconSource: row.iconSource },
    { id: "cmp_1", loginId: "key_1", name: "Studio Mac", label: "studio-mac-ab", icon: "laptop", iconSource: "default" });
  assert.deepEqual(row.tools, ["claude-code"]);
  assert.equal(row.openCards, 2);
  assert.equal(row.hooks[0]?.id, "hck_1");
  assert.equal(connectionsOverviewSchema.safeParse(overview([], [], [{ ...computer, icon: "toaster" }])).success, false);
  assert.equal(connectionsOverviewSchema.safeParse(overview([], [], [{ ...computer, iconSource: "guess" }])).success, false);
  const { hooks: _omitted, ...withoutHooks } = computer;
  assert.equal(connectionsOverviewSchema.safeParse(overview([], [], [withoutHooks])).success, false);
});

test("the CI token form offers the login scopes and lifetimes within the facts", () => {
  assert.deepEqual(LOGIN_SCOPES, scopesFor("login"));
  assert.equal(CI_TOKEN_DEFAULT_DAYS, FACTS.credentials.ciTokenDefaultDays);
  assert.equal(CI_TOKEN_MAX_DAYS, FACTS.credentials.ciTokenMaxDays);
  assert.ok(CI_TOKEN_EXPIRY_CHOICES.every((days) => days >= 1 && days <= CI_TOKEN_MAX_DAYS));
  assert.ok((CI_TOKEN_EXPIRY_CHOICES as readonly number[]).includes(CI_TOKEN_DEFAULT_DAYS));
});

test("a computer carries the machine's report and when it arrived, or null before the first one", () => {
  const report = {
    cli: { version: "0.17.13", latest: null, update: "unknown" }, os: { platform: "linux", release: "6.8.0" }, machineKind: "server",
    harnesses: [{ id: "codex", detected: true, instructions: "set", level: "guide", modules: ["notify", "reporting", "planning"], skill: "current", hooks: "off", hooksOutdated: false, mcp: "none" }],
    settings: [{ key: "profile", source: "default", env: "RELO_PROFILE", value: "default" }],
    profiles: { count: 1, active: "default" }, doctor: null, outbox: { pending: 0 },
  };
  const parsed = connectionsOverviewSchema.parse(overview([], [], [{ ...computer, report, reportedAt: "2026-10-16T08:00:00.000Z" }]));
  assert.deepEqual(parsed.computers[0]?.report, report);
  assert.equal(connectionsOverviewSchema.parse(overview([], [], [computer])).computers[0]?.report, null);
  assert.equal(connectionsOverviewSchema.safeParse(overview([], [], [{ ...computer, report: { ...report, env: {} } }])).success, false);
});
