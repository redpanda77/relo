import { EventEmitter } from "node:events";
import { describe,expect,test,vi } from "vitest";
import { ChangeSubscription,InteractionChangeHub } from "./interaction-change-hub.js";
import { PostgresListener } from "./postgres-listener.js";
import { boundedIntegerQuery } from "./request-bounds.js";

class Listener extends EventEmitter {
  releases = 0;
  async query() { return { rows: [],rowCount: 0 }; }
  release() { this.releases++; }
}

describe("scoped interaction change signals",() => {
  test("buffers early commits, isolates principals, bounds fanout, and cancels cleanly",async () => {
    const client = new Listener();
    const hub = await InteractionChangeHub.listen({ connect: async () => client } as never);
    const own = hub.subscribe("owner","request","credential")!;
    const foreign = hub.subscribe("other","request","other-credential")!;
    client.emit("notification",{ channel: "relo_interaction_changes",payload: JSON.stringify({ principalId: "owner",interactionId: "request" }) });
    await expect(own.wait(10_000)).resolves.toBe("changed");
    const cancel = new AbortController();
    const foreignWait = foreign.wait(10_000,cancel.signal);cancel.abort();
    await expect(foreignWait).resolves.toBe("aborted");
    const slots = Array.from({ length: 15 },(_,index) => hub.subscribe("owner",String(index),"credential"));
    expect(slots.every(Boolean)).toBe(true);
    expect(hub.subscribe("owner","overflow","credential")).toBeNull();
    own.close();expect(hub.subscribe("owner","replacement","credential")).not.toBeNull();
    const pending = foreign.wait(10_000);await hub.close();
    await expect(pending).resolves.toBe("aborted");
    expect(client.releases).toBe(1);
  });

  test("lost LISTEN reconnects with catch-up; failed reconnects back off and shutdown cancels retries",async () => {
    vi.useFakeTimers();
    try {
      const first = new Listener(),replacement = new Listener();let connections = 0;
      const notify = vi.fn();
      const listener = await PostgresListener.listen({ connect: async () => {
        connections++;
        if (connections === 2) throw new Error("temporary outage");
        return connections === 1 ? first : replacement;
      } } as never,"relo_interaction_changes",notify);
      first.emit("error",new Error("lost connection"));expect(notify).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(250);expect(connections).toBe(2);
      await vi.advanceTimersByTimeAsync(499);expect(connections).toBe(2);
      await vi.advanceTimersByTimeAsync(1);expect(connections).toBe(3);
      expect(notify).toHaveBeenCalledTimes(2);
      replacement.emit("end");await listener.close();
      await vi.advanceTimersByTimeAsync(10_000);expect(connections).toBe(3);
      expect(first.releases).toBe(1);expect(replacement.releases).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  test("connection obtained after shutdown is released without starting another listener",async () => {
    vi.useFakeTimers();
    try {
      const first = new Listener(),late = new Listener();let connected!: (value: Listener) => void;let n = 0;
      const listener = await PostgresListener.listen({ connect: () => ++n === 1
        ? Promise.resolve(first) : new Promise(resolve => { connected = resolve; }) } as never,"test_changes",() => {});
      first.emit("end");await vi.advanceTimersByTimeAsync(250);
      const closing = listener.close();connected(late);await closing;
      expect(late.releases).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  test("query integers reject NaN, infinity, fractions, empty strings and unbounded timeouts",() => {
    for (const value of ["NaN","Infinity","","-1","1.5","301","1e2","9007199254740992"]) {
      expect(boundedIntegerQuery(value,60,0,300)).toBeNull();
    }
    expect(boundedIntegerQuery(undefined,60,0,300)).toBe(60);
    expect(boundedIntegerQuery("0",60,0,300)).toBe(0);
    expect(boundedIntegerQuery("300",60,0,300)).toBe(300);
    const subscription = new ChangeSubscription();
    expect(() => subscription.wait(NaN)).toThrow();subscription.close();
  });
});
