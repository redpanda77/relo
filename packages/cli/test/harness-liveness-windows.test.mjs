import "./hermetic-env.mjs";
// The Windows liveness probe: one injected PowerShell query answers the whole ancestor walk, and the harness
// process patterns accept backslash paths and .exe names. No real process is spawned.
import assert from "node:assert/strict";
import test from "node:test";
import claudeCode from "../src/harness/adapters/claude-code/index.mjs";
import opencode from "../src/harness/adapters/opencode/index.mjs";
import { findHarnessProcess, processAlive } from "../src/harness/core/liveness-probe.mjs";

test("Windows: one injected query answers the whole ancestor walk", async () => {
  const lines = [
    "300|200|133000000000000300|\"C:\\Windows\\System32\\cmd.exe\" /d /s /c relo hook",
    "200|100|133000000000000200|C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code\\2.1.308\\abc\\claude.exe --output-format stream-json",
    "100|4|133000000000000100|\"C:\\Program Files\\WindowsApps\\Claude\\app\\Claude.exe\"",
  ];
  const spawns = [];
  const run = async (file, args, options) => { spawns.push({ file, args, options }); return `${lines.join("\r\n")}\r\n`; };
  assert.deepEqual(await findHarnessProcess({ match: claudeCode.harnessProcess, startPid: 300, platform: "win32", run }), { pid: 200, start: "133000000000000200" });
  assert.equal(spawns.length, 1, "a single PowerShell spawn");
  assert.equal(spawns[0].file, "powershell.exe");
  assert.equal(spawns[0].options.windowsHide, true);
  assert.ok(spawns[0].options.timeout <= 3000);
  assert.equal(await findHarnessProcess({ match: opencode.harnessProcess, startPid: 300, platform: "win32", run }), undefined);
  assert.equal(await findHarnessProcess({ match: () => true, startPid: "300; calc", platform: "win32", run }), undefined, "a non-numeric pid never reaches the shell");
  assert.equal(spawns.length, 2);
  assert.equal(await findHarnessProcess({ match: () => true, startPid: 300, platform: "win32", run: async () => "" }), undefined, "a failed query fails soft");
  assert.equal(await findHarnessProcess({ match: () => true, startPid: 300, platform: "win32", run: async () => { throw new Error("boom"); } }), undefined);
});

test("Windows: processAlive compares the creation time, and EPERM still means alive", async () => {
  const one = (start) => async () => `5|1|${start}|claude.exe`;
  assert.equal(await processAlive({ pid: 5, start: "7", platform: "win32", kill: () => {}, run: one("7") }), true);
  assert.equal(await processAlive({ pid: 5, start: "7", platform: "win32", kill: () => {}, run: one("8") }), false, "the pid was reused");
  assert.equal(await processAlive({ pid: 5, start: "7", platform: "win32", kill: () => { throw Object.assign(new Error("x"), { code: "EPERM" }); }, run: one("7") }), true);
  assert.equal(await processAlive({ pid: 5, start: "7", platform: "win32", kill: () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); }, run: one("7") }), false);
  assert.equal(await processAlive({ pid: 5, start: "7", platform: "win32", kill: () => {}, run: async () => "" }), true, "unknown start: not declared gone");
});

test("Windows: a parent pid reused by a younger process ends the chain", async () => {
  const run = async () => "300|200|500|child\r\n200|100|900|younger-than-child\r\n";
  assert.equal(await findHarnessProcess({ match: (command) => command.startsWith("younger"), startPid: 300, platform: "win32", run }), undefined);
});

test("harness process patterns accept POSIX and Windows paths and .exe names, not the desktop app", () => {
  for (const command of ["/usr/bin/claude --resume", "claude", "C:\\Users\\me\\.local\\bin\\claude.exe --x", "\"C:\\x\\claude.exe\" --y",
    "C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code\\2.1.308\\c17a\\claude.exe --output-format stream-json",
    "node.exe C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js", "node /u/lib/node_modules/@anthropic-ai/claude-code/cli.js"]) {
    assert.equal(claudeCode.harnessProcess(command), true, command);
  }
  for (const command of ["\"C:\\Program Files\\WindowsApps\\Claude\\app\\Claude.exe\"", "C:\\x\\claudette.exe", "codex.exe"]) assert.equal(claudeCode.harnessProcess(command), false, command);
  for (const command of ["/opt/opencode serve", "C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.exe", "\"C:\\x\\opencode.exe\" run"]) assert.equal(opencode.harnessProcess(command), true, command);
  assert.equal(opencode.harnessProcess("C:\\x\\opencoder.exe"), false);
});
