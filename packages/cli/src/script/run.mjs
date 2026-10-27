// `relo run [--goal TEXT] -- COMMAND [ARGS...]` (plan 14, workstream 2b): the script as producer. It starts a
// work for the producer, runs the command with its stdio untouched, and finishes the work from how the command
// ended (exit 0 done, anything else failed, a signal failed, Ctrl-C dropped). The command is never put at risk:
// a missing login, an unreachable server or a refused write only costs the card, never the command or its exit code.
// Writes go through the declared lane of the outbox, so a finish the network refuses is queued and sent later.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:os";
import { existsSync } from "node:fs";
import { basename, delimiter, extname, isAbsolute, join } from "node:path";
import { workSealer } from "../crypto/seal-work.mjs";
import { UsageError } from "../shared/errors.mjs";
import { getAuthenticated } from "../shared/login.mjs";
import { result } from "../shared/outcome.mjs";
import { checkText } from "../work/content-filter.mjs";
import { declaredLane } from "../work/declared-lane.mjs";
import { WorkRefusal } from "../work/refusal.mjs";
import { restoreFromSelfCopy, loadSelfKey } from "../crypto/self-copy.mjs";
import { producerPathKey, resolveProducer } from "./producer.mjs";
import { leaseSeconds, scriptRequests } from "./work.mjs";

const FINISH_BUDGET_MS = 6_000;
const FORWARDED =["SIGINT", "SIGTERM"];
const USAGE = "relo run [--goal TEXT] [--plan A,B] -- COMMAND [ARGS...]";

/** "4s", "1m 5s", "2h 3m": the time a run took, for the outcome. */
export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The goal when none is given: "Run " and the command's name, never its arguments or environment (a secret passed
 * as an argument must not reach a card). The content filter has the last word on the name.
 */
export function defaultGoal(command) {
  const name = basename(String(command[0] ?? "")).replace(/\.(exe|cmd|bat|com)$/iu, "").slice(0, 40);
  try { return checkText("goal", `Run ${name}`, { words: false }); } catch { return "Run a command"; }
}

/**
 * What to spawn for `argv`. Executables are spawned directly. On Windows, `npm` and other tools installed as
 * .cmd/.bat shims cannot be spawned without a shell (ENOENT, or EINVAL since the 2024 Node fix), so such a
 * command runs through cmd.exe with each argument quoted, the way a person typing it in a shell would.
 */
export function launchTarget(argv, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const [command, ...args] = argv;
  if (platform !== "win32") return { command, args, options: {} };
  const extensions = String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const folders = isAbsolute(command) || /[\\/]/u.test(command) ? [""] : String(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const names = extname(command) ? [command] : [command, ...extensions.map((extension) => command + extension)];
  let found;
  for (const folder of folders) {
    found = names.map((name) => (folder ? join(folder, name) : name)).find((path) => extname(path) && exists(path));
    if (found) break;
  }
  if (!found || !/\.(cmd|bat)$/iu.test(found)) return { command: found ?? command, args, options: {} };
  const quote = (value) => (/^[\w@%+=:,./\\-]+$/u.test(value) ? value : `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`);
  return { command: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${[found, ...args].map(quote).join(" ")}"`], options: { windowsVerbatimArguments: true } };
}

/** The producer key: --producer, RELO_SESSION, else one of this run's own (so two runs never share a work). */
function producerFor(options, caller, command) {
  try {
    return resolveProducer(options, caller);
  } catch (error) {
    if (error?.code !== "PRODUCER_REQUIRED") throw error;
    const stem = basename(String(command[0])).replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 40) || "command";
    return `run-${stem}-${randomBytes(4).toString("hex")}`;
  }
}

/** How the command ended, as the work finishes: { result, outcome, exitCode }. */
export function classify({ code, signal, interrupted, elapsed }) {
  const took = formatDuration(elapsed);
  const exitCode = signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1);
  if (interrupted) return { result: "dropped", outcome: `Stopped by Ctrl-C after ${took}`, exitCode };
  if (signal) return { result: "failed", outcome: `Stopped by ${signal} after ${took}`, exitCode };
  if (code === 0) return { result: "finished", outcome: `Done in ${took}`, exitCode };
  return { result: "failed", outcome: `Failed (exit ${code}) after ${took}`, exitCode };
}

