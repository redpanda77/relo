import { describe,expect,test } from "vitest";
import type { NowSummary } from "@relo/notification-contracts";
import { islandCounts } from "./now-summary.js";

const item = (id: string) => ({ id }) as NowSummary["running"][number];
const session = (phase: string | null,workId: string | null) => ({ phase,workId }) as NowSummary["sessions"]["sessions"][number];

const summary = (parts: Partial<Record<"needsYou" | "waitingOnYou" | "running" | "quiet" | "recent",string[]>>,
  sessions: NowSummary["sessions"]["sessions"] = [],needsYouCount = 0): NowSummary => ({
  needsYou: (parts.needsYou ?? []).map(item),
  waitingOnYou: (parts.waitingOnYou ?? []).map(item),
  running: (parts.running ?? []).map(item),
  quiet: (parts.quiet ?? []).map(item),
  recent: (parts.recent ?? []).map(item),
  lockScreen: { cards: [],needsYouCount,focus: null },
  sessions: { sessions,folds: { idle: 0 } },
}) as unknown as NowSummary;

describe("island counts, as the Mac notch's satellites", () => {
  test("each work that needs the owner, waits on them or runs counts once; quiet and finished work do not", () => {
    expect(islandCounts(summary({ needsYou: ["a"],waitingOnYou: ["b"],running: ["c","a"],quiet: ["d"],recent: ["e"] })))
      .toEqual({ live: 3,needsYouCount: 0 });
  });

  test("a working session no card shows yet adds one; a session with a card or not working adds none", () => {
    const sessions = [session("working",null),session("working","act_1"),session("waiting",null),session(null,null)];
    expect(islandCounts(summary({ running: ["act_1"] },sessions,2))).toEqual({ live: 2,needsYouCount: 2 });
  });

  test("nothing live counts zero", () => {
    expect(islandCounts(summary({}))).toEqual({ live: 0,needsYouCount: 0 });
  });
});
