type Queryable = {
  query: <T = any>(text: string, values?: unknown[]) => Promise<any>;
};

export type ActivityRelationshipKind = "continuation" | "supersession" | "companion";
export type ActivityCorrelationOutcome =
  | "created"
  | "reused"
  | "resumed"
  | "blocked_ambiguous"
  | "blocked_conflict";
export type ActivityCorrelationMatch =
  | "origin"
  | "lifecycle"
  | "activity_key"
  | "explicit_id"
  | "current"
  | "replacement"
  | "parent"
  | "none"
  | "legacy_exact";
export type ActivityEvidenceActor =
  | "cli"
  | "service"
  | "dashboard"
  | "reconciler"
  | "server"
  | "migration";

function assertReason(reason: string): void {
  if (!/^[a-z0-9_]{1,64}$/u.test(reason)) {
    throw new Error("activity evidence reason must be a bounded server-owned code");
  }
}

async function insertRelationship(
  query: Queryable,
  input: {
    principalId: string;
    predecessorActivityId: string;
    successorActivityId: string;
    kind: ActivityRelationshipKind;
    actor: ActivityEvidenceActor;
    reason: string;
  },
): Promise<string | null> {
  if (input.predecessorActivityId === input.successorActivityId) return null;
  assertReason(input.reason);
  const inserted = await query.query<{ id: string }>(
    `INSERT INTO activity_relationships(
       principal_id,predecessor_activity_id,successor_activity_id,kind,actor,reason,provenance
     ) VALUES ($1,$2,$3,$4,$5,$6,'runtime')
     ON CONFLICT (principal_id,predecessor_activity_id,successor_activity_id,kind)
     DO NOTHING RETURNING id`,
    [input.principalId,input.predecessorActivityId,input.successorActivityId,
      input.kind,input.actor,input.reason],
  );
  if (inserted.rows[0]?.id) return inserted.rows[0].id;
  const existing = await query.query<{ id: string }>(
    `SELECT id FROM activity_relationships
     WHERE principal_id=$1 AND predecessor_activity_id=$2
       AND successor_activity_id=$3 AND kind=$4`,
    [input.principalId,input.predecessorActivityId,input.successorActivityId,input.kind],
  );
  return existing.rows[0]?.id ?? null;
}

export async function recordActivityCorrelationDecision(
  query: Queryable,
  input: {
    principalId: string;
    activityId?: string | null;
    relationshipId?: string | null;
    outcome: ActivityCorrelationOutcome;
    matchedBy: ActivityCorrelationMatch;
    actor: ActivityEvidenceActor;
    reason: string;
  },
): Promise<void> {
  assertReason(input.reason);
  await query.query(
    `INSERT INTO activity_correlation_decisions(
       principal_id,activity_id,relationship_id,outcome,matched_by,actor,reason,provenance
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'runtime')`,
    [input.principalId,input.activityId ?? null,input.relationshipId ?? null,input.outcome,
      input.matchedBy,input.actor,input.reason],
  );
}

export async function recordActivityStartEvidence(
  query: Queryable,
  input: {
    principalId: string;
    activityId: string;
    actor: ActivityEvidenceActor;
    previousActivityId?: string | null;
    supersededActivityIds?: string[];
    parentActivityId?: string | null;
    matchedBy: ActivityCorrelationMatch;
    reason: string;
  },
): Promise<void> {
  let primaryRelationshipId: string | null = null;
  if (input.previousActivityId) {
    primaryRelationshipId = await insertRelationship(query,{
      principalId: input.principalId,
      predecessorActivityId: input.previousActivityId,
      successorActivityId: input.activityId,
      kind: "continuation",
      actor: input.actor,
      reason: "same_origin_generation",
    });
  }
  for (const predecessorActivityId of [...new Set(input.supersededActivityIds ?? [])]) {
    const relationshipId = await insertRelationship(query,{
      principalId: input.principalId,
      predecessorActivityId,
      successorActivityId: input.activityId,
      kind: "supersession",
      actor: input.actor,
      reason: "explicit_replacement",
    });
    primaryRelationshipId ??= relationshipId;
  }
  if (input.parentActivityId) {
    const relationshipId = await insertRelationship(query,{
      principalId: input.principalId,
      predecessorActivityId: input.parentActivityId,
      successorActivityId: input.activityId,
      kind: "companion",
      actor: input.actor,
      reason: "interactive_companion",
    });
    primaryRelationshipId ??= relationshipId;
  }
  await recordActivityCorrelationDecision(query,{
    principalId: input.principalId,
    activityId: input.activityId,
    relationshipId: primaryRelationshipId,
    outcome: input.previousActivityId ? "resumed" : "created",
    matchedBy: input.matchedBy,
    actor: input.actor,
    reason: input.reason,
  });
}

export const activityRelationshipInternals = { assertReason };
