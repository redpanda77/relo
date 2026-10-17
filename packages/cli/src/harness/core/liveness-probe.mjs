// Finding and checking a harness's own process (observed state only). Loaded by a hook only for the first
// event of a session run (harness/core/process.mjs imports it dynamically) and by the sweep in the flusher,
// so the per-hook path never pays for it. `ps` is the one platform call: it works on macOS and Linux; where it
// is missing, nothing is recorded and the session simply has no liveness check.
import { execFile } from "node:child_process";

// The harness runs its hooks through a shell, so it is the parent or grandparent; three levels cover a wrapper, and a
// hook with no harness above it (a test, a manual run) stops early instead of walking the whole tree.
const MAX_LEVELS = 3;
const PS_TIMEOUT_MS = 1_000;
// ps -o ppid=,lstart=,command= : "  123 Sat Oct 17 10:00:00 2026 /path/claude --flag"
const ROW = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/u;

/** { ppid, start, command } of one process, or undefined when it is gone or ps cannot say. */
export function processRow(pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "ppid=,lstart=,command=", "-p", String(pid)], { timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
      const match = error ? null : ROW.exec(String(stdout).split("\n")[0] ?? "");
      resolve(match ? { ppid: Number(match[1]), start: match[2], command: match[3] } : undefined);
    });
  });
}

/**
 * The nearest ancestor of `startPid` (the hook's parent) whose command `match` accepts: { pid, start }, or
 * undefined. At most MAX_LEVELS levels up; `row` is injectable for tests.
 */
export async function findHarnessProcess({ match, startPid, row = processRow }) {
  let pid = startPid;
  for (let level = 0; level < MAX_LEVELS && Number.isInteger(pid) && pid > 1; level += 1) {
    const found = await row(pid);
    if (!found) return undefined;
    if (match(found.command)) return { pid, start: found.start };
    pid = found.ppid;
  }
  return undefined;
}

/** False only when the process is gone, or its pid now belongs to a process started at another time. */
export async function processAlive({ pid, start, row = processRow, kill = process.kill.bind(process) }) {
  try {
    kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM: it exists, owned by someone else.
  }
  if (typeof start !== "string" || !start) return true;
  const found = await row(pid);
  return !found || found.start === start;
}
