import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { noRunningCards } from "./fake-cards.mjs";
import { execute, integrationProject } from "../src/cli.mjs";

function notifyHarness({ config, identity }) {
  const sent = [];
  const overrides = {
    loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44), ...config }),
    clientFactory: () => ({ sendNotification: async (body) => { sent.push(body); return { eventId: "ntf_1",
      delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 } }; } }),
    identityDefaults: () => identity,
    computerName: () => "Build Mac",
    prepareNotificationCommand: async ({ body }) => body,
  };
  return { overrides, sent };
}

test("outside a repository the project is the integration's profile or login name", () => {
  const deps = { computerName: () => "Build Mac" };
  assert.equal(integrationProject({ profile: "deploy-bot", principal: { name: "Build Mac" } }, deps), "deploy-bot");
  assert.equal(integrationProject({ profile: "default", principal: { name: "Release pipeline" } }, deps), "Release pipeline");
  assert.equal(integrationProject({ profile: "default", principal: { name: "build mac" } }, deps), undefined);
  assert.equal(integrationProject({}, deps), undefined);
});

test("an app outside git can notify without --project; a repository or --project still wins", async () => {
  const outside = notifyHarness({ config: { profile: "deploy-bot" }, identity: { providerName: "deploy-script" } });
  const sent = await execute(["notify", "Deployed", "--topic", "Release 1.4"], outside.overrides);
  assert.equal(sent.exitCode, 0);
  assert.equal(outside.sent[0].context.project, "deploy-bot");

  const inRepo = notifyHarness({ config: { profile: "deploy-bot" }, identity: { providerName: "deploy-script", project: "relo" } });
  await execute(["notify", "Deployed", "--topic", "Release 1.4"], inRepo.overrides);
  assert.equal(inRepo.sent[0].context.project, "relo");

  const explicit = notifyHarness({ config: { profile: "deploy-bot" }, identity: { providerName: "deploy-script" } });
  await execute(["notify", "Deployed", "--topic", "Release 1.4", "--project", "Website"], explicit.overrides);
  assert.equal(explicit.sent[0].context.project, "Website");
});

function startHarness({ disposition = "created", env = {} } = {}) {
  const bodies = [];
  const overrides = {
    env,
    loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44) }),
    clientFactory: () => noRunningCards({ startActivity: async (body) => { bodies.push(body);
      return { activity: { id: "act_11111111-1111-4111-8111-111111111111", state: "active", sequence: 0 },
        delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 }, queued: 1, disposition }; } }),
    identityDefaults: () => ({ providerName: "nightly-export", project: "warehouse" }),
    computerName: () => "Build Mac",
    captureActivityCommand: async ({ body }) => ({ body }),
  };
  return { overrides, bodies };
}
const start = ["activity", "start", "--title", "Export", "--status", "Exporting rows", "--topic", "Nightly export"];

test("two runs of one script share the topic's card unless --new gives each its own", async () => {
  const shared = startHarness();
  await execute(start, shared.overrides);
  await execute(start, shared.overrides);
  assert.equal(shared.bodies[0].key, shared.bodies[1].key);
  const separate = startHarness();
  await execute([...start, "--new"], separate.overrides);
  await execute([...start, "--new"], separate.overrides);
  assert.notEqual(separate.bodies[0].key, separate.bodies[1].key);
  assert.ok(separate.bodies[0].key.startsWith(shared.bodies[0].key.slice(0, 20)));
});

test("joining a card someone else started says so, except in an agent session", async () => {
  const joined = await execute(start, startHarness({ disposition: "reused" }).overrides);
  assert.match((joined.notes ?? []).join(" "), /joined the card already running.*--new/u);
  const agent = await execute(start, startHarness({ disposition: "reused", env: { RELO_SESSION: "s-1", RELO_SOURCE: "x" } }).overrides);
  assert.doesNotMatch((agent.notes ?? []).join(" "), /joined the card/u);
});
