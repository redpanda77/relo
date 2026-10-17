import { nowSummarySchema } from "@relo/notification-contracts";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { recordObservedSnapshot } from "../agent-sessions.js";
import { loadNowSummary } from "../api/now-routes.js";
import { createApp } from "../app.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { caller,resetOwner,SECRET,startWork } from "../works/works-fixture.js";

/** ADR 0011: the phone reads the computer's icon on Now items and session rows, joined in one pass, never per row. */
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("computer icon on Now and session rows",() => {
  let db: Database,principalId: string,app: ReturnType<typeof createApp>,call: ReturnType<typeof caller>;
  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: SECRET }); call = caller(app);
  });
  afterAll(async () => db.end());
  beforeEach(async () => { ({ principalId } = await resetOwner(db)); });

  const observe = async (session: string) => {
    const at = new Date().toISOString();
    await recordObservedSnapshot(db,principalId,{ session,harness: "claude-code",phase: "working",phaseSince: at,lastSeenAt: at,
      openToolSince: null,seq: 1 } as any);
  };

  test("an item and its session row carry the computer's effective icon: default, detected, then the owner's choice",async () => {
    const work = await startWork(call);
    const key = (await db.query("SELECT session_key FROM works WHERE id=$1",[work.id.replace(/^wrk_/,"")])).rows[0].session_key as string;
    await observe(key);
    const read = async () => {
      const summary = await loadNowSummary(db,principalId,undefined,undefined);
      nowSummarySchema.parse(summary);
      return { item: [...summary.running,...summary.waitingOnYou,...summary.quiet,...summary.needsYou,...summary.paused][0],
        row: summary.sessions.sessions[0] };
    };
    let seen = await read();
    expect(seen.item?.computerIcon).toBe("laptop");
    expect(seen.row?.computerIcon).toBe("laptop");
    await db.query(`UPDATE computers SET report=jsonb_build_object('machineKind','cloud')`);
    seen = await read();
    expect(seen.item?.computerIcon).toBe("cloud");
    expect(seen.row?.computerIcon).toBe("cloud");
    await db.query(`UPDATE computers SET icon='build'`);
    seen = await read();
    expect(seen.item?.computerIcon).toBe("build");
    expect(seen.row?.computerIcon).toBe("build");
  });

  test("a session with no work and a work whose login has no computer get no icon",async () => {
    await observe("a-session-nobody-works-on");
    let summary = await loadNowSummary(db,principalId,undefined,undefined);
    expect(summary.sessions.sessions).toHaveLength(1);
    expect(summary.sessions.sessions[0]).not.toHaveProperty("computerIcon");
    await startWork(call);
    await db.query("DELETE FROM computers");
    summary = await loadNowSummary(db,principalId,undefined,undefined);
    for (const item of [...summary.running,...summary.waitingOnYou,...summary.quiet,...summary.needsYou,...summary.paused]) {
      expect(item).not.toHaveProperty("computerIcon");
    }
    for (const row of summary.sessions.sessions) expect(row).not.toHaveProperty("computerIcon");
  });
});
