import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { noRunningCards } from "./fake-cards.mjs";
import { detectIdentityDefaults } from "../src/shared/identity.mjs";
import { execute, run } from "../src/cli.mjs";
import { EXIT } from "../src/shared/errors.mjs";

const identity = ["--source", "Codex", "--project", "Relo", "--topic", "Release"];
const context = { providerName: "Codex", project: "Relo", threadName: "Release" };
function dependencies(client, stdin) {
  return { prepareNotificationCommand: async ({ body }) => body,captureActivityCommand: async ({ body }) => ({ target: null,ifSequence: body.ifSequence }), loadConfig: async () => ({ apiUrl: "https://relo.example",token: "x".repeat(44) }),
    clientFactory: () => noRunningCards(client),readStdinJson: async () => stdin,identityDefaults: () => ({}) };
}
const creates = [
  ["notify", "send", "Ready"], ["ask", "Continue?", "--approval"],
];

test("every creation rejects each missing or blank grouping level without an API call", async () => {
  const deps = dependencies(new Proxy({}, { get: () => () => assert.fail("must not call API") }));
  for (const command of creates) {
    for (let index = 0; index < identity.length; index += 2) {
      const absent = identity.filter((_value, slot) => slot !== index && slot !== index + 1);
      await assert.rejects(execute([...command,...absent], deps), /Missing --(source|project|topic)/);
      const blank = [...identity]; blank[index + 1] = "  ";
      await assert.rejects(execute([...command,...blank], deps), /required|empty/);
    }
    for (const field of Object.keys(context)) {
      const partial = { ...context }; delete partial[field];
      await assert.rejects(execute([...command,"--stdin"],
        dependencies({}, { context: partial })), /Missing --(source|project|topic)/);
    }
  }
  const stdout = [];
  assert.equal(await run(["notify","send","Ready","--json"],
    { stdout: value => stdout.push(value),stderr: () => {} },deps), EXIT.USAGE);
  assert.equal(JSON.parse(stdout[0]).error.code, "USAGE_ERROR");
});

test("flags and stdin creation retain complete identity", async () => {
  const bodies = [];
  const client = Object.fromEntries(["sendNotification","createInteraction","startActivity"].map(name =>
    [name, async body => { bodies.push(body); return { delivery: { eligibleDevices: 1,durableCommands: 1,apnsJobs: 0 } }; }]));
  for (const command of creates.filter((argv) => argv[0] !== "ask")) {
    await execute([...command,...identity], dependencies(client));
    await execute([...command,"--stdin"], dependencies(client, { context }));
    const [flags,stdin] = bodies.slice(-2);
    assert.deepEqual(flags.context, stdin.context);
    assert.match(flags.context.providerThreadId, /^cli-topic:[a-f0-9]{64}$/);
  }
});

test("manual topic correlation is stable, separated by source and project, and preserves provider IDs", async () => {
  const bodies = [];
  const client = { sendNotification: async body => { bodies.push(body); return { eligibleDevices: 1,durableCommands: 1,apnsJobs: 0 }; } };
  for (const patch of [{},{},{ providerName: "Build bot" },{ project: "Other" },
    { providerThreadId: "provider-thread" }]) {
    await execute(["notify","send","Ready","--stdin"], dependencies(client, { context: { ...context,...patch } }));
  }
  assert.equal(bodies[0].context.providerThreadId,bodies[1].context.providerThreadId);
  assert.notEqual(bodies[0].context.providerThreadId,bodies[2].context.providerThreadId);
  assert.notEqual(bodies[0].context.providerThreadId,bodies[3].context.providerThreadId);
  assert.equal(bodies[4].context.providerThreadId,"provider-thread");
  assert.equal(bodies[0].sourceName,"Codex");
});

test("topic alias works, duplicate selectors fail, and an end inherits the card's stored identity", async () => {
  const bodies = [];
  const client = {
    sendNotification: async body => { bodies.push(body); return { eligibleDevices: 1,durableCommands: 1,apnsJobs: 0 }; },
    endActivity: async (_id,body) => { bodies.push(body); return { eligibleDevices: 1,durableCommands: 1,apnsJobs: 0 }; },
  };
  await execute(["notify","Ready",...identity.slice(0,4),"--thread-name","Release"], dependencies(client));
  assert.equal(bodies[0].context.threadName,"Release");
  await assert.rejects(execute(["notify","Ready",...identity,"--thread-name","Other"], dependencies(client)), /either --topic/);
  await execute(["activity","end","manual"], dependencies(client));
  assert.equal(bodies[1].context,undefined);
});

test("one error names every missing field with a runnable hint, and rejects placeholders", async () => {
  const deps = dependencies(new Proxy({}, { get: () => () => assert.fail("must not call API") }));
  const stdout = [];
  const stderr = [];
  assert.equal(await run(["notify","send","Ready","--json"],
    { stdout: value => stdout.push(value),stderr: value => stderr.push(value) },deps), EXIT.USAGE);
  const error = JSON.parse(stdout[0]).error;
  assert.deepEqual(error.details.missing, ["source","project","topic"]);
  assert.match(error.hint, /--source ".+" --project ".+" --topic ".+"/);
  assert.deepEqual(stderr, []);
  await assert.rejects(execute(["notify","send","Ready","--source","Codex","--project","Project","--topic","Codex task"], deps),
    (cause) => { assert.deepEqual(cause.details.missing, ["project","topic"]); return true; });
});

test("defaults come from RELO_* variables, the calling agent, and the git repository", async () => {
  const repo = (path) => path === "/work/relo/.git";
  assert.deepEqual(detectIdentityDefaults({ CLAUDECODE: "1" }, "/work/relo/apps/ios", repo),
    { providerName: "Claude Code", project: "relo" });
  assert.deepEqual(detectIdentityDefaults({ CODEX_SANDBOX: "seatbelt" }, "/tmp", () => false), { providerName: "Codex" });
  assert.deepEqual(detectIdentityDefaults({ CODEX_HOME: "/x" }, "/tmp", () => false), {});
  assert.deepEqual(detectIdentityDefaults(
    { CLAUDECODE: "1", RELO_SOURCE: "Release bot", RELO_PROJECT: "Relo", RELO_TOPIC: "Deploys" }, "/work/relo", repo),
    { providerName: "Release bot", project: "Relo", threadName: "Deploys" });

  const bodies = [];
  const client = { sendNotification: async body => { bodies.push(body); return { eligibleDevices: 1,durableCommands: 1,apnsJobs: 0 }; } };
  await execute(["notify","send","Ready","--topic","Release"],
    { ...dependencies(client), identityDefaults: () => ({ providerName: "Claude Code", project: "relo" }) });
  assert.equal(bodies[0].context.providerName, "Claude Code");
  assert.equal(bodies[0].context.project, "relo");
  assert.equal(bodies[0].context.threadName, "Release");
  await execute(["notify","send","Ready","--project","Relo","--topic","Release"],
    { ...dependencies(client), identityDefaults: () => ({ providerName: "Claude Code", project: "relo" }) });
  assert.equal(bodies[1].context.project, "Relo", "an explicit flag beats the detected repository");
});
