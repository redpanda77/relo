#!/usr/bin/env node
// One pipeline step, bounded (plan 15): every build, test and release script runs its commands through this, and so
// does every agent for anything heavier than a single test file.
//
//   node scripts/step.mjs [--name NAME] [--timeout 10m] [--quiet 3m] [--heavy] -- COMMAND [ARGS...]
//
// --timeout   the step's budget (default 10m): past it the step's whole process group is stopped (TERM, then KILL
//             10 s later) and the step fails with exit 124.
// --quiet     no output for this long (default 3m) means it hangs (a prompt, a deadlock): stopped the same way, 125.
// --heavy     a build or a suite: waits for the one heavy slot on this machine (never two at once), and on a Mac runs
//             at background priority (taskpolicy -b: low CPU priority, throttled disk), so the Mac stays usable.
//             RELO_HEAVY_FOREGROUND=1 keeps the slot but not the priority, for work the owner is waiting on (a release
//             of Relo for Mac): background priority holds it to the efficiency cores, about three times slower.
// stdin is closed: a step that asks a question fails at once instead of waiting for an answer nobody gives.
// Prints "step: NAME ok in 42s" (or why it failed) on stderr; exits with the command's status.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseDuration(text, flag) {
  const match = /^(\d+)(s|m|h)?$/u.exec(String(text ?? ""));
  if (!match) throw new Error(`${flag} takes a duration like 90s, 10m or 1h`);
  return Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2] ?? "s"] * 1000;
}

export function parseArgs(argv) {
  const options = { name: undefined, timeoutMs: 600_000, quietMs: 180_000, heavy: false };
  let index = 0;
  for (; index < argv.length && argv[index] !== "--"; index += 1) {
    const flag = argv[index];
    if (flag === "--heavy") options.heavy = true;
    else if (flag === "--name") options.name = argv[++index];
    else if (flag === "--timeout") options.timeoutMs = parseDuration(argv[++index], "--timeout");
    else if (flag === "--quiet") options.quietMs = parseDuration(argv[++index], "--quiet");
    else throw new Error(`unknown option ${flag}`);
  }
  const command = argv.slice(index + 1);
  if (command.length === 0) throw new Error("usage: step.mjs [--name NAME] [--timeout 10m] [--quiet 3m] [--heavy] -- COMMAND [ARGS...]");
  return { ...options, name: options.name ?? command.join(" ").slice(0, 60), command };
}

const stateDir = (env) => join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "relo");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The one heavy slot: a directory created atomically; a holder that died leaves it free. Resolves a release function. */
export async function acquireHeavySlot({ env = process.env, pollMs = 2000, say = () => {}, deadline = Infinity } = {}) {
  const dir = join(stateDir(env), "heavy.lock");
  mkdirSync(stateDir(env), { recursive: true });
  let told = false;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(process.pid));
      return () => rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let holder;
      try { holder = Number(readFileSync(join(dir, "pid"), "utf8")); } catch { holder = undefined; }
      if (holder && !alive(holder)) { rmSync(dir, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error("the heavy slot stayed busy past this step's budget");
      if (!told) { say(`waiting for the heavy slot (held by pid ${holder ?? "?"})`); told = true; }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

/** Runs the step; resolves its exit status (124 over budget, 125 silent too long). */
export async function runStep({ name, command, timeoutMs, quietMs, heavy }, { env = process.env, platform = process.platform,
  stdout = process.stdout, stderr = process.stderr } = {}) {
  const say = (line) => stderr.write(`step: ${name}: ${line}\n`);
  const started = Date.now();
  const release = heavy ? await acquireHeavySlot({ env, say, deadline: started + timeoutMs }) : () => {};
  // Heavy work on a Mac first shuts down simulators nobody holds (scripts/sim.mjs): a forgotten one idles at a core.
  if (heavy && platform === "darwin" && env.RELO_NO_SIM_REAP !== "1") {
    spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "sim.mjs"), "reap"], { stdio: ["ignore", "ignore", "inherit"], timeout: 30_000 });
  }
  // Background priority for heavy work on a Mac: the scheduler gives the owner's apps the cores first.
  const background = heavy && platform === "darwin" && env.RELO_HEAVY_FOREGROUND !== "1";
  const [file, ...args] = background ? ["/usr/sbin/taskpolicy", "-b", ...command] : command;
  const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], detached: true,
    env: { ...env, CI: "1", NONINTERACTIVE: "1", GIT_TERMINAL_PROMPT: "0" } });
  let lastOutput = Date.now();
  let stoppedFor;
  child.stdout.on("data", (chunk) => { lastOutput = Date.now(); stdout.write(chunk); });
  child.stderr.on("data", (chunk) => { lastOutput = Date.now(); stderr.write(chunk); });
  const stop = (why) => {
    if (stoppedFor) return;
    stoppedFor = why;
    say(why);
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
    setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, 10_000).unref();
  };
  // Stopping this step (Ctrl-C, a parent's budget) stops its whole group too: nothing is left running.
  const forward = (signal) => () => { try { process.kill(-child.pid, signal); } catch { /* gone */ } };
  const onInt = forward("SIGINT"), onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  const watch = setInterval(() => {
    if (Date.now() - started > timeoutMs) stop(`over its ${Math.round(timeoutMs / 1000)}s budget: stopped`);
    else if (Date.now() - lastOutput > quietMs) stop(`no output for ${Math.round(quietMs / 1000)}s (waiting on a prompt or hung): stopped`);
  }, Math.min(1000, quietMs, timeoutMs));
  const status = await new Promise((resolve) => {
    child.on("error", (error) => { say(`could not start: ${error.message}`); resolve(127); });
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
  clearInterval(watch);
  process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
  release();
  const seconds = Math.round((Date.now() - started) / 1000);
  if (stoppedFor) return stoppedFor.startsWith("over") ? 124 : 125;
  say(status === 0 ? `ok in ${seconds}s` : `failed (exit ${status}) after ${seconds}s`);
  return status;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  let parsed;
  try { parsed = parseArgs(process.argv.slice(2)); } catch (error) { process.stderr.write(`step: ${error.message}\n`); process.exit(2); }
  process.exit(await runStep(parsed));
}
