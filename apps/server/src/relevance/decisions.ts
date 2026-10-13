import type { PoolClient } from "pg";
import { evaluateRelevance,relevanceItemSchema,subjectVersionSchema,type SubjectVersion } from "@relo/notification-contracts";

/** Call only after locking the owned interaction request. Do not lock the head:
 * replacement must take the same request lock before it can advance that head. */
export async function readDecisionRelevance(
  tx: PoolClient, principalId: string, eventId: string, expected?: SubjectVersion,
) {
  const row = (await tx.query<{ relevance: unknown; current_relevance: unknown; server_now: Date }>(
    `SELECT nr.relevance,subject.current_relevance,clock_timestamp() AS server_now
     FROM notification_relevance nr JOIN relevance_subjects subject ON subject.id=nr.subject_id
     JOIN notification_events e ON e.id=nr.notification_event_id AND e.principal_id=subject.principal_id
     WHERE e.id=$1 AND e.principal_id=$2`,[eventId,principalId],
  )).rows[0];
  if (!row) return { matchesExpected: expected === undefined,evaluation: null };
  const item = relevanceItemSchema.parse(row.relevance);
  const current = relevanceItemSchema.parse(row.current_relevance).identity;
  return {
    matchesExpected: expected === undefined || JSON.stringify(item.identity) === JSON.stringify(subjectVersionSchema.parse(expected)),
    evaluation: evaluateRelevance(item,row.server_now.toISOString(),true,current),
  };
}