/** An agent is refused: relo run wraps a script's command; an agent declares its work itself. */
export function refuseAgentRun() {
  throw new WorkRefusal("RUN_SCRIPTS_ONLY", {
    what: "relo run wraps a script's command and finishes its work from the exit code; an agent session reports its own work",
    state: "nothing was run",
    next: 'relo work start --goal "…"',
  });
}

const note = (dependencies, line) => { try { dependencies.stderr?.(line); } catch { /* the note is a courtesy */ } };

export async function runScriptRun(command) {
  const { positionals, options, dependencies, parsed } = command;
  const argv = positionals.slice(1);
  if (parsed?.separatorAt !== 1 || argv.length === 0) {
    throw new UsageError(`Usage: ${USAGE}`, { hint: "Put -- before the command so its own flags stay its own: relo run -- ./backup.sh --full" });
  }
  const producer = producerFor(options, dependencies.caller, argv);
  const goal = options.goal ?? defaultGoal(argv);
  const idempotencyKey = `run-${randomUUID()}`;
  const startOptions = { goal, ...(options.plan === undefined ? {} : { plan: options.plan }), lease: options.lease ?? "15m", "idempotency-key": idempotencyKey };
  // Checked before the command runs: a bad flag is a usage error, not a reason to lose the run.
  const [start] = scriptRequests("start", startOptions, { producer, stdinIsTTY: true });
  const lease = leaseSeconds(startOptions.lease);

  // The card is a courtesy: whatever goes wrong with it, the command still runs, and is never waited for.
  let client; let config; let lane; let work;
  const cardReady = (async () => {
    let signedIn = true;
    try {
      ({ config, client } = await getAuthenticated(dependencies));
    } catch (error) {
      signedIn = false;
      note(dependencies, `Relo: not signed in${error?.code === "INSECURE_CONFIG" ? " (the config file is not readable)" : ""}, so this run will not show on your phone (relo auth login). Running it anyway.`);
    }
    if (!signedIn) return;
    let sealing;
    const sealer = () => (sealing ??= workSealer({ client, config, dependencies, notes: [] }));
    const opened = declaredLane({ client, config, dependencies, identity: { sessionKey: producer, harness: "script" }, sealer });
    lane = opened;
    try {
      await opened.drain();
      const answer = await opened.write({ route: { method: start.method, path: start.path }, key: idempotencyKey, seal: start.seal, readable: start.body,
        sealedForm: start.sealedForm, card: start.card, copy: start.copy });
      work = answer?.work ?? undefined;
    } catch (error) {
      lane = undefined;
      note(dependencies, `Relo: this run could not be recorded (${String(error?.message ?? error).slice(0, 120)}). Running it anyway.`);
    }
  })().catch(() => { lane = undefined; });

  const startedAt = Date.now();
  const signals = dependencies.signals ?? process;
  const outcome = await new Promise((resolve) => {
    let interrupted = false;
    let heartbeat;
    let finished = false;
    let child;
    const forward = (signal) => {
      if (signal === "SIGINT") interrupted = true;
      try { child?.kill(signal); } catch { /* already gone */ }
    };
    const handlers = FORWARDED.map((signal) => [signal, () => forward(signal)]);
    const done = (ended) => {
      finished = true;
      clearInterval(heartbeat);
      for (const [signal, handler] of handlers) signals.removeListener(signal, handler);
      resolve({ ...ended, interrupted });
    };
    for (const [signal, handler] of handlers) signals.on(signal, handler);
    try {
      const target = launchTarget(argv, { env: dependencies.env ?? process.env });
      child = spawn(target.command, target.args, { stdio: "inherit", env: dependencies.env ?? process.env, ...target.options });
    } catch (error) {
      note(dependencies, `relo run: cannot start ${basename(argv[0])} (${error?.code ?? "error"})`);
      done({ code: error?.code === "EACCES" ? 126 : 127, spawnFailed: true });
      return;
    }
    child.on("error", (error) => {
      note(dependencies, `relo run: cannot start ${basename(argv[0])} (${error?.code ?? "error"})`);
      done({ code: error?.code === "EACCES" ? 126 : 127, spawnFailed: true });
    });
    child.on("close", (code, signal) => done({ code, signal }));
    // A command quieter than its lease would look stale: renew it while the command runs (a failure changes nothing).
    cardReady.then(() => {
      if (!work?.id || !client?.request || finished) return;
      const path = `/api/producers/${producerPathKey(producer)}/works/${work.id}/heartbeat`;
      heartbeat = setInterval(() => { client.request("POST", path, { body: { leaseSeconds: lease } }).catch(() => {}); }, Math.max(20_000, lease * 1000 / 3));
      heartbeat.unref?.();
    });
  });

  const ended = outcome.spawnFailed
    ? { result: "failed", outcome: "Could not start the command", exitCode: outcome.code }
    : classify({ ...outcome, elapsed: Date.now() - startedAt });
  // Give a slow start a moment to land so the finish can follow it; never hold the exit code for long.
  await Promise.race([cardReady, new Promise((resolve) => setTimeout(resolve, 5000).unref?.())]);
  // The finish is bounded too: a server that never answers must not hold the command's exit code for 30 s.
  if (lane) {
    await Promise.race([
      finishRun({ lane, client, producer, work, ended, dependencies, idempotencyKey }),
      new Promise((resolve) => setTimeout(() => { note(dependencies, `Relo: the server did not answer, so this run's result (${ended.outcome}) may not be on your phone.`); resolve(); }, FINISH_BUDGET_MS).unref?.()),
    ]);
  }
  const exit = dependencies.exit ?? ((code) => process.exit(code));
  const data = { ok: ended.result !== "failed", producer, result: ended.result, outcome: ended.outcome };
  // Relo prints nothing of its own: the command's output is the output, and its exit code is ours.
  exit(ended.exitCode);
  return { ...result("run", data), exitCode: ended.exitCode };
}

