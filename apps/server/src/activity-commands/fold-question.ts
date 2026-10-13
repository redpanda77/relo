import { canonicalPresentation,persistedPresentationColumns } from "../presentation-runtime.js";
import { publicId } from "../ids.js";
import { createActivityCommands } from "./runtime.js";
import type { ActivityDeliverySummary,ApnsMode } from "./schemas.js";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<any> };

export type FoldQuestionInput = {
  type: "approval" | "yes_no"; prompt: string; expiresInSeconds: number;
  primaryLabel?: string | undefined; secondaryLabel?: string | undefined;
};

export type FoldQuestionResult =
  | { kind: "folded"; activity: any; delivery: ActivityDeliverySummary; interactionRequestId: string }
  | { kind: "question_pending" | "private_activity_question" | "activity_target_unavailable" };

/**
 * A question asked on a card folds into that card: the card switches to "Needs you" with the
 * answer buttons and an alert, and returns to the work once settled. There is never a second
 * card for the question. The caller holds the card row lock and rolls back unless folded.
 */
export async function foldQuestionIntoCard(client: Queryable, input: {
  principalId: string; row: any; question: FoldQuestionInput; apnsMode: ApnsMode; fallbackSourceName: string;
}): Promise<FoldQuestionResult> {
  const { row,question: asked } = input;
  if (!(row.target_device_ids as string[] | null)?.length) return { kind: "activity_target_unavailable" };
  const working = canonicalPresentation(row.presentation);
  if (row.resume_presentation || working.behavior.type === "approval" || working.behavior.type === "yes_no") {
    return { kind: "question_pending" };
  }
  if (working.privacy === "private") return { kind: "private_activity_question" };
  const primaryLabel = asked.primaryLabel ?? (asked.type === "approval" ? "Approve" : "Yes");
  const secondaryLabel = asked.secondaryLabel ?? (asked.type === "approval" ? "Deny" : "No");
  const question = persistedPresentationColumns({
    ...working,
    content: { ...working.content,subtitle: asked.prompt,status: "Needs you" },
    state: { kind: "needs_action",tone: "attention",icon: "needs_action" },
    behavior: asked.type === "approval"
      ? { type: "approval",primary: { action: "approve",label: primaryLabel },
          secondary: { action: "deny",label: secondaryLabel } }
      : { type: "yes_no",primary: { action: "yes",label: primaryLabel },
          secondary: { action: "no",label: secondaryLabel } },
  });
  const updated = (await client.query(
    `UPDATE live_activities SET title=$3,status=$4,detail=$5,progress=$6,symbol=$7,style=$8,
       privacy=$9,accent_color=$10,presentation=$11,presentation_sha256=$12,
       resume_presentation=$13::jsonb,question_fallback_at=NULL,
       stale_at=LEAST(expires_at,statement_timestamp()+($14::integer*interval '1 second')),
       sequence=sequence+1,updated_at=statement_timestamp()
     WHERE id=$1 AND principal_id=$2 AND state='active' RETURNING *`,
    [row.id,input.principalId,question.title,question.status,question.detail,question.progress,
      question.symbol,question.style,question.privacy,question.accentColor,question.presentation,
      question.presentationHash,working,asked.expiresInSeconds],
  )).rows[0];
  const source = await client.query(
    `SELECT source FROM notification_events
     WHERE principal_id=$1 AND payload#>>'{liveActivity,activityId}'=$2 ORDER BY created_at,id LIMIT 1`,
    [input.principalId,publicId("act",row.id)],
  );
  const delivery = await createActivityCommands(client as any,{
    principalId: input.principalId,sourceName: source.rows[0]?.source ?? input.fallbackSourceName,
    activity: updated,operation: "update",apnsMode: input.apnsMode,
    priority: 10,decisionSeconds: asked.expiresInSeconds,alert: true,
  });
  const request = await client.query(
    `SELECT r.id FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id
     WHERE e.principal_id=$1 AND e.idempotency_key LIKE $2 ORDER BY r.created_at,r.id LIMIT 1`,
    [input.principalId,`activity:${row.id}:${updated.sequence}:update:%`],
  );
  if (!request.rowCount) return { kind: "activity_target_unavailable" };
  return { kind: "folded",activity: updated,delivery,interactionRequestId: request.rows[0].id };
}
