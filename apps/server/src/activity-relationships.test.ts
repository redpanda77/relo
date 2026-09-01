import { readFile } from "node:fs/promises";
import { describe,expect,test } from "vitest";
import {
  activityRelationshipInternals,
  recordActivityCorrelationDecision,
  recordActivityStartEvidence,
} from "./activity-relationships.js";

describe("activity relationship evidence",() => {
  test("migration freezes append-only, same-principal, exact-backfill semantics",async () => {
    const sql = await readFile(new URL("../migrations/0035_activity_relationships_and_correlation.sql",import.meta.url),"utf8");
    expect(sql).toContain("CREATE TABLE activity_relationships");
    expect(sql).toContain("CREATE TABLE activity_correlation_decisions");
    expect(sql).toContain("activity relationship principal mismatch");
    expect(sql).toContain("activity relationship evidence is append-only");
    expect(sql).toContain("WHERE activity.origin_hash IS NOT NULL");
    expect(sql).toContain("'same_origin_generation','historical_exact'");
    expect(sql).toContain("REVOKE UPDATE,DELETE,TRUNCATE");
  });

  test("records continuation, supersession, companion, and one selected decision",async () => {
    const calls: Array<{ text:string; values?:unknown[] }> = [];
    let relationship = 0;
    const query = async (text:string,values?:unknown[]) => {
      calls.push({ text,values });
      if (text.includes("INSERT INTO activity_relationships")) {
        relationship += 1;
        return { rows:[{ id:`relationship-${relationship}` }],rowCount:1 };
      }
      return { rows:[],rowCount:0 };
    };
    await recordActivityStartEvidence({ query },{
      principalId:"principal",
      activityId:"successor",
      actor:"cli",
      previousActivityId:"previous",
      supersededActivityIds:["blocker","blocker"],
      parentActivityId:"parent",
      matchedBy:"origin",
      reason:"same_origin_generation",
    });
    const relationshipCalls = calls.filter((call) => call.text.includes("INSERT INTO activity_relationships"));
    expect(relationshipCalls).toHaveLength(3);
    expect(relationshipCalls.map((call) => call.values?.[3])).toEqual([
      "continuation","supersession","companion",
    ]);
    const decision = calls.find((call) => call.text.includes("INSERT INTO activity_correlation_decisions"));
    expect(decision?.values).toEqual([
      "principal","successor","relationship-1","resumed","origin","cli","same_origin_generation",
    ]);
  });

  test("records ambiguity without a selected activity",async () => {
    const calls: unknown[][] = [];
    await recordActivityCorrelationDecision({
      query: async (_text,values) => { calls.push(values ?? []); return { rows:[],rowCount:0 }; },
    },{
      principalId:"principal",
      outcome:"blocked_ambiguous",
      matchedBy:"current",
      actor:"cli",
      reason:"multiple_current_candidates",
    });
    expect(calls).toEqual([[
      "principal",null,null,"blocked_ambiguous","current","cli","multiple_current_candidates",
    ]]);
  });

  test("rejects caller-like free text before persistence",async () => {
    expect(() => activityRelationshipInternals.assertReason("unsafe reason with spaces")).toThrow(
      "bounded server-owned code",
    );
  });
});