/** The finish: sent now, or queued behind the start when the network is down. Never throws. */
async function finishRun({ lane, client, producer, work, ended, dependencies, idempotencyKey }) {
  try {
    let known = work;
    if (!known?.id) {
      // The start was queued: send it now if the network is back, then find the work it made.
      await lane.drain();
      if (!lane.queued) {
        const listed = await client.request("GET", `/api/producers/${producerPathKey(producer)}/works`, { query: { state: "open" } }).catch(() => undefined);
        const key = listed?.works?.some((row) => row?.producerSealed) ? await loadSelfKey(dependencies) : null;
        known = restoreFromSelfCopy(listed?.works?.[0] ?? null, key) ?? undefined;
      }
    }
    if (!known?.id) {
      note(dependencies, `Relo: could not reach the server, so this run's result (${ended.outcome}) is not on your phone.`);
      return;
    }
    const [finish] = scriptRequests("finish", { outcome: ended.outcome, [ended.result === "finished" ? "finished" : ended.result]: true },
      { producer, work: { id: known.id, sealed: Boolean(known.sealed), goal: known.goal, plan: known.plan } });
    const answer = await lane.write({ route: { method: finish.method, path: finish.path }, key: `finish-${idempotencyKey}`, seal: finish.seal,
      readable: finish.body, sealedForm: finish.sealedForm, card: finish.card, copy: finish.copy, outcomeNotice: finish.outcomeNotice });
    if (answer === null) await dependencies.spawnFlusher?.();
  } catch (error) {
    note(dependencies, `Relo: this run's result could not be recorded (${String(error?.message ?? error).slice(0, 120)}).`);
  }
}
