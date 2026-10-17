import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execute, run } from "./cli-fixtures.mjs";
import { SETTINGS } from "../src/shared/settings.mjs";

const home = mkdtempSync(join(tmpdir(), "relo-config-"));
const repo = join(home, "studio-repo");
mkdirSync(join(repo, ".git"), { recursive: true });
test.after(() => rmSync(home, { recursive: true, force: true }));

const STORED = { apiUrl: "https://relo.example.test", activeProfile: "work", computerName: "Config Mac" };
function setup(overrides = {}) {
  return {
    env: {}, home, cwd: repo,
    configPath: () => join(home, "config.json"),
    loadStoredConfig: async () => STORED,
    computerName: () => "Detected Mac",
    loadAccounts: () => ({}),
    ...overrides,
  };
}
const rowOf = (data, key) => data.settings.find((row) => row.key === key);

test("relo config: environment wins over the config file, the config file over what the machine shows", async () => {
  const configured = (await execute(["config"], setup())).data;
  assert.deepEqual(rowOf(configured, "computer"), { key: "computer", value: "Config Mac", source: "config", env: "RELO_COMPUTER" });
  assert.deepEqual(rowOf(configured, "server"), { key: "server", value: "https://relo.example.test", source: "config", env: "RELO_API_URL" });
  assert.equal(rowOf(configured, "profile").value, "work");
  assert.deepEqual(rowOf(configured, "project"), { key: "project", value: "studio-repo", source: "detected", env: "RELO_PROJECT" });

  const bare = (await execute(["config"], setup({ loadStoredConfig: async () => ({}) }))).data;
  assert.equal(rowOf(bare, "computer").source, "detected");
  assert.equal(rowOf(bare, "computer").value, "Detected Mac");
  assert.deepEqual(rowOf(bare, "profile"), { key: "profile", value: "default", source: "default", env: "RELO_PROFILE" });

  const overridden = (await execute(["config"], setup({ env: { RELO_COMPUTER: "Env Mac", RELO_PROJECT: "env-project", RELO_NO_UPDATE_CHECK: "1" } }))).data;
  assert.deepEqual(rowOf(overridden, "computer"), { key: "computer", value: "Env Mac", source: "env", env: "RELO_COMPUTER" });
  assert.equal(rowOf(overridden, "project").value, "env-project");
  assert.deepEqual(rowOf(overridden, "updateCheck"), { key: "updateCheck", value: "off", source: "env", env: "RELO_NO_UPDATE_CHECK" });
});

test("relo config: a nickname is the config file's, a custom config folder's name is detected", async () => {
  const claude = { CLAUDECODE: "1", CLAUDE_CONFIG_DIR: join(home, ".claude-work") };
  const owner = { caller: { type: "script" } };
  const detected = (await execute(["config"], setup({ env: claude, ...owner }))).data;
  assert.deepEqual([rowOf(detected, "account").value, rowOf(detected, "account").source], ["work", "detected"]);
  const nicknamed = (await execute(["config"], setup({ env: claude, ...owner, loadAccounts: () => ({ [join(home, ".claude-work")]: "Personal" }) }))).data;
  assert.deepEqual([rowOf(nicknamed, "account").value, rowOf(nicknamed, "account").source], ["Personal", "config"]);
});

test("relo config: paths are shown in full locally, and unsigned machines still answer", async () => {
  const data = (await execute(["config"], setup({ env: { RELO_STATE_DIR: join(home, "state") }, loadStoredConfig: async () => { throw new Error("none"); } }))).data;
  assert.deepEqual(data.settings.map((row) => row.key), SETTINGS.map((setting) => setting.key));
  assert.equal(rowOf(data, "stateDir").value, join(home, "state"));
  assert.equal(rowOf(data, "configPath").value, join(home, "config.json"));
  assert.equal(rowOf(data, "server").value, undefined);
});

test("relo config at a terminal prints Setting, Value, From; --json prints the rows; extra words are refused", async () => {
  const outcome = await execute(["config"], setup());
  const lines = outcome.text.split("\n");
  assert.match(lines[0], /^Setting\s+Value\s+From$/u);
  assert.match(lines.find((line) => line.startsWith("computer")), /^computer\s+Config Mac\s+config file$/u);
  assert.match(lines.find((line) => line.startsWith("topic")), /^topic\s+-\s+default$/u);

  const printed = [];
  const code = await run(["config", "--json"], { stdout: (line) => printed.push(line), stderr: () => {}, stdoutIsTTY: true }, setup());
  assert.equal(code, 0);
  assert.equal(printed.length, 1);
  const json = JSON.parse(printed[0]);
  assert.equal(json.ok, true);
  assert.deepEqual(json.settings, outcome.data.settings.map(({ key, value, source }) => ({ key, ...(value === undefined ? {} : { value }), source })));

  await assert.rejects(execute(["config", "now"], setup()), /Usage: relo config/u);
});

test("relo config is the owner's: an agent inside a session is refused, with no admin detour", async () => {
  const agent = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "9f2c1c34-5c0e-4d63-8a3a-7f1d3bd2c001" };
  await assert.rejects(execute(["config"], setup({ env: agent, caller: undefined })), (error) =>
    error.code === "OWNER_ONLY" && /this computer's setup/u.test(error.what) && !/admin/u.test(error.next));
});
