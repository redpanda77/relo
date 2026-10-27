import type { CurrentSubjectProjection } from "@relo/notification-contracts";
import { describe, expect, it } from "vitest";
import { freshNotices, noticesFrom, SeenNotices, showsNotices } from "./notices.js";
import { notice } from "./test-support/fakeServer.js";

const items = (...n: object[]) => n as unknown as CurrentSubjectProjection[];

describe("noticesFrom", () => {
  it("keeps ordinary notices only, newest first, at most 12", () => {
    const many = Array.from({ length: 15 }, (_, i) => notice(i + 1, { createdAt: new Date(Date.UTC(2026, 9, 14, 10, i)).toISOString() }));
    const found = noticesFrom(items(...many, notice(90, { kind: "decision" }), notice(91, { interaction: { id: "x" } }), notice(92, { activity: { id: "x" } }),
      notice(93, { notificationId: null }), notice(94, { title: "Encrypted card" }), notice(95, { title: "  " })));
    expect(found).toHaveLength(12);
    expect(found[0]!.title).toBe("Notice 15");
  });

  it("leaves out what Now already shows and keeps a real first line", () => {
    const a = notice(1);
    const found = noticesFrom(items(a, notice(2, { summary: "Notice 2" }), notice(3, { summary: "Open Relo on your iPhone to read this." }), notice(4)),
      new Set([a.notificationId]));
    expect(found.map((n) => [n.title, n.summary])).toEqual([["Notice 2", null], ["Notice 3", null], ["Notice 4", "First line"]]);
  });

  it("leaves out a work's outcome when Now shows its card, and keeps it when the card is gone", () => {
    const outcome = notice(1, { outcomeOf: "act_card" });
    expect(noticesFrom(items(outcome, notice(2)), new Set(["act_card"])).map((n) => n.title)).toEqual(["Notice 2"]);
    expect(noticesFrom(items(outcome), new Set(["act_other"])).map((n) => n.title)).toEqual(["Notice 1"]);
  });
});

describe("freshNotices", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 14, 10, 0, 0) - s * 1000).toISOString();
  const server = new Date(Date.UTC(2026, 9, 14, 10, 0, 0)).toISOString();

  it("announces only unseen notices under 120 s old, once, and not ones read elsewhere", () => {
    const seen = new SeenNotices();
    const list = noticesFrom(items(notice(1, { createdAt: at(10) }), notice(2, { createdAt: at(500) }), notice(3, { createdAt: at(5), readAt: server })));
    expect(freshNotices(list, seen, server).map((n) => n.title)).toEqual(["Notice 1"]);
    expect(freshNotices(list, seen, server)).toEqual([]);
    expect(seen.toArray()).toHaveLength(3);
  });

  it("remembers 200 ids, forgetting the oldest", () => {
    const seen = new SeenNotices();
    for (let i = 0; i < 205; i++) seen.mark(`n${i}`);
    expect(seen.toArray()).toHaveLength(200);
    expect(seen.has("n0")).toBe(false);
    expect(seen.has("n204")).toBe(true);
    expect(new SeenNotices(seen.toArray()).has("n5")).toBe(true);
  });

  it("shows notices only when the device list is known and has no phone", () => {
    expect([showsNotices(null), showsNotices(true), showsNotices(false)]).toEqual([false, false, true]);
  });
});
