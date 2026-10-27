import { describe,expect,test } from "vitest";
import { SNAPSHOT_ITEMS_MAX_BYTES,inlineShared,newestWithin,withinBudget } from "./queries.js";

describe("snapshot byte budget", () => {
  test("keeps the newest items that fit and never passes the budget", () => {
    // 27 Oct: 250 card events of ~18 KB each made 4.45 MB, past the phone's 4 MiB, and every sync failed.
    const items = Array.from({ length: 250 },(_,index) => ({ id: `ntf_${index}`,sealed: "x".repeat(18_000) }));
    const kept = newestWithin(items,SNAPSHOT_ITEMS_MAX_BYTES);
    expect(kept.length).toBeGreaterThan(100);
    expect(kept.length).toBeLessThan(250);
    expect(kept[0]!.id).toBe("ntf_0");
    expect(kept.map((item) => item.id)).toEqual(items.slice(0,kept.length).map((item) => item.id));
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(SNAPSHOT_ITEMS_MAX_BYTES);
    expect(SNAPSHOT_ITEMS_MAX_BYTES).toBeLessThan(4 * 1024 * 1024);
  });

  test("a snapshot under the budget is unchanged", () => {
    const items = [{ id: "a" },{ id: "b" }];
    expect(newestWithin(items,SNAPSHOT_ITEMS_MAX_BYTES)).toEqual(items);
    expect(newestWithin(items,JSON.stringify(items).length)).toEqual(items);
    expect(newestWithin(items,JSON.stringify(items).length - 1)).toEqual([{ id: "a" }]);
  });

  test("a work's digest counts once and only referenced works are kept", () => {
    const a = "wrk_" + "a".repeat(36),b = "wrk_" + "b".repeat(36),c = "wrk_" + "c".repeat(36);
    const works = { [a]: { plan: ["x".repeat(1000)] },[b]: { plan: ["y".repeat(1000)] },[c]: { plan: [] } };
    const items = [{ id: "1",activity: { workId: a } },{ id: "2",activity: { workId: a } },{ id: "3",activity: { workId: b } },{ id: "4",activity: null }];
    const all = withinBudget(items,works,SNAPSHOT_ITEMS_MAX_BYTES);
    expect(all.items).toEqual(items);
    expect(Object.keys(all.works)).toEqual([a,b]);
    const total = Buffer.byteLength(JSON.stringify(all));
    // Room for the first two items and one digest, not for the second digest.
    const two = withinBudget(items,works,total - 600);
    expect(two.items.map((item) => (item as { id: string }).id)).toEqual(["1","2"]);
    expect(Object.keys(two.works)).toEqual([a]);
    expect(Buffer.byteLength(JSON.stringify(two.items)) + Buffer.byteLength(JSON.stringify(two.works))).toBeLessThanOrEqual(total - 600);
  });

  test("an envelope counts once and unreferenced envelopes are dropped", () => {
    const x = "a".repeat(32),y = "b".repeat(32),z = "c".repeat(32);
    const envelopes = { [x]: { t: "x".repeat(1000) },[y]: { t: "y".repeat(1000) },[z]: {} };
    const items = [{ id: "1",sealed: { alert: null,contentRef: x } },{ id: "2",sealed: { alert: null,contentRef: x } },
      { id: "3",sealed: { alert: null,contentRef: y } },{ id: "4",sealed: { alert: null,content: null } }];
    const all = withinBudget(items,{},SNAPSHOT_ITEMS_MAX_BYTES,envelopes);
    expect(all.items).toEqual(items);
    expect(Object.keys(all.envelopes)).toEqual([x,y]);
    const total = Buffer.byteLength(JSON.stringify(all));
    const two = withinBudget(items,{},total - 600,envelopes);
    expect(two.items.map((item) => (item as { id: string }).id)).toEqual(["1","2"]);
    expect(Object.keys(two.envelopes)).toEqual([x]);
  });
});

describe("older iPhone builds", () => {
  test("get each item's plan and sealed content inline, with no shared maps", () => {
    const work = "wrk_" + "a".repeat(36),ref = "0".repeat(32);
    const own = { kind: "card",v: 1 },newest = { kind: "card",v: 2 };
    const inline = inlineShared({
      items: [{ id: "1",activity: { workId: work,status: "s" },sealed: { alert: null,contentRef: ref } },{ id: "2",activity: null,sealed: { alert: null,content: null } }],
      works: { [work]: { plan: [{ id: "s1" }],rounds: [{ n: 1 }],sealed: newest } },envelopes: { [ref]: own },
    });
    expect(inline.works).toEqual({});
    expect(inline.envelopes).toEqual({});
    expect(inline.items[0]).toEqual({ id: "1",activity: { workId: work,status: "s",plan: [{ id: "s1" }],rounds: [{ n: 1 }] },sealed: { alert: null,content: own,plan: newest } });
    expect(inline.items[1]).toEqual({ id: "2",activity: null,sealed: { alert: null,content: null } });
  });
});
