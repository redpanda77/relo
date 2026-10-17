import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
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

const start = ["activity", "start", "--title", "Export", "--status", "Exporting rows", "--topic", "Nightly export"];

