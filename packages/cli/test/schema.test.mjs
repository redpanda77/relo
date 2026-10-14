import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execute, run, EXIT } from "../src/cli.mjs";
import { COMMANDS, OPTIONS } from "../src/schema.mjs";

const sentinel = new Error("stop-before-network");
const offline = {
  loadConfig: async () => ({ apiUrl: "https://relo.example",token: "x".repeat(44) }),
  clientFactory: () => new Proxy({},{ get: () => async () => { throw sentinel; } }),
  identityDefaults: () => ({ providerName: "Codex",project: "Relo",threadName: "Release" }),
  readStdinJson: async () => ({}),
  readTextFile: async () => "callback-token-0123456789",
  fetchImpl: async () => { throw sentinel; },
  openBrowser: () => {},
  prepareNotificationCommand: async ({ body }) => body,
  captureActivityCommand: async ({ body }) => ({ target: null,ifSequence: body.ifSequence }),
};
const positionals = {
  "notify send": ["Ready"],"notify withdraw": ["ntf_x"],"interaction get": ["int_x"],
  "interaction wait": ["int_x"],"interaction cancel": ["int_x"],"activity update": ["deploy"],"activity end": ["deploy"],
  "activity get": ["deploy"],"auth switch": ["work"],"activity diagnose": ["deploy"],"keys verify": ["dev_0123456789abcdef"],"keys approve": ["dev_0123456789abcdef"],"keys remove": ["dev_0123456789abcdef"],"keys require": ["on"],"keys strict": ["on"],"keys forget": ["dev_0123456789abcdef"],"delivery reconcile": ["job","retry"],
};
const allOptions = Object.keys(OPTIONS);
const scratchFile = join(tmpdir(),`relo-schema-test-${process.pid}`);
const argument = (name) => OPTIONS[name].type === "boolean" ? [`--${name}`]
  : [`--${name}`,name.endsWith("-file") ? scratchFile : "x"];
test.after(() => rmSync(scratchFile,{ force: true }));
// `setup` writes files: its option sweep runs entirely inside a throwaway home and working folder.
const sandbox = mkdtempSync(join(tmpdir(),"relo-schema-setup-"));
test.after(() => rmSync(sandbox,{ recursive: true,force: true }));
async function rejection(argv) {
  const isolated = ["setup","skill"].includes(argv[0]) ? { home: sandbox,cwd: sandbox,env: {} } : {};
  try { await execute(argv,{ ...offline,...isolated }); return ""; } catch (error) { return String(error?.message ?? error); }
}

test("every documented option exists in the schema", () => {
  for (const command of COMMANDS) {
    for (const name of command.options) assert.ok(OPTIONS[name],`${command.name} --${name} is undocumented`);
  }
});

test("each command accepts exactly the options its schema lists", async () => {
  for (const command of COMMANDS.filter((entry) => !["help","schema","auth login"].includes(entry.name))) {
    const base = [...command.name.split(" "),...(positionals[command.name] ?? [])];
    for (const name of allOptions) {
      const message = await rejection([...base,...argument(name)]);
      const refused = /not valid for this command/.test(message);
      assert.equal(refused,!command.options.includes(name),
        `${command.name} --${name}: ${refused ? "refused but documented" : "accepted but undocumented"} (${message})`);
    }
  }
});

test("relo schema returns the agent reference as one JSON object", async () => {
  const lines = [];
  assert.equal(await run(["schema"],{ stdout: (line) => lines.push(line),stderr: () => {} }),EXIT.OK);
  const { ok,data } = JSON.parse(lines[0]);
  assert.equal(ok,true);
  assert.deepEqual(data.identity.required,["source","project","topic"]);
  assert.equal(data.exitCodes[5],"denied or no");
  assert.ok(data.environment.RELO_TOKEN);
  const start = data.commands.find((command) => command.name === "activity start");
  assert.deepEqual(start.options.privacy.values,["standard","private"]);
});
