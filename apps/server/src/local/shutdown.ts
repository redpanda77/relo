import type { ChildProcess } from "node:child_process";

export type ShutdownDeps = {
  children: () => Array<ChildProcess | undefined>;
  stopPostgres: () => Promise<void>;
  cleanup: () => Promise<void>;
  exit: (code: number) => void;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** How long a child gets after SIGTERM before SIGKILL. */
  killAfterMs?: number;
  /** How a child is asked to stop: SIGTERM by default; Windows has none, so its children get an IPC message instead. */
  terminate?: (child: ChildProcess) => void;
};

/**
 * The supervisor's stop, run on SIGTERM or SIGINT (launchd's `kickstart -k` sends SIGTERM, then SIGKILL after its
 * exit timeout): the API and the worker stop first, then PostgreSQL, then the supervisor's files, then it exits.
 * It runs once: a second signal while it is stopping returns at once and never skips, repeats or cuts short the stop
 * of PostgreSQL (the exit comes only when the first run has finished).
 */
export function createShutdown(deps: ShutdownDeps) {
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    deps.log("stopping", { signal });
    const live = deps.children().filter((child): child is ChildProcess => Boolean(child && child.exitCode === null && child.signalCode === null));
    await Promise.all(live.map((child) => new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, deps.killAfterMs ?? 10_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      (deps.terminate ?? ((target) => target.kill("SIGTERM")))(child);
    })));
    await deps.stopPostgres().catch((error: unknown) => deps.log("postgres_stop_failed", { message: String(error) }));
    await deps.cleanup().catch(() => undefined);
    deps.exit(0);
  };
  return { shutdown, isStopping: () => stopping };
}
