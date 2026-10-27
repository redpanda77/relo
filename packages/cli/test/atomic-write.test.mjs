import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renameWithRetry, writeFileAtomic } from "../src/shared/atomic-write.mjs";
import { dataRoot, stateRoot } from "../src/work/state-file.mjs";

const fail = (code) => Object.assign(new Error(code), { code });
const flaky = (codes) => { const calls = []; const rename = async (...args) => { calls.push(args); if (codes.length) throw fail(codes.shift()); }; return { rename, calls }; };
const noSleep = (delays = []) => async (ms) => { delays.push(ms); };

test("renameWithRetry retries EPERM, EBUSY and EACCES on win32 with a growing backoff, then succeeds", async () => {
  const { rename, calls } = flaky(["EPERM", "EBUSY", "EACCES"]);
  const delays = [];
  await renameWithRetry("a", "b", { platform: "win32", rename, sleep: noSleep(delays) });
  assert.equal(calls.length, 4);
  assert.deepEqual(delays, [10, 20, 40]);
});

test("renameWithRetry gives up after eight tries and throws the last error", async () => {
  const { rename, calls } = flaky(Array(10).fill("EBUSY"));
  const delays = [];
  await assert.rejects(renameWithRetry("a", "b", { platform: "win32", rename, sleep: noSleep(delays) }), { code: "EBUSY" });
  assert.equal(calls.length, 8);
  assert.ok(delays.every((ms) => ms >= 10 && ms <= 80));
});

test("renameWithRetry never retries other errors, nor anything off win32", async () => {
  for (const [platform, code] of [["win32", "ENOENT"], ["win32", "EXDEV"], ["linux", "EPERM"], ["darwin", "EBUSY"]]) {
    const { rename, calls } = flaky([code]);
    await assert.rejects(renameWithRetry("a", "b", { platform, rename, sleep: noSleep() }), { code });
    assert.equal(calls.length, 1, `${platform} ${code}`);
  }
});

test("writeFileAtomic writes the file, leaves no temp file, and keeps the mode option", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relo-atomic-"));
  const path = join(dir, "x.json");
  await writeFileAtomic(path, '{"a":1}', { sync: true });
  await writeFileAtomic(path, '{"a":2}');
  assert.equal(readFileSync(path, "utf8"), '{"a":2}');
  assert.deepEqual(readdirSync(dir), ["x.json"]);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("writeFileAtomic retries a busy rename and cleans up the temp file when it finally fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relo-atomic-"));
  const path = join(dir, "x.json");
  const ok = flaky(["EPERM", "EPERM"]);
  await writeFileAtomic(path, "one", { platform: "win32", sleep: noSleep(), rename: async (from, to) => { await ok.rename(from, to); return (await import("node:fs/promises")).rename(from, to); } });
  assert.equal(readFileSync(path, "utf8"), "one");
  assert.equal(ok.calls.length, 3);
  const bad = flaky(Array(10).fill("EBUSY"));
  await assert.rejects(writeFileAtomic(path, "two", { platform: "win32", sleep: noSleep(), rename: bad.rename }), { code: "EBUSY" });
  assert.equal(readFileSync(path, "utf8"), "one");
  assert.deepEqual(readdirSync(dir), ["x.json"]);
});

test("stress: 20 concurrent writers in one process leave one complete valid write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relo-atomic-"));
  const path = join(dir, "shared.json");
  const payloads = Array.from({ length: 20 }, (_, id) => JSON.stringify({ id, pad: String(id).repeat(20_000) }));
  await Promise.all(payloads.flatMap((text) => [0, 1, 2].map(async () => writeFileAtomic(path, text))));
  assert.ok(payloads.includes(readFileSync(path, "utf8")));
  assert.deepEqual(readdirSync(dir), ["shared.json"]);
});

test("stress: 20 concurrent processes writing the same file never throw and leave one complete valid write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relo-atomic-"));
  const path = join(dir, "shared.json");
  writeFileSync(path, JSON.stringify({ id: -1, pad: "" }));
  const worker = join(dir, "worker.mjs");
  const module = new URL("../src/shared/atomic-write.mjs", import.meta.url).href;
  writeFileSync(worker, `import { writeFileAtomic } from ${JSON.stringify(module)};
const [path, id] = process.argv.slice(2);
for (let i = 0; i < 15; i += 1) await writeFileAtomic(path, JSON.stringify({ id: Number(id), i, pad: id.repeat(20000) }));
`);
  const runs = Array.from({ length: 20 }, (_, id) => new Promise((resolve) => {
    const child = spawn(process.execPath, [worker, path, String(id)], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ id, code, stderr }));
  }));
  const results = await Promise.all(runs);
  for (const result of results) assert.equal(result.code, 0, `writer ${result.id}: ${result.stderr.slice(0, 400)}`);
  const final = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(final.pad, String(final.id).repeat(20000));
  assert.equal(final.i, 14, "the last write of some writer won, whole");
  assert.deepEqual(readdirSync(dir).sort(), ["shared.json", "worker.mjs"]);
});

test("data and state roots: %LOCALAPPDATA%\\Relo on win32 (home fallback), POSIX unchanged, overrides still win", () => {
  const home = "C:\\Users\\me";
  const local = "D:\\Local";
  assert.equal(dataRoot(home, { LOCALAPPDATA: local }, "win32"), join(local, "Relo", "data"));
  assert.equal(dataRoot(home, {}, "win32"), join(home, "AppData", "Local", "Relo", "data"));
  assert.equal(dataRoot(home, { LOCALAPPDATA: "  " }, "win32"), join(home, "AppData", "Local", "Relo", "data"));
  assert.equal(stateRoot({ LOCALAPPDATA: local, RELO_STATE_DIR: "S" }, home, "win32"), "S");
  assert.equal(stateRoot({ LOCALAPPDATA: local, XDG_STATE_HOME: "X" }, home, "win32"), join("X", "relo"));
  assert.equal(dataRoot("/h", {}, "linux"), join("/h", ".local", "share", "relo"));
  assert.equal(dataRoot("/h", { LOCALAPPDATA: local }, "darwin"), join("/h", ".local", "share", "relo"));
});

test("stateRoot on win32 without any override uses LOCALAPPDATA, else <home>\\AppData\\Local", () => {
  const saved = process.env.RELO_STATE_DIR;
  delete process.env.RELO_STATE_DIR;
  try {
    assert.equal(stateRoot({ LOCALAPPDATA: "D:\\Local" }, "C:\\Users\\me", "win32"), join("D:\\Local", "Relo", "state"));
    assert.equal(stateRoot({}, "C:\\Users\\me", "win32"), join("C:\\Users\\me", "AppData", "Local", "Relo", "state"));
    assert.equal(stateRoot({}, "/h", "linux"), join("/h", ".local", "state", "relo"));
  } finally {
    if (saved !== undefined) process.env.RELO_STATE_DIR = saved;
  }
});
