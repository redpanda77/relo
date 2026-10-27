import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createShutdown } from "./shutdown.js";

function fakeChild(exitsOnTerm = true) {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null, signalCode: null as string | null, signals: [] as string[],
    kill(signal: string) {
      this.signals.push(signal);
      if (signal === "SIGKILL" || exitsOnTerm) setImmediate(() => { this.exitCode = 0; this.emit("exit", 0, null); });
      return true;
    },
  });
  return child as unknown as import("node:child_process").ChildProcess & { signals: string[] };
}

describe("supervisor shutdown (launchctl kickstart -k sends SIGTERM)", () => {
  it("stops the children, then PostgreSQL, then cleans up and exits", async () => {
    const order: string[] = [];
    const [api, worker] = [fakeChild(), fakeChild()];
    const { shutdown } = createShutdown({
      children: () => [api, worker, undefined], log: () => undefined,
      stopPostgres: async () => { order.push(`postgres after ${api.signals}/${worker.signals}`); },
      cleanup: async () => { order.push("cleanup"); }, exit: (code) => order.push(`exit ${code}`),
    });
    await shutdown("SIGTERM");
    expect(order).toEqual(["postgres after SIGTERM/SIGTERM", "cleanup", "exit 0"]);
  });

  it("a second SIGTERM mid-stop neither skips nor repeats the PostgreSQL stop, nor exits before it", async () => {
    const order: string[] = [];
    let finishPostgres!: () => void;
    const { shutdown } = createShutdown({
      children: () => [fakeChild()], log: () => undefined,
      stopPostgres: () => new Promise<void>((resolve) => { order.push("postgres stopping"); finishPostgres = () => { order.push("postgres stopped"); resolve(); }; }),
      cleanup: async () => undefined, exit: (code) => order.push(`exit ${code}`),
    });
    const first = shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await shutdown("SIGTERM");
    expect(order).toEqual(["postgres stopping"]);
    finishPostgres();
    await first;
    expect(order).toEqual(["postgres stopping", "postgres stopped", "exit 0"]);
  });

  it("kills a child that ignores SIGTERM, and still stops PostgreSQL when that fails", async () => {
    const stubborn = fakeChild(false);
    const logged: string[] = [];
    const exits: number[] = [];
    const { shutdown } = createShutdown({
      children: () => [stubborn], killAfterMs: 10, log: (event) => logged.push(event),
      stopPostgres: async () => { throw new Error("pg_ctl failed"); }, cleanup: async () => undefined, exit: (code) => exits.push(code),
    });
    await shutdown("SIGINT");
    expect(stubborn.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(logged).toContain("postgres_stop_failed");
    expect(exits).toEqual([0]);
  });
});
