// relo setup's depths (plan 12 §4.7): notify | track | guide | optimize, what each installs, that the depth is what is
// installed (no --level keeps it), the one question for a person, --show, and the way back down.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { DEPTHS, blockModules, renderBlock, renderBlockText } from "../src/install/block.mjs";
import { EXIT } from "../src/shared/errors.mjs";
import { cardDependencies, fakeHome } from "./fake-cards.mjs";

async function cli(argv, dependencies, io = {}) {
  const stdout = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false, ...io }, dependencies);
  const json = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
  return { exitCode, stdout, line: stdout[0] ? json(stdout[0]) : undefined };
}

async function sandbox({ home: given, ...extra } = {}) {
  const home = given ?? await fakeHome();
  const cwd = await mkdtemp(join(tmpdir(), "relo-depth-cwd-"));
  await mkdir(join(cwd, ".git"));
  // Its own state folder: optimize records what it changed there, and sandboxes must not share it.
  const deps = { ...cardDependencies({}), home, cwd, env: {}, hookStateDirectory: join(home, ".relo-state", "hooks"), ...extra };
  return { home, cwd, deps, run: (argv, more = {}, io = {}) => cli(argv, { ...deps, ...more }, io),
    claude: join(home, ".claude", "CLAUDE.md"), codex: join(home, ".codex", "AGENTS.md"), settings: join(home, ".claude", "settings.json"),
    skill: join(home, ".claude", "skills", "relo-notifications", "SKILL.md") };
}

