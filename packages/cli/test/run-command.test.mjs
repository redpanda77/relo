// relo run (plan 14, workstream 2b): a script's command as a work, finished from how the command ends.
// These run the real CLI in a child process against a small fake producer server, so the exit code, the
// pass-through of stdio and the signals are the ones an owner's shell sees.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classify, defaultGoal, formatDuration } from "../src/script/run.mjs";

const BIN = new URL("../bin/relo.mjs", import.meta.url).pathname;
const TOKEN = `klb_${"x".repeat(44)}`;

/** A producer server: start answers 201 with a work, finish is recorded. `drop` makes a route hang up. */
async function fakeServer({ dropFinish = false } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      const body = text ? JSON.parse(text) : undefined;
      requests.push({ method: request.method, url: request.url, body, key: request.headers["idempotency-key"] });
      if (dropFinish && request.url.endsWith("/finish")) { request.socket.destroy(); return; }
      const reply = (status, payload) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(payload)); };
      if (request.method === "POST" && request.url.endsWith("/works")) return reply(201, { work: { id: "wrk_1", lifecycle: "open", sealed: false, goal: body.goal.readable, plan: { steps: [] } }, disposition: "started" });
      if (request.method === "POST" && request.url.endsWith("/finish")) return reply(200, { work: { id: "wrk_1", lifecycle: "finished" }, disposition: "finished" });
      if (request.method === "GET" && request.url.includes("/works")) return reply(200, { works: [{ id: "wrk_1", lifecycle: "open", sealed: false, goal: "x", plan: { steps: [] } }] });
      return reply(200, { devices: [] });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections?.(); server.close(); } };
}

/** An address nothing listens on. */
async function closedUrl() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  return url;
}

function launch(args, { url, env = {}, input } = {}) {
  const state = mkdtempSync(join(tmpdir(), "relo-run-"));
  const child = spawn(process.execPath, [BIN, "run", ...args], {
    env: { ...process.env, RELO_STATE_DIR: state, RELO_CONFIG_PATH: join(state, "no-config.json"), ...(url ? { RELO_API_URL: url, RELO_TOKEN: TOKEN } : {}), ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out = []; const err = [];
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.stderr.on("data", (chunk) => err.push(chunk));
  if (input !== undefined) child.stdin.end(input);
  const done = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString(), state })));
  return { child, done, out };
}

const node = (source) => ["--", process.execPath, "-e", source];
const finishOf = (requests) => requests.find((request) => request.url.endsWith("/finish"));

test("exit 0 finishes the work as finished: Done in <duration>", async () => {
  const server = await fakeServer();
  const { done } = launch(node("process.exit(0)"), { url: server.url });
  const run = await done;
  server.close();
  assert.equal(run.code, 0);
  const start = server.requests.find((request) => request.url.endsWith("/works") && request.method === "POST");
  assert.ok(start.key, "a start carries an idempotency key");
  assert.deepEqual(start.body.leaseSeconds, 900);
  assert.equal(start.body.goal.readable, "Run node");
  const finish = finishOf(server.requests);
  assert.equal(finish.body.result, "finished");
  assert.match(finish.body.outcome.readable, /^Done in \d+s$/u);
});

test("a server that never answers does not delay the command", async () => {
  const hang = createServer(() => {});
  await new Promise((resolve) => hang.listen(0, "127.0.0.1", resolve));
  const begun = Date.now();
  const run = launch(node("process.stdout.write('go')"), { url: `http://127.0.0.1:${hang.address().port}` });
  const seen = await new Promise((resolve) => run.child.stdout.once("data", () => resolve(Date.now() - begun)));
  assert.ok(seen < 2500, `the command started after ${seen} ms`);
  const ended = await run.done;
  hang.closeAllConnections?.(); hang.close();
  assert.equal(ended.code, 0);
}, { timeout: 20_000 });

test("exit 3 finishes the work as failed and relo exits 3", async () => {
  const server = await fakeServer();
  const run = await launch(node("process.exit(3)"), { url: server.url }).done;
  server.close();
  assert.equal(run.code, 3);
  const finish = finishOf(server.requests);
  assert.equal(finish.body.result, "failed");
  assert.match(finish.body.outcome.readable, /^Failed \(exit 3\) after \d+s$/u);
  assert.equal(run.stdout.length, 0, "relo prints nothing of its own");
});

test("a command killed by a signal is failed: Stopped by SIGNAL", async () => {
  const server = await fakeServer();
  const run = await launch(node("process.kill(process.pid, 'SIGKILL')"), { url: server.url }).done;
  server.close();
  assert.equal(run.code, 137);
  const finish = finishOf(server.requests);
  assert.equal(finish.body.result, "failed");
  assert.match(finish.body.outcome.readable, /^Stopped by SIGKILL after /u);
});

test("SIGINT is forwarded to the command and the work is dropped", async () => {
  const server = await fakeServer();
  const { child, done } = launch(node("console.log('ready'); setInterval(() => {}, 1000)"), { url: server.url });
  await new Promise((resolve) => { child.stdout.on("data", (chunk) => { if (String(chunk).includes("ready")) resolve(); }); });
  child.kill("SIGINT");
  const run = await done;
  server.close();
  assert.equal(run.code, 130);
  const finish = finishOf(server.requests);
  assert.equal(finish.body.result, "dropped");
  assert.match(finish.body.outcome.readable, /^Stopped by Ctrl-C/u);
});

