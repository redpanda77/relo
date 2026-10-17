import { randomUUID } from "node:crypto";
import { readdirSync,readFileSync,statSync } from "node:fs";
import { join } from "node:path";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createDatabase,type Database } from "../db.js";
import { publicId } from "../ids.js";
import { migrate } from "../migrate.js";
import { settleQuestionCopies } from "./settle-copies.js";

// Plan 10 C1.4: one function settles a question's other copies, whichever path found them. The three
// paths differ only in how they find the copies and whose deadline counts; the end state is the same.
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

type Fixture = { winner: { requestId: string; eventId: string }; others: Array<{ requestId: string; eventId: string; jobId: string }> };

suite("settling the copies of one question",() => {
  let db: Database,principalId: string,deviceId: string;
  beforeAll(async () => { db = createDatabase(databaseUrl!);await migrate(db); });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");
    principalId = (await db.query("INSERT INTO owner_principals(handle) VALUES ($1) RETURNING id",[randomUUID()])).rows[0].id;
    deviceId = (await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,
      bundle_identifier,app_version,app_build,os_version,apns_environment,notification_authorization)
      VALUES ($1,$2,$3,'Settle test','com.example.relo.notifications','1','1','26','sandbox','authorized') RETURNING id`,
    [principalId,randomUUID(),randomUUID()])).rows[0].id;
  });

  async function copy(link: { activityId?: string; groupId?: string },deadlineSeconds: number) {
    const payload = link.activityId ? { liveActivity: { activityId: publicId("act",link.activityId) } } : {};
    const eventId = (await db.query(`INSERT INTO notification_events(principal_id,source,kind,title,body,idempotency_key,payload,expires_at)
      VALUES ($1,'Settle','approval','Q','Q',$2,$3,clock_timestamp()+$4*interval '1 second') RETURNING id`,
    [principalId,randomUUID(),payload,deadlineSeconds])).rows[0].id;
    const requestId = (await db.query(`INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,
      expires_at,decision_group_id) VALUES ($1,$2,'approval','Q',$3,clock_timestamp()+$4*interval '1 second',$5) RETURNING id`,
    [principalId,eventId,randomUUID().replaceAll("-","").padEnd(64,"0"),deadlineSeconds,link.groupId ?? null])).rows[0].id;
    const subject = (await db.query(`INSERT INTO relevance_subjects(principal_id,source_id,subject_key,generation,revision,intent_sha256,
      current_event_id,current_relevance) VALUES ($1,'s',$2,1,1,$3,$4,'{}') RETURNING id`,
    [principalId,randomUUID(),"a".repeat(64),eventId])).rows[0].id;
    await db.query(`INSERT INTO notification_relevance(notification_event_id,subject_id,generation,revision,relevance,deliver_until)
      VALUES ($1,$2,1,1,'{"status":"open"}',now()+interval '1 hour')`,[eventId,subject]);
    const jobId = (await db.query(`INSERT INTO delivery_jobs(notification_event_id,device_id,state,apns_payload_sha256)
      VALUES ($1,$2,'pending',$3) RETURNING id`,[eventId,deviceId,"b".repeat(64)])).rows[0].id;
    return { requestId,eventId,jobId };
  }

  /** The winner has already settled; two other copies are still pending, with their own deadlines. */
  async function fixture(link: { activityId?: string; groupId?: string },winnerExpired: boolean): Promise<Fixture> {
    const winner = await copy(link,winnerExpired ? -1 : 600);
    // Folded copies share one deadline; the independent ones keep their own, one of them still open.
    const others = [await copy(link,winnerExpired ? -1 : 600),await copy(link,winnerExpired ? -1 : 600)];
    return { winner,others };
  }

  const endState = async (fixtureRows: Fixture) => Promise.all(fixtureRows.others.map(async (other) => {
    const request = (await db.query("SELECT state,response,answered_on_request_id FROM interaction_requests WHERE id=$1",[other.requestId])).rows[0];
    return {
      request: request.state,response: request.response,answeredOn: request.answered_on_request_id === fixtureRows.winner.requestId ? "winner" : request.answered_on_request_id,
      event: (await db.query("SELECT state FROM notification_events WHERE id=$1",[other.eventId])).rows[0].state,
      relevance: (await db.query("SELECT relevance->>'status' AS s FROM notification_relevance WHERE notification_event_id=$1",[other.eventId])).rows[0].s,
      job: (await db.query("SELECT state,last_error_code FROM delivery_jobs WHERE id=$1",[other.jobId])).rows[0],
    };
  }));

  const paths = {
    // Folded questions on a work card: the copies share one deadline.
    folded: async (outcome: Parameters<typeof settleQuestionCopies>[1]["outcome"],winnerExpired: boolean) => {
      const activityId = randomUUID(),rows = await fixture({ activityId },winnerExpired);
      await settleQuestionCopies(db,{ scope: { activity: { principalId,activityId } },
        winner: { notificationEventId: rows.winner.eventId,principalId },outcome,deadline: "shared" });
      return rows;
    },
    // Legacy per-device Live Activity questions: each copy has its own deadline.
    legacy: async (outcome: Parameters<typeof settleQuestionCopies>[1]["outcome"],winnerExpired: boolean) => {
      const activityId = randomUUID(),rows = await fixture({ activityId },winnerExpired);
      await settleQuestionCopies(db,{ scope: { activity: { principalId,activityId } },
        winner: { notificationEventId: rows.winner.eventId,principalId },outcome,deadline: "own" });
      return rows;
    },
    // Decision groups: surfaces of one decision.
    group: async (outcome: Parameters<typeof settleQuestionCopies>[1]["outcome"],winnerExpired: boolean) => {
      const groupId = randomUUID(),rows = await fixture({ groupId },winnerExpired);
      await settleQuestionCopies(db,{ scope: { decisionGroupId: groupId },winner: { interactionId: rows.winner.requestId },outcome });
      return rows;
    },
  };

  const expectedFor = { approved: "responded",expired: "expired",canceled: "canceled" } as const;
  test.each(["approved","expired","canceled"] as const)("%s: every path leaves the other copies in the same end state",async (state) => {
    const ends: Record<string,unknown> = {};
    for (const [name,run] of Object.entries(paths)) {
      await db.query("TRUNCATE interaction_requests CASCADE");
      // The winner of an answer or cancel settled first; for expiry the whole question is past due.
      const rows = await run({ state,...(state === "approved" ? { response: { value: "yes" } } : {}) },state === "expired");
      ends[name] = await endState(rows);
    }
    const reference = ends.folded as Array<Record<string,unknown>>;
    expect(ends.legacy).toEqual(reference);
    expect(ends.group).toEqual(reference);
    expect(reference).toHaveLength(2);
    for (const entry of reference) {
      expect(entry).toMatchObject({ request: state,event: expectedFor[state],relevance: "settled",
        job: { state: "canceled",last_error_code: "interaction_settled" } });
    }
    if (state === "approved") expect(reference[0]).toMatchObject({ response: { value: "yes" },answeredOn: "winner" });
    else expect(reference[0]).toMatchObject({ answeredOn: null });
  });

  test("independent copies expire only past their own deadline; shared copies expire together",async () => {
    const activityId = randomUUID();
    const winner = await copy({ activityId },-1),late = await copy({ activityId },600);
    const run = (deadline: "own" | "shared") => settleQuestionCopies(db,{ scope: { activity: { principalId,activityId } },
      winner: { notificationEventId: winner.eventId,principalId },outcome: { state: "expired" },deadline });
    expect(await run("own")).toHaveLength(0);
    expect((await db.query("SELECT state FROM interaction_requests WHERE id=$1",[late.requestId])).rows[0].state).toBe("pending");
    expect(await run("shared")).toHaveLength(1);
    expect((await db.query("SELECT state FROM interaction_requests WHERE id=$1",[late.requestId])).rows[0].state).toBe("expired");
  });
});

describe("sibling copies are settled in one module",() => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir,name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
  test("no other module runs the sibling-settling SQL",() => {
    const root = join(import.meta.dirname,"..");
    const patterns = [/answered_on_request_id\s*=/u,/UPDATE interaction_requests r SET state/u,
      /UPDATE interaction_requests r SET state='canceled'/u,/last_error_code='interaction_settled'/u];
    const offenders = walk(root).filter((file) => !file.endsWith("settle-copies.ts"))
      .filter((file) => patterns.some((pattern) => pattern.test(readFileSync(file,"utf8"))));
    expect(offenders).toEqual([]);
  });
});
