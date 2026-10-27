// Finding and checking a harness's own process (observed state only). Loaded by a hook only for the first
// event of a session run (harness/core/process.mjs imports it dynamically) and by the sweep in the flusher,
// so the per-hook path never pays for it. The one platform call is `ps` on macOS and Linux and, on Windows, one
// PowerShell/CIM query that returns the whole ancestor chain; where it is missing, nothing is recorded and the
// session simply has no liveness check.
import { execFile } from "node:child_process";

// The harness runs its hooks through a shell, so it is the parent or grandparent; three levels cover a wrapper, and a
// hook with no harness above it (a test, a manual run) stops early instead of walking the whole tree.
const MAX_LEVELS = 3;
const PS_TIMEOUT_MS = 1_000;
const WIN_TIMEOUT_MS = 3_000;
// ps -o ppid=,lstart=,command= : "  123 Sat Oct 17 10:00:00 2026 /path/claude --flag"
const ROW = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/u;

// Windows: "pid|ppid|creation (FILETIME ticks)|command line", one line per process, the process first and then its
// ancestors. CIM is the only built-in source of a command line (wmic is gone from current Windows). `pid` and
// `levels` are validated integers, and the script goes over as -EncodedCommand, so nothing is shell-parsed.
const winScript = (pid, levels) => `$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;$id=${pid};`
  + `for($i=0;$i -lt ${levels} -and $id -gt 1;$i++){$p=Get-CimInstance Win32_Process -Filter "ProcessId=$id";if(!$p){break};`
  + `Write-Output ("{0}|{1}|{2}|{3}" -f $p.ProcessId,$p.ParentProcessId,$p.CreationDate.ToFileTimeUtc(),($p.CommandLine -replace "[\\r\\n]+"," "));$id=$p.ParentProcessId}`;

const defaultRun = (file, args, options) => new Promise((resolve) => {
  execFile(file, args, options, (error, stdout) => resolve(error ? "" : String(stdout)));
});

/**
 * Windows: [{ pid, ppid, start, command }] for `pid` and up to `levels - 1` ancestors, from ONE PowerShell spawn.
 * The chain stops where a parent pid was reused (a parent cannot be younger than its child). Never throws.
 * `run(file, args, options)` resolves to stdout ("" on failure); injectable for tests.
 */
export async function windowsChain(pid, { levels = MAX_LEVELS, run = defaultRun } = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || pid > 0x7fffffff) return [];
  try {
    const script = Buffer.from(winScript(pid, levels), "utf16le").toString("base64");
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", script], { timeout: WIN_TIMEOUT_MS, windowsHide: true });
    const rows = [];
    for (const line of String(out).split(/\r?\n/u)) {
      const match = /^(\d+)\|(\d+)\|(\d+)\|(.*)$/u.exec(line);
      if (!match) continue;
      const row = { pid: Number(match[1]), ppid: Number(match[2]), start: match[3], command: match[4].trim() };
      const child = rows.at(-1);
      if (child ? row.pid !== child.ppid || BigInt(row.start) > BigInt(child.start) : row.pid !== pid) break;
      rows.push(row);
    }
    return rows;
  } catch {
    return [];
  }
}

/** { ppid, start, command } of one process, or undefined when it is gone or ps cannot say. */
export function processRow(pid, { platform = process.platform, run } = {}) {
  if (platform === "win32") return windowsChain(pid, { levels: 1, run }).then((rows) => rows[0]);
  return new Promise((resolve) => {
    execFile("ps", ["-o", "ppid=,lstart=,command=", "-p", String(pid)], { timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
      const match = error ? null : ROW.exec(String(stdout).split("\n")[0] ?? "");
      resolve(match ? { ppid: Number(match[1]), start: match[2], command: match[3] } : undefined);
    });
  });
}

/**
 * The nearest ancestor of `startPid` (the hook's parent) whose command `match` accepts: { pid, start }, or
 * undefined. At most MAX_LEVELS levels up; `row` (or `platform` and `run`) is injectable for tests.
 */
export async function findHarnessProcess({ match, startPid, row, platform = process.platform, run }) {
  if (!row && platform === "win32") {
    // One query answers every level of the walk.
    const chain = await windowsChain(startPid, { run });
    row = async (pid) => chain.find((entry) => entry.pid === pid);
  }
  row ??= (pid) => processRow(pid, { platform, run });
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
export async function processAlive({ pid, start, platform = process.platform, run, row = (id) => processRow(id, { platform, run }), kill = process.kill.bind(process) }) {
  try {
    kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM: it exists, owned by someone else (Node reports a Windows access-denied the same way).
  }
  if (typeof start !== "string" || !start) return true;
  const found = await row(pid);
  return !found || found.start === start;
}
