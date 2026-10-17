import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import type { ObservedSessionPhase } from "@relo/notification-contracts";
import { falseNeedsYouPerWeek,timeToClearEndedSessions } from "./agent-session-metrics.js";
import { recordObservedSnapshot } from "./agent-sessions.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Session transition metrics",() => {
  let db: Database,principalId: string;
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE"); await bootstrapOwner(db,"owner","agent_metrics_owner_abcdefghijklmnopqrstuvwxyz");
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  });
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  /** A session's life as [phase, minutes ago it began] steps, oldest first. */
  async function life(steps: [ObservedSessionPhase,number][],endReason?: "hook" | "gone") {
    const session = randomUUID().replaceAll("-","");
    let seq = 0;
    for (const [phase,ago] of steps) {
      await recordObservedSnapshot(db,principalId,{ session,harness: "claude-code",phase,phaseSince: minutesAgo(ago),
        lastSeenAt: minutesAgo(ago),openToolSince: null,seq: ++seq,...(phase === "ended" && endReason ? { endReason } : {}) });
    }
    return session;
  }

  test("a wait that ends with the session, with no work between, for over 2 minutes is a false Needs you",async () => {
    await life([["working",30],["waiting",20],["ended",10]],"gone");      // 10 min: counts
    await life([["working",30],["waiting",20],["ended",19]],"hook");      // 1 min: a quick quit, not counted
    await life([["working",30],["waiting",20],["working",18],["ended",5]]); // answered, then ended: not counted
    await life([["working",30],["stopped",20],["ended",10]]);              // never waited: not counted
    expect(await falseNeedsYouPerWeek(db)).toBe(1);
  });

  test("the time to clear counts from the last sign of life, not from the start of the last phase",async () => {
    const session = randomUUID().replaceAll("-","");
    const base = { session,harness: "claude-code" as const,openToolSince: null };
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    await recordObservedSnapshot(db,principalId,{ ...base,phase: "working",phaseSince: at(130),lastSeenAt: at(130),seq: 1 });
    await recordObservedSnapshot(db,principalId,{ ...base,phase: "working",phaseSince: at(130),lastSeenAt: at(10),seq: 2 });
    await recordObservedSnapshot(db,principalId,{ ...base,phase: "ended",phaseSince: new Date(Date.now() - 9.5 * 60_000).toISOString(),
      lastSeenAt: at(9.5),seq: 3,endReason: "gone" });
    const rows = await timeToClearEndedSessions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].seconds).toBe(30);
  });

  test("the time to clear is the gap between the last sign of life and the end",async () => {
    const gone = await life([["working",60],["stopped",50],["ended",10]],"gone");
    const hook = await life([["working",5],["ended",4]],"hook");
    await life([["working",5]]);
    const rows = await timeToClearEndedSessions(db);
    const bySession = new Map((await db.query("SELECT id,session_hash FROM agent_sessions")).rows.map((r) => [r.session_hash,r.id]));
    expect(rows).toHaveLength(2);
    const find = (hash: string) => rows.find((r) => r.sessionId === bySession.get(hash))!;
    expect(find(gone)).toMatchObject({ endReason: "gone",seconds: 2400 });
    expect(find(hook)).toMatchObject({ endReason: "hook",seconds: 60 });
  });
});
