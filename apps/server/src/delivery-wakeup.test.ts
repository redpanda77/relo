import { EventEmitter } from "node:events";
import { describe,expect,test,vi } from "vitest";
import { DeliveryJobWakeup } from "./delivery-wakeup.js";

class FakeListener extends EventEmitter {
  readonly queries: string[] = [];
  released = false;
  async query(text: string) { this.queries.push(text); return { rowCount: 0,rows: [] }; }
  release() { this.released = true; }
}

describe("delivery job wakeup", () => {
  test("wakes immediately on the dedicated channel and retains an early notification", async () => {
    const client = new FakeListener();
    const wakeup = await DeliveryJobWakeup.listen({ connect: async () => client } as never);
    const waiting = wakeup.wait(10_000);
    client.emit("notification",{ channel: "relo_delivery_jobs",payload: "ready" });
    await expect(waiting).resolves.toBe("notified");
    client.emit("notification",{ channel: "relo_delivery_jobs",payload: "ready" });
    await expect(wakeup.wait(10_000)).resolves.toBe("notified");
    await wakeup.close();
    expect(client.queries).toEqual(["LISTEN relo_delivery_jobs"]);
    expect(client.released).toBe(true);
  });

  test("keeps the bounded poll timeout and shutdown abort as recovery paths", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeListener(),replacement = new FakeListener();
      let connects = 0;
      const wakeup = await DeliveryJobWakeup.listen({ connect: async () => ++connects === 1 ? client : replacement } as never);
      const timed = wakeup.wait(2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(timed).resolves.toBe("timeout");
      client.emit("error",new Error("listener lost"));
      await expect(wakeup.wait(2_000)).resolves.toBe("notified");
      const recovered = wakeup.wait(2_000);
      await vi.advanceTimersByTimeAsync(250);
      await expect(recovered).resolves.toBe("notified");
      expect(connects).toBe(2);
      expect(client.released).toBe(true);
      expect(replacement.queries).toEqual(["LISTEN relo_delivery_jobs"]);
      const abort = new AbortController();
      const waiting = wakeup.wait(2_000,abort.signal);
      abort.abort();
      await expect(waiting).resolves.toBe("aborted");
      await wakeup.close();
    } finally { vi.useRealTimers(); }
  });

  test("aborts an active waiter when the listener is explicitly closed", async () => {
    const client = new FakeListener();
    const wakeup = await DeliveryJobWakeup.listen({ connect: async () => client } as never);
    const waiting = wakeup.wait(10_000);
    await wakeup.close();
    await expect(waiting).resolves.toBe("aborted");
    expect(client.released).toBe(true);
  });
});