const modulesOf = (path) => blockModules(readFileSync(path, "utf8"));
const hookSet = (line) => line.depth.hooks;
/** Every file under a folder with its text, to prove a command wrote nothing. */
const snapshot = async (folder) => Object.fromEntries(await Promise.all((await readdir(folder, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile()).map(async (entry) => [join(entry.parentPath, entry.name), await readFile(join(entry.parentPath, entry.name), "utf8")])));

test("each depth installs its modules, the skill (not at notify) and the hook set (guide and up, where a harness has hooks)", async () => {
  for (const [level, skill, hooks] of [["notify", false, "off"], ["track", true, "off"], ["guide", true, "presence"], ["optimize", true, "presence"]]) {
    const box = await sandbox();
    const out = await box.run(["setup", "--level", level]);
    assert.equal(out.exitCode, EXIT.OK, level);
    assert.deepEqual(modulesOf(box.claude), DEPTHS[level], level);
    assert.deepEqual(modulesOf(box.codex), DEPTHS[level], level);
    assert.equal(await readFile(box.claude, "utf8"), `${renderBlock(DEPTHS[level]).join("\n")}\n`);
    assert.equal(existsSync(box.skill), skill, `${level}: skill`);
    assert.equal(existsSync(box.settings), hooks !== "off", `${level}: hooks`);
    assert.equal(hookSet(out.line), hooks);
    const skipped = (out.line.skipped ?? []).filter((row) => row.kind === "hooks");
    assert.deepEqual(skipped.map((row) => [row.harness, row.reason]), hooks === "off" ? [] : [["codex", "no hooks for this harness"]], level);
  }
});

test("the result leads with the depth and one line per harness; optimize names its extras", async () => {
  const box = await sandbox();
  const out = await box.run(["setup", "--level", "optimize", "--approvals", "on"], {}, { stdoutIsTTY: true });
  const text = out.stdout.join("\n");
  assert.equal(text.split("\n")[0], "Set up: optimize (approvals on)");
  assert.match(text, /Claude Code +instructions: reporting planning continuity efficiency · skill · hooks: approvals/u);
  assert.match(text, /Codex +instructions: reporting planning continuity efficiency · skill · no hooks for this harness/u);
  assert.doesNotMatch(text, /later release/u);
  assert.match(text, /Claude Code .*hooks: approvals \+ subagent nudge · status line · agents: relo-explore, relo-worker/u);
  assert.match(text, /^Changed$/mu);
  const guide = await (await sandbox()).run(["setup", "--level", "guide", "--dry-run"], {}, { stdoutIsTTY: true });
  assert.equal(guide.stdout.join("\n").split("\n")[0], "Set up: guide (approvals off)");
  assert.match(guide.stdout.join("\n"), /^Would change$/mu);
  assert.doesNotMatch(guide.stdout.join("\n"), /status line|agents:/u);
});

test("approvals ride on guide or optimize: the approvals hook set, and a usage error elsewhere", async () => {
  const box = await sandbox();
  assert.equal((await box.run(["setup", "--level", "track", "--approvals", "on"])).exitCode, EXIT.USAGE);
  assert.equal((await box.run(["setup", "--level", "notify", "--approvals", "on"])).exitCode, EXIT.USAGE);
  assert.equal(existsSync(box.claude), false, "a refused plan writes nothing");
  const out = await box.run(["setup", "--level", "guide", "--approvals", "on"]);
  assert.equal(hookSet(out.line), "approvals");
  assert.ok(JSON.parse(await readFile(box.settings, "utf8")).hooks.PermissionRequest);
});

test("without --level setup keeps what is installed, so running it again never downgrades", async () => {
  const box = await sandbox();
  const first = await box.run(["setup"]);
  assert.equal(first.line.depth.level, "track", "first install: track, approvals off");
  await box.run(["setup", "--level", "optimize", "--approvals", "on"]);
  const again = await box.run(["setup"]);
  assert.equal(again.line.depth.level, "optimize");
  assert.equal(again.line.depth.approvals, true);
  assert.deepEqual(again.line.changed, []);
  assert.deepEqual(modulesOf(box.claude), DEPTHS.optimize);
  assert.ok(JSON.parse(await readFile(box.settings, "utf8")).hooks.PermissionRequest, "approvals kept");
  await box.run(["setup", "--level", "guide"]);
  assert.ok(JSON.parse(await readFile(box.settings, "utf8")).hooks.PermissionRequest, "a named level without --approvals keeps the installed approvals");
  await box.run(["setup", "--level", "guide", "--approvals", "off"]);
  assert.ok(!JSON.parse(await readFile(box.settings, "utf8")).hooks.PermissionRequest);
});

test("hooks installed by an older relo count as guide: a bare setup keeps them", async () => {
  const box = await sandbox();
  await box.run(["setup", "--level", "guide"]);
  await writeFile(box.claude, "<!-- relo:start -->\nold\n<!-- relo:end -->\n");
  const again = await box.run(["setup"]);
  assert.equal(again.line.depth.hooks, "presence");
  assert.ok(existsSync(box.settings));
  assert.deepEqual(modulesOf(box.claude), ["reporting", "planning"], "an existing block keeps its own modules until a level is named");
});

test("going down to track removes the hooks, revokes the harness credential and drops queued snapshots", async () => {
  const box = await sandbox();
  const credentialPath = join(box.home, "harness-credential");
  const calls = [];
  const client = { createHarnessCredential: async () => { calls.push("mint"); return { id: "hcr_1", token: "h".repeat(44) }; },
    revokeHarnessCredential: async (id) => { calls.push(`revoke ${id}`); return {}; } };
  const extra = { env: { RELO_HARNESS_CREDENTIAL_PATH: credentialPath }, clientFactory: () => client };
  await box.run(["setup", "--level", "guide"], extra);
  assert.equal(existsSync(box.settings), true);
  assert.deepEqual(calls, ["mint"]);
  const down = await box.run(["setup", "--level", "track"], extra);
  assert.equal(down.line.harnessCredential, "revoked");
  assert.deepEqual(calls, ["mint", "revoke hcr_1"]);
  assert.equal(existsSync(box.settings), false);
  assert.deepEqual(modulesOf(box.claude), DEPTHS.track, "the block follows the named depth");
});

test("a person at a terminal is asked once, with the installed depth as the default; nobody else is asked", async () => {
  const asked = [];
  const answers = ["3", "y"];
  const home = await fakeHome();
  const box = await sandbox({ home, ask: async (question, fallback) => {
    if (!/^(How deep|Answer permission)/u.test(question)) return fallback; // the computer's name and icon: not this test
    asked.push([question, fallback]);
    return answers.shift() ?? fallback;
  },
  clientFactory: () => ({ putComputerSelf: async () => {} }), env: { RELO_STATE_DIR: join(home, "state") }, configPath: () => join(home, "config.json"),
  loadStoredConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44), revision: "r1" }), writeConfig: async () => {}, computerName: () => "studio-mac" });
  const terminal = { stdinIsTTY: true, stdoutIsTTY: true };
  const out = await box.run(["setup"], terminal);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out.stdout));
  assert.equal(asked[0][0], `How deep should Relo plug into your agents?
  1  notify     Questions and notifications only. No cards.
  2  track      Live cards with plans on your phone.
  3  guide      Track, plus continuity across requests, compaction and /clear,
                and which sessions are working (hooks).
  4  optimize   Guide, plus lean context and right-sized subagents.
Choose 1-4 [2]: `);
  assert.equal(asked[0][1], "2");
  assert.equal(asked[1][0], "Answer permission prompts from your phone too? [y/N] ");
  assert.equal(out.line.depth.level, "guide");
  assert.equal(out.line.depth.approvals, true);
  // Again: the installed depth is the default and marked, approvals default yes.
  asked.length = 0;
  await box.run(["setup"], terminal);
  assert.match(asked[0][0], /  3  guide      Track, plus continuity across requests, compaction and \/clear, \(current\)\n/u);
  assert.equal(asked[0][1], "3");
  assert.equal(asked[1][0], "Answer permission prompts from your phone too? [Y/n] ");
  // Track and notify ask no approvals question; an empty answer is the default.
  asked.length = 0;
  answers.push("1");
  assert.equal((await box.run(["setup"], terminal)).line.depth.level, "notify");
  assert.equal(asked.length, 1);
  asked.length = 0;
  for (const [argv, extra] of [[["setup", "--json"], terminal], [["setup", "--dry-run"], terminal], [["setup", "--show"], terminal], [["setup", "--level", "guide"], terminal],
    [["setup"], { stdinIsTTY: true, stdoutIsTTY: false }], [["setup"], { ...terminal, caller: { type: "agent_session", harness: "claude-code", sessionId: "s", sessionKey: "k" } }]]) {
    await box.run(argv, extra);
  }
  assert.deepEqual(asked, []);
});