test("SIGTERM is forwarded to the command, which ends failed", async () => {
  const server = await fakeServer();
  const { child, done } = launch(node("console.log('ready'); setInterval(() => {}, 1000)"), { url: server.url });
  await new Promise((resolve) => { child.stdout.on("data", (chunk) => { if (String(chunk).includes("ready")) resolve(); }); });
  child.kill("SIGTERM");
  const run = await done;
  server.close();
  assert.equal(run.code, 143);
  assert.equal(finishOf(server.requests).body.result, "failed");
});

test("the network going away after the start queues the finish; the command and its exit code are untouched", async () => {
  const server = await fakeServer({ dropFinish: true });
  const run = await launch(node("process.exit(5)"), { url: server.url }).done;
  server.close();
  assert.equal(run.code, 5);
  const queued = readdirSync(join(run.state, "outbox", "declared"));
  assert.equal(queued.length, 1);
  const { entry } = JSON.parse(readFileSync(join(run.state, "outbox", "declared", queued[0]), "utf8"));
  assert.match(entry.route, /\/works\/wrk_1\/finish$/u);
  assert.equal(entry.body.final.result, "failed");
  assert.match(entry.body.final.outcome.readable, /^Failed \(exit 5\)/u);
});

test("a server that is down from the start: the command still runs, keeps its exit code, one line says so", async () => {
  const url = await closedUrl();
  const run = await launch(node("process.stdout.write('ran'); process.exit(7)"), { url }).done;
  assert.equal(run.code, 7);
  assert.equal(run.stdout.toString(), "ran");
  assert.equal(run.stderr.trim().split("\n").filter((line) => line.startsWith("Relo:")).length, 1);
  assert.equal(readdirSync(join(run.state, "outbox", "declared")).length, 1, "the start waits in the outbox");
});

test("not signed in: the command runs anyway, one stderr line, exit code kept", async () => {
  const run = await launch(node("process.exit(4)")).done;
  assert.equal(run.code, 4);
  const lines = run.stderr.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Relo: not signed in/u);
});

test("stdout, stderr and stdin pass through byte for byte", async () => {
  const server = await fakeServer();
  const source = "const b = Buffer.from(Array.from({ length: 256 }, (_, i) => i)); process.stdout.write(b); process.stderr.write('oops\\n'); process.stdin.pipe(process.stdout)";
  const run = await launch(node(source), { url: server.url, input: Buffer.from([0xff, 0x00, 0x41]) }).done;
  server.close();
  const expected = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from([0xff, 0x00, 0x41])]);
  assert.ok(run.stdout.equals(expected));
  assert.equal(run.stderr, "oops\n");
});

test("a secret-looking argument or environment value never reaches the goal", async () => {
  const server = await fakeServer();
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const run = await launch(["--", "node", "-e", "0", "deploy", "--password", "hunter2", secret, "--token=hunter3"], { url: server.url, env: { DEPLOY_KEY: "envsecret99" } }).done;
  server.close();
  assert.equal(run.code, 0);
  const start = server.requests.find((request) => request.url.endsWith("/works") && request.method === "POST");
  const text = JSON.stringify(start.body);
  for (const hidden of [secret, "hunter2", "hunter3", "envsecret99", "password"]) assert.ok(!text.includes(hidden), hidden);
});

test("--goal is the owner's own words; without -- it is a usage error and nothing runs", async () => {
  const server = await fakeServer();
  const named = await launch(["--goal", "Nightly photo backup", ...node("0")], { url: server.url }).done;
  assert.equal(server.requests.find((request) => request.url.endsWith("/works") && request.method === "POST").body.goal.readable, "Nightly photo backup");
  const bare = await launch(["echo", "hi"], { url: server.url }).done;
  server.close();
  assert.equal(bare.code, 2);
  assert.equal(named.code, 0);
});

test("a command that cannot start is failed with 127, and an agent is refused", async () => {
  const server = await fakeServer();
  const missing = await launch(["--", "definitely-not-a-command-xyz"], { url: server.url }).done;
  assert.equal(missing.code, 127);
  assert.equal(finishOf(server.requests).body.result, "failed");
  const agent = await launch(node("process.stdout.write('ran')"), { url: server.url, env: { CLAUDE_CODE_SESSION_ID: "sess-1" } }).done;
  server.close();
  assert.equal(agent.code, 2);
  assert.ok(!agent.stdout.toString().includes("ran") || /Refused/u.test(agent.stdout.toString()));
  assert.match(agent.stdout.toString() + agent.stderr, /relo run wraps a script/u);
});

test("the pure parts: durations, the default goal, how an end is classified", () => {
  assert.deepEqual([4_000, 65_000, 3_723_000].map(formatDuration), ["4s", "1m 5s", "1h 2m"]);
  assert.equal(defaultGoal(["npm", "run", "build"]), "Run npm");
  assert.equal(defaultGoal(["/usr/local/bin/backup.sh", "--full", "x9Y"]), "Run backup.sh");
  assert.equal(defaultGoal(["cmd", "hunter2"]), "Run cmd");
  assert.equal(defaultGoal(["./deploy", "prod", "--token", "abc"]), "Run deploy");
  assert.deepEqual(classify({ code: 0, elapsed: 4_000 }), { result: "finished", outcome: "Done in 4s", exitCode: 0 });
  assert.equal(classify({ code: 2, elapsed: 61_000 }).outcome, "Failed (exit 2) after 1m 1s");
  assert.equal(classify({ code: null, signal: "SIGTERM", elapsed: 1_000 }).outcome, "Stopped by SIGTERM after 1s");
  assert.equal(classify({ code: null, signal: "SIGINT", interrupted: true, elapsed: 1_000 }).result, "dropped");
});
