import type { SealedNotice } from "../sealed-content.js";
import { canonicalPresentation,persistedPresentationColumns } from "../presentation-runtime.js";
import type { ChoiceOption } from "@relo/notification-contracts";
import { assertChoiceTargets,ChoiceUnsupportedError,isQuestionBehavior,questionBehavior } from "../choice-questions.js";
import { publicId } from "../ids.js";
import { overviewReaderIds } from "../owner-overview.js";
import { prepareNotificationContent,type NotificationContentCipher } from "../notification-content.js";
import { createActivityCommands } from "./runtime.js";
import type { ActivityDeliverySummary,ApnsMode } from "./schemas.js";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<any> };

export type FoldQuestionInput = {
  type: "approval" | "yes_no" | "choice"; prompt: string; detail?: string | undefined; expiresInSeconds: number;
  options?: ChoiceOption[] | undefined;
  primaryLabel?: string | undefined; secondaryLabel?: string | undefined;
  /** End-to-end sealed title and prompt for the question's events (E4.1). */
  sealed?: SealedNotice | null | undefined;
};

export type FoldQuestionResult =
  | { kind: "folded"; activity: any; delivery: ActivityDeliverySummary; interactionRequestId: string }
  | { kind: "question_pending" | "private_activity_question" | "activity_target_unavailable" | "content_encryption_unavailable" }
  | { kind: "choice_unsupported"; error: ChoiceUnsupportedError };

/**
 * A question asked on a card folds into that card: the card switches to "Needs you" with the
 * answer buttons and an alert, and returns to the work once settled. There is never a second
 * card for the question. The caller holds the card row lock and rolls back unless folded.
 */
export async function foldQuestionIntoCard(client: Queryable, input: {
  principalId: string; row: any; question: FoldQuestionInput; apnsMode: ApnsMode; fallbackSourceName: string;
  contentCipher?: NotificationContentCipher | null | undefined;
}): Promise<FoldQuestionResult> {
  const { row,question: asked } = input;
  // Someone must show the question: a phone the card targets, or an owner overview device (the Mac)
  // that lists and answers it from Now (owner-overview.ts).
  const phones = (row.target_device_ids as string[] | null) ?? [];
  const readers = phones.length ? [] : await overviewReaderIds(client,input.principalId,null);
  if (!phones.length && !readers.length) return { kind: "activity_target_unavailable" };
  const working = canonicalPresentation(row.presentation);
  if (row.resume_presentation || isQuestionBehavior(working.behavior.type)) {
    return { kind: "question_pending" };
  }
  if (working.privacy === "private") return { kind: "private_activity_question" };
  if (asked.detail && !input.contentCipher) return { kind: "content_encryption_unavailable" };
  if (asked.type === "choice") {
    try { await assertChoiceTargets(client,input.principalId,phones.length ? phones : readers); }
    catch (error) { if (error instanceof ChoiceUnsupportedError) return { kind: "choice_unsupported",error }; throw error; }
  }
  const question = persistedPresentationColumns({
    ...working,
    content: { ...working.content,subtitle: asked.prompt,status: "Needs you" },
    state: { kind: "needs_action",tone: "attention",icon: "needs_action" },
    behavior: questionBehavior(asked.type,{ primary: asked.primaryLabel,secondary: asked.secondaryLabel,options: asked.options }),
  });
  const updated = (await client.query(
    `UPDATE live_activities SET title=$3,status=$4,detail=$5,progress=$6,symbol=$7,style=$8,
       privacy=$9,accent_color=$10,presentation=$11,presentation_sha256=$12,
       resume_presentation=$13::jsonb,question_fallback_at=NULL,
       sequence=sequence+1,updated_at=statement_timestamp(),declared_at=statement_timestamp()
     WHERE id=$1 AND principal_id=$2 AND state='active' RETURNING *`,
    [row.id,input.principalId,question.title,question.status,question.detail,question.progress,
      question.symbol,question.style,question.privacy,question.accentColor,question.presentation,
      question.presentationHash,working],
  )).rows[0];
  const source = await client.query(
    `SELECT source FROM notification_events
     WHERE principal_id=$1 AND payload#>>'{liveActivity,activityId}'=$2 ORDER BY created_at,id LIMIT 1`,
    [input.principalId,publicId("act",row.id)],
  );
  const delivery = await createActivityCommands(client as any,{
    principalId: input.principalId,sourceName: source.rows[0]?.source ?? input.fallbackSourceName,
    activity: updated,operation: "update",apnsMode: input.apnsMode,
    priority: 10,decisionSeconds: asked.expiresInSeconds,alert: true,sealed: asked.sealed ?? undefined,
    decisionDetail: asked.detail && input.contentCipher ? {
      content: prepareNotificationContent({ body: asked.detail,summary: asked.prompt,bodyFormat: "markdown" }),
      cipher: input.contentCipher,
    } : undefined,
  });
  const request = await client.query(
    `SELECT r.id FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id
     WHERE e.principal_id=$1 AND e.idempotency_key LIKE $2 ORDER BY r.created_at,r.id LIMIT 1`,
    [input.principalId,`activity:${row.id}:${updated.sequence}:update:%`],
  );
  if (!request.rowCount) return { kind: "activity_target_unavailable" };
  return { kind: "folded",activity: updated,delivery,interactionRequestId: request.rows[0].id };
}
