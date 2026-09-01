import { describe,expect,test } from "vitest";
import { runBoundedWorkerBatch } from "./worker-batch.js";

describe("bounded worker batch", () => {
  test("does not let one blocked dispatch hold later jobs behind it", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started: number[] = [];
    const completed: number[] = [];
    const running = runBoundedWorkerBatch([0,1,2],2,async (value) => {
      started.push(value);
      if (value === 0) await firstBlocked;
      completed.push(value);
    });
    await viWaitUntil(() => started.includes(1) && completed.includes(1));
    expect(started).toContain(2);
    expect(completed).toEqual(expect.arrayContaining([1,2]));
    expect(completed).not.toContain(0);
    releaseFirst();
    await running;
    expect(completed).toHaveLength(3);
  });

  test("honors its cap and drains every claimed job before surfacing a failure", async () => {
    let active = 0;
    let maximum = 0;
    const visited: number[] = [];
    await expect(runBoundedWorkerBatch([0,1,2,3,4],2,async (value) => {
      active += 1;
      maximum = Math.max(maximum,active);
      await Promise.resolve();
      visited.push(value);
      active -= 1;
      if (value === 1) throw new Error("durable finalization failed");
    })).rejects.toThrow("durable finalization failed");
    expect(maximum).toBe(2);
    expect(visited.sort()).toEqual([0,1,2,3,4]);
  });

  test("rejects an invalid cap before starting work", async () => {
    await expect(runBoundedWorkerBatch([1],0,async () => {})).rejects.toThrow(
      "worker batch concurrency must be a positive integer",
    );
  });
});

async function viWaitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}
