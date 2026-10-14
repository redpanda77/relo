import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import {
  recordActivityCorrelationDecision,
  recordActivityStartEvidence,
} from "./activity-relationships.js";
import { currentTestPresentationRecord } from "./test-current-presentation.js";
import { deleteFixtureOwner } from "./test-support/delete-fixture-owner.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("activity relationship evidence persistence", () => {
  let db: Database;
  let principalId: string;
  let otherPrincipalId: string;
  let predecessorId: string;
  let successorId: string;
  let companionId: string;

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
  });

  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");
    await bootstrapOwner(db, "relationship-owner", "relationship_owner_token_abcdefghijklmnopqrstuvwxyz");
    await bootstrapOwner(db, "relationship-other", "relationship_other_token_abcdefghijklmnopqrstuvwxyz");
    const principals = await db.query<{ id: string; handle: string }>(
      "SELECT id,handle FROM owner_principals ORDER BY handle",
    );
    principalId = principals.rows.find((row) => row.handle === "relationship-owner")!.id;
    otherPrincipalId = principals.rows.find((row) => row.handle === "relationship-other")!.id;
    const originHash = `org_${"a".repeat(43)}`;
    const presentation = currentTestPresentationRecord();
    const activities = await db.query<{ id: string; activity_key: string }>(
      `INSERT INTO live_activities(
         producer_type,principal_id,activity_key,title,status,state,start_idempotency_key,origin_hash,generation,ended_at,
         presentation,presentation_sha256,presentation_policy,presentation_policy_source,
         presentation_preset_id,presentation_preset_revision
       ) VALUES
         ('script',$1,'relationship-predecessor','Predecessor','Done','ended','relationship-start-1',$2,1,now(),$3::jsonb,$4,$5::jsonb,$6,$7,$8),
         ('script',$1,'relationship-successor','Successor','Running','active','relationship-start-2',$2,2,NULL,$3::jsonb,$4,$5::jsonb,$6,$7,$8),
         ('script',$1,'relationship-companion','Companion','Waiting','active','relationship-start-3',NULL,1,NULL,$3::jsonb,$4,$5::jsonb,$6,$7,$8)
       RETURNING id,activity_key`,
      [principalId,originHash,presentation.presentation,presentation.presentationHash,
        presentation.presentationPolicy,presentation.presentationPolicySource,
        presentation.presentationPresetId,presentation.presentationPresetRevision],
    );
    predecessorId = activities.rows.find((row) => row.activity_key === "relationship-predecessor")!.id;
    successorId = activities.rows.find((row) => row.activity_key === "relationship-successor")!.id;
    companionId = activities.rows.find((row) => row.activity_key === "relationship-companion")!.id;
  });

  afterAll(async () => db.end());

  test("persists exact continuation and companion edges with categorical decisions", async () => {
    await recordActivityStartEvidence(db, {
      principalId,
      activityId: successorId,
      previousActivityId: predecessorId,
      actor: "cli",
      matchedBy: "origin",
      reason: "same_origin_generation",
    });
    await recordActivityStartEvidence(db, {
      principalId,
      activityId: companionId,
      parentActivityId: successorId,
      actor: "dashboard",
      matchedBy: "parent",
      reason: "interactive_companion",
    });
    await recordActivityCorrelationDecision(db, {
      principalId,
      outcome: "blocked_ambiguous",
      matchedBy: "current",
      actor: "cli",
      reason: "multiple_current_candidates",
    });

    expect((await db.query(
      `SELECT kind,actor,reason,provenance FROM activity_relationships
       WHERE principal_id=$1 ORDER BY kind`,
      [principalId],
    )).rows).toEqual([
      { kind: "companion", actor: "dashboard", reason: "interactive_companion", provenance: "runtime" },
      { kind: "continuation", actor: "cli", reason: "same_origin_generation", provenance: "runtime" },
    ]);
    expect((await db.query(
      `SELECT outcome,matched_by,activity_id IS NULL AS unbound
       FROM activity_correlation_decisions WHERE principal_id=$1 ORDER BY created_at,id`,
      [principalId],
    )).rows).toEqual([
      { outcome: "resumed", matched_by: "origin", unbound: false },
      { outcome: "created", matched_by: "parent", unbound: false },
      { outcome: "blocked_ambiguous", matched_by: "current", unbound: true },
    ]);
  });

  test("deduplicates relationship edges while retaining each decision attempt", async () => {
    const input = {
      principalId,
      activityId: successorId,
      previousActivityId: predecessorId,
      actor: "cli" as const,
      matchedBy: "origin" as const,
      reason: "same_origin_generation",
    };
    await recordActivityStartEvidence(db, input);
    await recordActivityStartEvidence(db, input);
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM activity_relationships WHERE principal_id=$1",
      [principalId],
    )).rows[0]!.count).toBe(1);
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM activity_correlation_decisions WHERE principal_id=$1",
      [principalId],
    )).rows[0]!.count).toBe(2);
  });

  test("rejects cross-principal edges and all evidence mutation", async () => {
    const presentation = currentTestPresentationRecord("Other","Running");
    const other = await db.query<{ id: string }>(
      `INSERT INTO live_activities(
         producer_type,principal_id,activity_key,title,status,state,start_idempotency_key,generation,
         presentation,presentation_sha256,presentation_policy,presentation_policy_source,
         presentation_preset_id,presentation_preset_revision
       ) VALUES ('script',$1,'relationship-other','Other','Running','active','relationship-other-start',1,
         $2::jsonb,$3,$4::jsonb,$5,$6,$7)
       RETURNING id`,
      [otherPrincipalId,presentation.presentation,presentation.presentationHash,
        presentation.presentationPolicy,presentation.presentationPolicySource,
        presentation.presentationPresetId,presentation.presentationPresetRevision],
    );
    await expect(recordActivityStartEvidence(db, {
      principalId,
      activityId: other.rows[0]!.id,
      previousActivityId: predecessorId,
      actor: "server",
      matchedBy: "explicit_id",
      reason: "cross_principal_probe",
    })).rejects.toThrow(/principal mismatch/u);

    await recordActivityStartEvidence(db, {
      principalId,
      activityId: successorId,
      previousActivityId: predecessorId,
      actor: "cli",
      matchedBy: "origin",
      reason: "same_origin_generation",
    });
    await expect(db.query(
      "UPDATE activity_relationships SET reason='changed' WHERE principal_id=$1",
      [principalId],
    )).rejects.toThrow(/append-only/u);
    await expect(db.query(
      "DELETE FROM activity_correlation_decisions WHERE principal_id=$1",
      [principalId],
    )).rejects.toThrow(/append-only/u);
  });

  test("permits account-level cascade deletion without weakening append-only evidence", async () => {
    await recordActivityStartEvidence(db, {
      principalId,
      activityId: successorId,
      previousActivityId: predecessorId,
      actor: "cli",
      matchedBy: "origin",
      reason: "same_origin_generation",
    });

    await deleteFixtureOwner(db,principalId);

    const remaining = await db.query<{ relationships: number; decisions: number }>(
      `SELECT
         (SELECT count(*)::int FROM activity_relationships WHERE principal_id=$1) AS relationships,
         (SELECT count(*)::int FROM activity_correlation_decisions WHERE principal_id=$1) AS decisions`,
      [principalId],
    );
    expect(remaining.rows[0]).toEqual({ relationships: 0,decisions: 0 });
  });
});