test("--show writes nothing: the installed depth per harness, then the block", async () => {
  const box = await sandbox();
  await box.run(["setup", "--level", "guide", "--approvals", "on"]);
  const before = await snapshot(box.home);
  const out = await box.run(["setup", "--show"]);
  assert.equal(out.exitCode, EXIT.OK);
  const claude = out.line.harnesses.find((row) => row.harness === "claude-code");
  assert.deepEqual([claude.level, claude.modules, claude.hooks, claude.approvals, claude.skill], ["guide", DEPTHS.guide, "approvals", true, "current"]);
  const codex = out.line.harnesses.find((row) => row.harness === "codex");
  assert.deepEqual([codex.level, codex.hooks, codex.hooksAvailable], ["guide", "off", false]);
  assert.equal(out.line.block, renderBlockText(DEPTHS.guide));
  assert.equal(out.line.would, undefined);
  const human = await box.run(["setup", "--show"], {}, { stdoutIsTTY: true });
  assert.match(human.stdout.join("\n"), /Claude Code +guide \[reporting planning continuity\] · skill current · hooks: approvals/u);
  assert.match(human.stdout.join("\n"), /Codex +guide .* · no hooks for this harness/u);
  // With --level: what that depth would install, and its block.
  const would = await box.run(["setup", "--show", "--level", "optimize"]);
  assert.deepEqual(would.line.would, { level: "optimize", modules: DEPTHS.optimize, skill: true, hooks: "approvals", approvals: true,
    extras: { statusline: true, agents: true } }); // installed approvals are kept
  assert.equal(would.line.block, renderBlockText(DEPTHS.optimize));
  const notify = await box.run(["setup", "--show", "--level", "notify"]);
  assert.deepEqual([notify.line.would.skill, notify.line.would.hooks], [false, "off"]);
  assert.deepEqual(await snapshot(box.home), before, "nothing was written");
  const bare = await sandbox();
  const empty = await snapshot(bare.home);
  await bare.run(["setup", "--show", "--level", "guide"]);
  assert.deepEqual(await snapshot(bare.home), empty);
});

test("--modules overrides the block's modules while hooks and the skill follow --level; bad modules are refused", async () => {
  const box = await sandbox();
  const out = await box.run(["setup", "--level", "guide", "--modules", "reporting,efficiency"]);
  assert.equal(out.exitCode, EXIT.OK);
  assert.deepEqual(modulesOf(box.claude), ["reporting", "efficiency"]);
  assert.equal(existsSync(box.settings), true, "hooks follow --level");
  assert.equal(blockModules(box.claude).length, 2);
  assert.equal((await box.run(["setup", "--modules", "notify,reporting"])).exitCode, EXIT.USAGE);
  assert.equal((await box.run(["setup", "--modules", "bogus"])).exitCode, EXIT.USAGE);
  const refreshed = await box.run(["setup", "--refresh"]);
  assert.deepEqual(modulesOf(box.claude), ["reporting", "efficiency"], "refresh keeps the block's own modules");
  assert.equal(refreshed.exitCode, EXIT.OK);
});

test("--hooks and relo hooks are gone; --refresh takes no depth flags", async () => {
  const box = await sandbox();
  assert.equal((await box.run(["setup", "--hooks", "presence"])).exitCode, EXIT.USAGE);
  assert.equal((await box.run(["setup", "--refresh", "--level", "guide"])).exitCode, EXIT.USAGE);
  assert.equal((await box.run(["setup", "--refresh", "--show"])).exitCode, EXIT.USAGE);
  assert.equal((await box.run(["setup", "guide"])).exitCode, EXIT.USAGE, "the level is a flag, not a word");
});

