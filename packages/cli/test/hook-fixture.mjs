// A hook run against a throwaway state folder, a clock that tests move, and a fake server for the
// outbox flusher. `box.sent` is every observed snapshot the hook queued, in order (read from the outbox
// after each run, since the observed lane keeps only the latest per session); `box.flush()` runs
// `relo outbox flush` and records each request in `box.requests`.
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.mjs";
import { cardDependencies } from "./fake-cards.mjs";

export const SESSION_ID = "9f2c1c34-5c0e-4d63-8a3a-7f1d3bd2c001";
export const SECRET_PROMPT = "deploy to prod with password hunter2";

export async function cli(argv, dependencies) {
  const stdout = [];
  const stderr = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), stdoutIsTTY: false }, dependencies);
  return { exitCode, stdout, stderr, line: stdout[0] ? JSON.parse(stdout[0]) : undefined };
}

/** Every pending outbox entry of a lane (parsed files), oldest first. */
export async function queuedEntries(outbox, lane = "observed") {
  let names = [];
  try { names = (await readdir(join(outbox, lane))).filter((name) => name.endsWith(".json") && !name.startsWith(".")); } catch { return []; }
  const entries = await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(outbox, lane, name), "utf8"))));
  return entries.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt)).map((data) => data.entry);
}

export async function hookBox({ input, env = {}, config = {}, respond } = {}) {
  const state = await mkdtemp(join(tmpdir(), "relo-hook-state-"));
  const repo = await mkdtemp(join(tmpdir(), "relo-hook-repo-"));
  await mkdir(join(repo, ".git"));
  const box = { state, repo, outbox: join(state, "outbox"), sent: [], entries: [], requests: [], other: [], minted: [], revoked: [],
    clock: 1_800_000_000_000, stored: [], spawned: 0, seen: new Set() };
  box.stdin = input ?? { session_id: SESSION_ID, hook_event_name: "SessionStart", source: "startup", cwd: repo, transcript_path: "/Users/x/.claude/t.jsonl",
    prompt: SECRET_PROMPT, tool_name: "Bash", tool_input: { command: "cat ~/.ssh/id_rsa" }, tool_response: { stdout: "secret" } };
  // The fake server: `request` is the only way the flusher sends; anything else a hook or flusher calls
  // is recorded in `other` (hooks never reach a card, work or question).
  const client = (config) => new Proxy({
    request: async (method, route, options = {}) => {
      box.requests.push({ token: config.token, method, route, body: options.body, idempotencyKey: options.idempotencyKey });
      if (respond) return respond({ method, route, body: options.body, token: config.token });
      return { ok: true };
    },
    createHarnessCredential: async (body) => { box.minted.push({ token: config.token, body }); return { id: "hcr_1", token: "h".repeat(44) }; },
    revokeHarnessCredential: async (id) => { box.revoked.push({ token: config.token, id }); return {}; },
  }, { get: (target, name) => target[name] ?? (typeof name === "string" && name !== "then"
    ? async (...args) => { box.other.push({ name, args }); return {}; } : undefined) });
  box.deps = () => ({
    ...cardDependencies(undefined, { env: { RELO_HARNESS_CREDENTIAL_PATH: join(state, "harness-credential"), ...env } }),
    loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44), ...config }),
    loadStoredConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44), revision: "r1" }),
    writeConfig: async (_path, value) => { box.stored.push(value); },
    clientFactory: client,
    configPath: () => join(state, "config.json"),
    loadComputerName: () => undefined,
    hookStateDirectory: join(state, "hooks"),
    readStdinJson: async () => box.stdin,
    stdinIsTTY: false,
    computerName: () => "Studio Mac",
    spawnFlusher: () => { box.spawned += 1; },
    // No real `ps` walk in tests: a test of the liveness check passes its own.
    harnessProcess: { findHarnessProcess: async () => undefined, processAlive: async () => true },
    home: state, cwd: repo,
    now: () => box.clock,
  });
  box.collect = async () => {
    for (const entry of await queuedEntries(box.outbox)) {
      if (box.seen.has(entry.idempotencyKey)) continue;
      box.seen.add(entry.idempotencyKey);
      box.entries.push(entry);
      box.sent.push(entry.body);
    }
  };
  box.run = async (argv, extra = {}) => {
    const out = await cli(argv, { ...box.deps(), ...extra });
    await box.collect();
    return out;
  };
  box.flush = (extra = {}) => cli(["outbox", "flush"], { ...box.deps(), now: () => Date.now(), ...extra });
  /** One hook event: sets stdin from a native event name and runs the matching command. */
  box.event = (name, command, extra = {}, argv = []) => {
    box.stdin = { session_id: SESSION_ID, hook_event_name: name, cwd: repo, ...extra };
    box.clock += 1_000;
    return box.run(["hook", command, ...argv]);
  };
  return box;
}
