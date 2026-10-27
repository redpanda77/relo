// `relo statusline` (plan 12 §4.6, optimize): the wrapper Relo puts around Claude Code's status line. Claude Code runs
// it with the status line JSON on stdin; it
//   1. notes the session's context use and cost (local files; the observed snapshot only after a real move) and, where the
//      adapter records them, the plan limits (a local file for `relo usage`),
//   2. runs the owner's previous status line command (saved at install) with the same bytes on stdin, and
//   3. prints that command's output unchanged, byte for byte. With none saved it prints a short line of its own.
// It never fails the status line: whatever goes wrong in 1, 2 still happens. No network.
import { sessionId, sessionKey } from "../../shared/session-key.mjs";
import { isReloStatusline } from "./launch.mjs";
import { readContext, writeContext } from "./bookkeeping.mjs";
import { absolutePath } from "../paths.mjs";
import { COST_STEP_USD, CONTEXT_STEP } from "./state-machine.mjs";

export const STATUSLINE_COMMAND = "relo statusline";
const PREVIOUS_TIMEOUT_MS = 4_000;
const REWRITE_AFTER_MS = 60_000;
const UNSENT_REASONS = new Set(["no_session", "not_signed_in", "enqueue_failed", "error"]);

/** Where install saves the owner's previous status line (and what else optimize changed): next to the hook state. */
export const optimizeStatePath = (directory) => `${directory}/optimize.json`;

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * What the status line JSON says, defensively (every field may be missing or odd): { session, pct (whole percent
 * of the window), over (past 200K tokens), cost (USD to the cent), model, cwd }.
 */
export function readingOf(input, harness) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const window = input.context_window && typeof input.context_window === "object" ? input.context_window : {};
  let pct = finite(window.used_percentage);
  if (pct === undefined) {
    const size = finite(window.context_window_size);
    const usage = window.current_usage && typeof window.current_usage === "object" ? window.current_usage : undefined;
    if (size > 0 && usage) {
      const used = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].reduce((sum, key) => sum + (finite(usage[key]) ?? 0), 0);
      pct = (used / size) * 100;
    }
  }
  const cost = finite(input.cost?.total_cost_usd);
  const id = sessionId(input.session_id);
  const model = [input.model?.display_name, input.model?.id].find((name) => typeof name === "string" && name.trim());
  return {
    session: id && harness ? sessionKey({ harness, id }) : undefined,
    ...(pct === undefined ? {} : { pct: Math.min(100, Math.max(0, Math.round(pct))) }),
    over: input.exceeds_200k_tokens === true,
    ...(cost === undefined || cost < 0 ? {} : { cost: Math.round(cost * 100) / 100 }),
    ...(model ? { model: model.trim().slice(0, 60) } : {}),
    ...(absolutePath(input.cwd) ? { cwd: input.cwd } : {}),
  };
}

/** The line printed when the owner had no status line of their own. */
export function defaultLine(reading) {
  const parts = [reading?.model, reading?.pct === undefined ? (reading?.over ? "context over 200K" : undefined) : `context ${reading.pct}%`,
    reading?.cost === undefined ? undefined : `$${reading.cost.toFixed(2)}`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Relo";
}

/** The owner's previous status line command, saved by install; undefined when there was none. */
async function previousCommand(dependencies) {
  try {
    const { readFile } = await import("node:fs/promises");
    const saved = JSON.parse(await readFile(optimizeStatePath(dependencies.hookStateDirectory), "utf8"))?.statusLine?.previous;
    return typeof saved?.command === "string" && saved.command.trim() && !isReloStatusline(saved.command.trim()) ? saved.command : undefined;
  } catch { return undefined; }
}

/** Runs the command through the shell with `raw` on stdin: resolves with its stdout bytes (whatever it printed), or undefined if it could not start. */
async function runPrevious(command, raw, dependencies) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const chunks = [];
    let child;
    try {
      child = spawn(command, { shell: true, env: dependencies.env, cwd: dependencies.cwd, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch { resolve(undefined); return; }
    const finish = () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(); }, PREVIOUS_TIMEOUT_MS);
    child.on("error", () => { clearTimeout(timer); resolve(chunks.length ? Buffer.concat(chunks) : undefined); });
    child.stdout?.on("data", (chunk) => chunks.push(chunk));
    child.on("close", finish);
    child.stdin.on("error", () => {});
    child.stdin.end(raw);
  });
}

/** Stores the reading; queues a snapshot only when context moved CONTEXT_STEP points or cost COST_STEP_USD since the last one sent. */
async function note(reading, input, { adapter, dependencies }) {
  if (!reading?.session) return;
  const directory = dependencies.hookStateDirectory;
  const now = dependencies.now();
  const before = await readContext(directory, reading.session) ?? {};
  const next = { ...before, at: now, over: reading.over, ...(reading.pct === undefined ? {} : { pct: reading.pct }),
    ...(reading.cost === undefined ? {} : { cost: reading.cost }) };
  const moved = next.pct !== before.pct || next.cost !== before.cost || next.over !== before.over || !(now - before.at < REWRITE_AFTER_MS);
  const due = (reading.pct !== undefined && !(Math.abs(reading.pct - before.sentPct) < CONTEXT_STEP))
    || (reading.cost !== undefined && !(Math.abs(reading.cost - before.sentCost) < COST_STEP_USD));
  if (due) {
    // Loaded only when a snapshot is due (rarely): the status line itself stays light.
    const { processContext } = await import("./process.mjs");
    const result = await processContext({ adapter, session: reading.session, contextPct: reading.pct, costUsd: reading.cost, cwd: reading.cwd, input, dependencies });
    // Only what reached the server's queue (or is already folded into state it will send) counts as sent: a session the
    // hooks never saw, a computer not signed in, or a failure leaves the next reading due.
    if (!UNSENT_REASONS.has(result?.reason)) {
      if (reading.pct !== undefined) next.sentPct = reading.pct;
      if (reading.cost !== undefined) next.sentCost = reading.cost;
    }
  }
  if (moved || next.sentPct !== before.sentPct || next.sentCost !== before.sentCost) await writeContext(directory, reading.session, next);
}

/** The plan limits, when the status line JSON carries them and the harness records them (its adapter's `recordUsage`). */
async function recordUsage(input, adapter, dependencies) {
  try {
    if (!input?.rate_limits || typeof adapter?.recordUsage !== "function") return;
    await adapter.recordUsage(input, dependencies);
  } catch { /* never breaks the line */ }
}

/**
 * One status line run for the harness whose status line it is (`adapter`). `raw`: the stdin bytes; `write(bytes)` prints. Resolves when printed; never throws.
 */
export async function runStatusline({ adapter, raw, dependencies, write }) {
  let input;
  try { input = JSON.parse(raw.toString("utf8")); } catch { input = undefined; }
  const reading = (() => { try { return readingOf(input, adapter.id); } catch { return undefined; } })();
  const command = await previousCommand(dependencies);
  const [printed] = await Promise.all([
    command ? runPrevious(command, raw, dependencies).catch(() => undefined) : Promise.resolve(undefined),
    note(reading, input, { adapter, dependencies }).catch(() => {}),
    recordUsage(input, adapter, dependencies),
  ]);
  try {
    write(printed ?? Buffer.from(`${defaultLine(reading)}\n`));
  } catch { /* nothing left to do */ }
}
