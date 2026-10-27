// The Windows launcher and user Path (plan: Windows M1 I1-I3). Platform and registry are injected: nothing here
// touches the real registry or %LOCALAPPDATA%.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { putOnPath, takeOffPath } from "../src/owner/setup-path.mjs";
import { cmdLauncherText, parseCmdLauncher, windowsPaths, writeWindowsLauncher } from "../src/owner/windows-launcher.mjs";

/** A fake `reg`/`powershell` runner over one in-memory user Path value. */
function fakeRegistry(initial) {
  const state = { value: initial, type: "REG_EXPAND_SZ", calls: [], broadcasts: 0 };
  state.run = async (file, args) => {
    state.calls.push([file, ...args]);
    if (file === "reg" && args[0] === "query") {
      return state.value === undefined ? { code: 1, stdout: "" } : { code: 0, stdout: `\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    ${state.type}    ${state.value}\r\n\r\n` };
    }
    if (file === "reg" && args[0] === "add") { state.value = args[args.indexOf("/d") + 1]; state.type = args[args.indexOf("/t") + 1]; return { code: 0, stdout: "" }; }
    if (file === "powershell.exe") { state.broadcasts += 1; return { code: 0, stdout: "" }; }
    return { code: 1, stdout: "" };
  };
  return state;
}

const env = { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" };
const home = "C:\\Users\\a";
const BIN = "C:\\Users\\a\\AppData\\Local\\Relo\\bin";

test("the launcher folder joins the user Path once, keeping every other entry and its %VAR%", async () => {
  const registry = fakeRegistry("%USERPROFILE%\\bin;C:\\Tools");
  const first = await putOnPath({ home, env, platform: "win32", run: registry.run });
  assert.deepEqual(first, { bin: BIN, changed: ["user Path"], unchanged: [] });
  assert.equal(registry.value, `%USERPROFILE%\\bin;C:\\Tools;${BIN}`);
  assert.equal(registry.type, "REG_EXPAND_SZ");
  assert.equal(registry.broadcasts, 1);
  const again = await putOnPath({ home, env, platform: "win32", run: registry.run });
  assert.deepEqual(again.changed, []);
  assert.equal(registry.broadcasts, 1, "nothing changed, nothing broadcast");
});

test("an entry spelled with %LOCALAPPDATA% or a trailing slash counts as already there; a missing Path is created", async () => {
  const there = fakeRegistry("%LOCALAPPDATA%\\Relo\\bin\\");
  assert.deepEqual((await putOnPath({ home, env, platform: "win32", run: there.run })).changed, []);
  const none = fakeRegistry(undefined);
  await putOnPath({ home, env, platform: "win32", run: none.run });
  assert.equal(none.value, BIN);
});

test("--dry-run writes nothing; uninstall removes only Relo's entry; the machine Path is never named", async () => {
  const registry = fakeRegistry(`C:\\a;${BIN};%SystemRoot%\\x`);
  const dry = await putOnPath({ home, env, platform: "win32", dryRun: true, run: fakeRegistry("C:\\a").run });
  assert.deepEqual(dry.changed, ["user Path"]);
  assert.deepEqual(await takeOffPath({ home, env, run: registry.run }), { changed: true });
  assert.equal(registry.value, "C:\\a;%SystemRoot%\\x");
  assert.deepEqual(await takeOffPath({ home, env, run: registry.run }), { changed: false });
  assert.ok(registry.calls.every((call) => !call.join(" ").includes("HKLM")));
});

test("relo.cmd is written beside a Git Bash sibling, recognised again, and a Windows-app launcher is left alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "relo-win-"));
  try {
    const where = { home: root, env: { LOCALAPPDATA: join(root, "Local") } };
    const paths = windowsPaths(where);
    const entry = join(paths.cli, "1.2.3", "bin", "relo.mjs");
    const node = "C:\\Program Files\\nodejs\\node.exe";
    const written = await writeWindowsLauncher({ ...where, node, entry });
    assert.equal(written.written, true);
    const text = await readFile(paths.cmd, "utf8");
    assert.equal(text, cmdLauncherText(node, entry));
    assert.match(text, /^@echo off\r\nrem relo launcher: /u);
    assert.deepEqual(parseCmdLauncher(text), { node, entry, managed: false });
    assert.match(await readFile(paths.sh, "utf8"), /^#!\/bin\/sh\n# relo launcher: .*\nexec "C:\/Program Files\/nodejs\/node.exe" /u);
    await writeFile(paths.cmd, "@echo off\r\nrem Written by Relo for Windows\r\n");
    assert.equal(parseCmdLauncher(await readFile(paths.cmd, "utf8")).managed, true);
    const left = await writeWindowsLauncher({ ...where, node, entry });
    assert.deepEqual([left.written, left.managed], [false, true]);
    assert.match(await readFile(paths.cmd, "utf8"), /Written by Relo for Windows/u);
    assert.equal(parseCmdLauncher("echo hi\r\n"), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the hermetic environment keeps tests off the real registry: the default runner refuses a Path write", async () => {
  const { defaultRun } = await import("../src/owner/windows-path.mjs");
  assert.equal(process.env.RELO_NO_REGISTRY_WRITES, "1");
  assert.deepEqual(await defaultRun("reg", ["add", "HKCU\Environment", "/v", "Path", "/d", "x", "/f"]), { code: 1, stdout: "" });
});