test("refresh re-renders each block at the modules its own marker names, and a bare marker as track", async () => {
  const box = await sandbox();
  await box.run(["setup", "--level", "optimize"]);
  await writeFile(box.claude, `${renderBlock(DEPTHS.optimize)[0]}\nstale\n<!-- relo:end -->\n`);
  await writeFile(box.codex, "<!-- relo:start -->\nold\n<!-- relo:end -->\n");
  await box.run(["setup", "--refresh"]);
  assert.equal(await readFile(box.claude, "utf8"), `${renderBlock(DEPTHS.optimize).join("\n")}\n`);
  assert.equal(await readFile(box.codex, "utf8"), `${renderBlock(DEPTHS.track).join("\n")}\n`);
});

test("uninstall removes everything a deep install wrote: blocks, skill, hooks", async () => {
  const box = await sandbox();
  await box.run(["setup", "--level", "optimize", "--approvals", "on"]);
  assert.equal(existsSync(box.settings), true);
  const out = await box.run(["uninstall", "--apply"]);
  assert.equal(out.exitCode, EXIT.OK);
  for (const path of [box.claude, box.codex, box.settings, box.skill]) assert.equal(existsSync(path), false, path);
});

test("--project writes no repository block or hooks while user-level ones already load in every project", async () => {
  const box = await sandbox();
  assert.equal((await box.run(["setup", "--level", "guide", "--agent", "claude-code"])).exitCode, EXIT.OK);
  const out = await box.run(["setup", "--project", "--level", "guide", "--agent", "claude-code"]);
  assert.equal(out.exitCode, EXIT.OK);
  assert.equal(existsSync(join(box.cwd, "AGENTS.md")), false, "the instructions would load twice");
  assert.equal(existsSync(join(box.cwd, ".claude", "settings.local.json")), false);
  const reasons = (kind) => (out.line.skipped ?? []).filter((row) => row.kind === kind).map((row) => row.reason);
  assert.deepEqual(reasons("hooks"), ["user-level hooks already run in every project"]);
  assert.deepEqual(reasons("block"), ["a user-level Relo block already loads in every project: a project copy would load twice"]);
});

test("--project still writes the repository block for an agent that has no user-level one", async () => {
  const box = await sandbox();
  assert.equal((await box.run(["setup", "--level", "guide", "--agent", "claude-code"])).exitCode, EXIT.OK);
  const out = await box.run(["setup", "--project", "--level", "guide", "--agent", "codex"]);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out.line));
  assert.deepEqual(modulesOf(join(box.cwd, "AGENTS.md")), DEPTHS.guide);
});

test("a person at a terminal picks which of the agents found here to set up; Enter keeps them all", async () => {
  const home = await fakeHome({ agents: [".claude", ".codex", ".config/opencode"] });
  const cwd = await mkdtemp(join(tmpdir(), "relo-pick-"));
  const questions = [];
  const answers = { agents: "1,3", depth: "2" };
  const deps = { ...cardDependencies({}), home, cwd, env: {}, stdinIsTTY: true, stdoutIsTTY: true, computerName: () => "box",
    clientFactory: () => ({ putComputerSelf: async () => ({}) }),
    ask: async (question, fallback) => {
      questions.push(question.split("\n")[0]);
      if (question.startsWith("Relo found these agents")) return answers.agents;
      if (question.startsWith("How deep")) return answers.depth;
      return fallback;
    } };
  const out = await cli(["setup"], deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out));
  assert.equal(questions[0], "Relo found these agents on this computer:");
  const set = [...new Set(out.line.changed.filter((row) => row.harness && row.kind === "block").map((row) => row.harness))];
  assert.equal(set.length, 2);
  assert.ok(!set.includes("codex"), `picked 1 and 3, not Codex: ${set.join(", ")}`);
});


test("doctor does not ask for the skill at notify, which leaves it out by design; above notify a missing skill is flagged", async () => {
  const { setupWarnings } = await import("../src/owner/doctor.mjs");
  const notify = await sandbox();
  assert.equal((await notify.run(["setup", "--level", "notify"])).exitCode, EXIT.OK);
  const quiet = (await setupWarnings({ ...notify.deps, version: "0.0.0-test" })).skill;
  assert.deepEqual([quiet.ok, quiet.state, quiet.hint], [true, "not_needed", undefined]);
  const track = await sandbox();
  assert.equal((await track.run(["setup", "--level", "track"])).exitCode, EXIT.OK);
  await (await import("node:fs/promises")).rm(join(track.home, ".claude", "skills"), { recursive: true, force: true });
  await (await import("node:fs/promises")).rm(join(track.home, ".agents"), { recursive: true, force: true });
  const flagged = (await setupWarnings({ ...track.deps, version: "0.0.0-test" })).skill;
  assert.deepEqual([flagged.ok, flagged.state], [false, "missing"]);
});
