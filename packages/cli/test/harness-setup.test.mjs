import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT, run } from "../src/cli.mjs";
import { cardDependencies, fakeHome } from "./fake-cards.mjs";

async function box() {
  const home = await fakeHome({ agents: [] });
  const cwd = await mkdtemp(join(tmpdir(), "relo-harness-cwd-"));
  await mkdir(join(cwd, ".git"));
  const deps = { ...cardDependencies({}), home, cwd, env: {} };
  const cli = async (argv) => {
    const stdout = [];
    const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, deps);
    return { exitCode, line: stdout.length ? JSON.parse(stdout.at(-1)) : undefined };
  };
  return { cli, project: join(cwd, ".claude", "settings.json") };
}

test("bare --hooks and unknown levels are refused and write nothing", async () => {
  const b = await box();
  for (const argv of [["setup", "--project", "--hooks"], ["setup", "--project", "--hooks", "loud"], ["setup", "--project", "--hooks", "--remove"]]) {
    const out = await b.cli(argv);
    assert.equal(out.exitCode, EXIT.USAGE, argv.join(" "));
    await assert.rejects(readFile(b.project, "utf8"));
  }
});

test("setup --hooks reminders, then hooks status, then hooks off leaves others' hooks alone", async () => {
  const b = await box();
  await mkdir(join(b.project, ".."), { recursive: true });
  const original = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } }, null, 2)}\n`;
  await writeFile(b.project, original);
  const set = await b.cli(["setup", "--project", "--hooks", "reminders"]);
  assert.equal(set.exitCode, EXIT.OK);
  assert.equal(set.line.action, "updated");
  const status = await b.cli(["hooks", "status", "--json"]);
  assert.equal(status.line.data?.level ?? status.line.level, "reminders");
  const presence = await b.cli(["setup", "--project", "--hooks", "presence"]);
  assert.equal(presence.exitCode, EXIT.OK);
  const status2 = await b.cli(["hooks", "status"]);
  assert.equal(status2.line.data?.level ?? status2.line.level, "presence");
  const off = await b.cli(["hooks", "off"]);
  assert.equal(off.exitCode, EXIT.OK);
  assert.equal(await readFile(b.project, "utf8"), original);
  const after = await b.cli(["hooks", "status"]);
  assert.equal(after.line.data?.level ?? after.line.level, "off");
});

test("Gemini offers presence and off only", async () => {
  const b = await box();
  const out = await b.cli(["setup", "--global", "--agent", "gemini", "--hooks", "reminders"]);
  assert.equal(out.exitCode, EXIT.USAGE);
});
