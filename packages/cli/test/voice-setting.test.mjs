// ADR 0015 revision 1: how much Relo for Mac may say of work started on this computer. RELO_VOICE, then the nearest
// folder set with `relo voice LEVEL --here`, then `relo voice LEVEL` (the default), then verbose.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { EXIT } from "../src/shared/errors.mjs";
import { voiceNote, voiceSetting } from "../src/work/spoken.mjs";

const REPO = resolve("/home/sam/code/acme-app");

async function cli(argv, dependencies) {
  const stdout = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, dependencies);
  const parsed = stdout[0] ? JSON.parse(stdout[0]) : undefined;
  // The note is the same words for people: "Voice here: verbose, from Relo's default. …".
  if (parsed?.note) assert.match(parsed.note, /^Voice here: \w+, from /u);
  const { note, ...line } = parsed ?? {};
  return { exitCode, line: parsed ? line : undefined };
}

test("the level comes from RELO_VOICE, then this place, then the default, then verbose", () => {
  const voices = { "*": "full", [REPO]: "off" };
  assert.deepEqual(voiceSetting({ env: {}, cwd: "/tmp/elsewhere", loadVoices: () => ({}) }), { level: "verbose", via: "default" });
  assert.equal(voiceSetting({ env: {}, cwd: "/tmp/elsewhere", loadVoices: () => voices }).level, "full");
  assert.equal(voiceSetting({ env: {}, cwd: resolve(REPO, "src"), loadVoices: () => voices }).level, "off");
  assert.deepEqual(voiceSetting({ env: { RELO_VOICE: "Brief" }, cwd: resolve(REPO, "src"), loadVoices: () => voices }), { level: "brief", via: "env" });
  assert.equal(voiceSetting({ env: { RELO_VOICE: "loud" }, cwd: "/tmp", loadVoices: () => ({}) }).level, "verbose", "an unknown level is ignored");
});

test("the start echo tells the agent what to write for each level", () => {
  assert.match(voiceNote({ level: "verbose", via: "default" }), /each finished step.*--say/u);
  assert.match(voiceNote({ level: "brief", via: "config" }), /only "<Kind>: <name>\."/u);
  assert.match(voiceNote({ level: "off", via: "project" }), /says nothing of this work; write no --say/u);
});

test("relo voice shows, saves the default, saves one place with --here, and clears", async () => {
  const state = { config: { apiUrl: "https://relo.example", token: "x".repeat(44) } };
  const deps = (cwd, env = {}) => ({
    env, cwd, home: "/home/sam",
    configPath: () => "/cfg/c.json",
    loadStoredConfig: async () => state.config,
    loadVoices: () => state.config.voices ?? {},
    writeConfig: async (_path, config) => { state.config = { ...state.config, ...config }; },
  });
  assert.deepEqual((await cli(["voice"], deps(REPO))).line, { ok: true, voice: "verbose", via: "default" });
  assert.deepEqual((await cli(["voice", "full"], deps(REPO))).line, { ok: true, voice: "full", via: "config", saved: true });
  assert.deepEqual(state.config.voices, { "*": "full" });
  const here = await cli(["voice", "off", "--here"], deps(REPO));
  assert.equal(here.line.voice, "off");
  assert.equal(here.line.via, "project");
  assert.deepEqual(state.config.voices, { "*": "full", [REPO]: "off" });
  assert.equal((await cli(["voice"], deps(REPO, { RELO_VOICE: "brief" }))).line.voice, "brief");
  await cli(["voice", "--clear", "--here"], deps(REPO));
  assert.deepEqual(state.config.voices, { "*": "full" });
  assert.equal((await cli(["voice", "loud"], deps(REPO))).exitCode, EXIT.USAGE);
});
