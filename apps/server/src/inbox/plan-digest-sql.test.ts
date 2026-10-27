import { afterAll,beforeAll,describe,expect,test } from "vitest";
import { createDatabase,type Database } from "../db.js";
import { planRoundKeptSql,planStepKeptSql } from "./plan-digest-sql.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("The plan digest SQL keeps a card event small",() => {
  let db: Database;
  beforeAll(() => { db=createDatabase(process.env.TEST_DATABASE_URL!); });
  afterAll(async () => { await db.end(); });
  const plan = (count: number) => ({
    rounds: Array.from({ length: count },(_,i) => ({ n: i + 1 })),
    steps: [{ id: "s0" },...Array.from({ length: count },(_,i) => ({ id: `r${i + 1}`,round: i + 1 }))] });

  test("steps of the newest 3 rounds (and roundless ones) and the newest 60 rounds",async () => {
    const { rows } = await db.query(`SELECT
      (SELECT array_agg(s.step->>'id' ORDER BY s.position) FROM jsonb_array_elements(work.plan->'steps') WITH ORDINALITY s(step,position)
        WHERE ${planStepKeptSql("s.step")}) AS steps,
      (SELECT array_agg((r.round->>'n')::int ORDER BY r.position) FROM jsonb_array_elements(work.plan->'rounds') WITH ORDINALITY r(round,position)
        WHERE ${planRoundKeptSql("r.position")}) AS rounds
      FROM (SELECT $1::jsonb AS plan) work`,[JSON.stringify(plan(70))]);
    expect(rows[0].steps).toEqual(["s0","r68","r69","r70"]);
    expect(rows[0].rounds).toHaveLength(60);
    expect(rows[0].rounds[0]).toBe(11);
    expect(rows[0].rounds[59]).toBe(70);
  });
});
