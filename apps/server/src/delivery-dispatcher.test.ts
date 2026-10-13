import { describe, expect, test } from "vitest";
import { DeliveryDispatcher } from "./delivery-dispatcher.js";

type Job = { id: number; lane: "urgent" | "normal" };
function harness(concurrency = 3, reservedUrgent = 1) {
  const queue: Job[] = [];
  const started: number[] = [];
  const running = new Map<number, () => void>();
  let wake: (() => void) | undefined;
  let waiters = 0;
  let maxWaiters = 0;
  let claims = 0;
  const controller = new AbortController();
  const dispatcher = new DeliveryDispatcher<Job>({
    concurrency, reservedUrgent,
    claim: async (limit, lane) => {
      claims += 1;
      const result = queue.filter(job => job.lane === lane).slice(0, limit);
      for (const job of result) queue.splice(queue.indexOf(job), 1);
      return result;
    },
    dispatch: async job => {
      started.push(job.id);
      await new Promise<void>(resolve => running.set(job.id, resolve));
      running.delete(job.id);
    },
    wait: signal => new Promise<void>(resolve => {
      waiters += 1;
      maxWaiters = Math.max(maxWaiters, waiters);
      const finish = () => {
        if (wake !== finish) return;
        wake = undefined;
        waiters -= 1;
        signal.removeEventListener("abort", finish);
        resolve();
      };
      wake = finish;
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    }),
  });
  return {
    queue, started, running, dispatcher, controller,
    notify() { wake?.(); },
    get claims() { return claims; }, get maxWaiters() { return maxWaiters; },
    async stop(task: Promise<void>) {
      controller.abort();
      for (const release of running.values()) release();
      await task;
    },
  };
}
async function until(check: () => boolean) {
  for (let turn = 0; turn < 100; turn += 1) {
    if (check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error("dispatcher did not reach expected state");
}

describe("continuous delivery dispatcher", () => {
  test("a free slot claims a NEW batch while an old send is suspended", async () => {
    const h = harness(2, 0);
    h.queue.push({ id: 1, lane: "normal" }, { id: 2, lane: "normal" });
    const task = h.dispatcher.run(h.controller.signal);
    await until(() => h.started.length === 2);
    h.queue.push({ id: 3, lane: "urgent" });
    h.running.get(2)!();
    await until(() => h.started.includes(3));
    expect(h.running.has(1)).toBe(true);
    expect(h.maxWaiters).toBeLessThanOrEqual(1);
    await h.stop(task);
  });

  test("routine saturation leaves headroom for a new decision", async () => {
    const h = harness();
    h.queue.push(...[1, 2, 3, 4].map(id => ({ id, lane: "normal" as const })));
    const task = h.dispatcher.run(h.controller.signal);
    await until(() => h.started.length === 2);
    h.queue.push({ id: 5, lane: "urgent" });
    h.notify();
    await until(() => h.started.includes(5));
    expect(h.started).toEqual([1, 2, 5]);
    await h.stop(task);
  });

  test("normal work gets at least every fourth shared admission under urgent load", async () => {
    const h = harness(1, 0);
    h.queue.push(...[1, 2, 3, 4, 5].map(id => ({ id, lane: "urgent" as const })), { id: 6, lane: "normal" });
    const task = h.dispatcher.run(h.controller.signal);
    for (let count = 1; count <= 3; count += 1) {
      await until(() => h.started.length === count);
      h.running.get(h.started[count - 1]!)!();
    }
    await until(() => h.started.length === 4);
    expect(h.started).toEqual([1, 2, 3, 6]);
    await h.stop(task);
  });

  test("empty queue waits, cancellation drains, and waits never accumulate", async () => {
    const h = harness();
    const task = h.dispatcher.run(h.controller.signal);
    await until(() => h.claims > 0);
    await new Promise<void>(resolve => setImmediate(resolve));
    const claims = h.claims;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.claims).toBe(claims);
    await h.stop(task);
    expect(h.maxWaiters).toBe(1);
  });

  test("invalid reservation cannot starve all normal work", () => {
    expect(() => harness(2, 2)).toThrow("reservedUrgent");
  });

  test("a finalization failure stops admission and drains already-owned sends before failing", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started: number[] = [];
    let claimed = false;
    const dispatcher = new DeliveryDispatcher<number>({
      concurrency: 2,reservedUrgent: 0,
      claim: async () => { if (claimed) throw new Error("claimed after failure"); claimed = true; return [1,2]; },
      dispatch: async id => { started.push(id); if (id === 1) await blocked; else throw new Error("finalization failed"); },
      wait: signal => new Promise<void>(resolve => {
        signal.addEventListener("abort",() => resolve(),{ once: true });
        if (signal.aborted) resolve();
      }),
    });
    let finished = false;
    const task = dispatcher.run(new AbortController().signal).catch(error => { finished = true; return error; });
    await until(() => started.length === 2);
    expect(finished).toBe(false);
    release();
    expect((await task).message).toBe("finalization failed");
    await expect(dispatcher.run(new AbortController().signal)).rejects.toThrow("already started");
  });
});
