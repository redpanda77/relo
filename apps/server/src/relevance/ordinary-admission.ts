import type { ApnsMode } from "../activities.js";
import { settleInteractiveLiveActivity } from "../interactive-activity-lifecycle.js";
import { generateToken,hashToken } from "../auth.js";
import { publicId } from "../ids.js";
import { decisionSubjectCommand,noticeSubjectCommand } from "./admission.js";
import { applySubjectMutation,SubjectAdmissionError,type ServerSubjectActor,type SubjectCommand,type SubjectTransaction } from "./commands.js";

type OrdinaryInput = {
  apnsMode: ApnsMode;
  eventId: string; createdAt: Date | string; idempotencyKey: string; intentHash: string;
  relevance?: SubjectCommand | undefined;
} & ({ kind: "notice" } | {
  kind: "decision";
  actionDeadlineCap?: Date | string | undefined;
  interaction: { kind: "approval" | "yes_no" | "text"; prompt: string; actionSeconds: number };
});
export type AdmittedRequest = { id: string; state: "pending" | "expired"; expires_at: Date };

/** Caller owns the transaction and rolls back its provisional event on duplicate.
 * Authentication remains in adapters. Admission, initial expiry and request state
 * are shared so a Dashboard/service request cannot silently restart its lifetime. */
export async function admitOrdinaryEvent(tx: SubjectTransaction,actor: ServerSubjectActor,input: OrdinaryInput) {
  if (input.relevance && (input.relevance.policy.kind === "decision") !== (input.kind === "decision")) {
    throw new SubjectAdmissionError("invalid_relevance");
  }
  if (input.kind === "decision" && input.relevance?.policy.kind === "decision"
    && input.relevance.policy.actionSeconds !== undefined
    && input.relevance.policy.actionSeconds !== input.interaction.actionSeconds) throw new SubjectAdmissionError("invalid_relevance");
  const command: SubjectCommand = input.relevance ? {
    ...input.relevance,
    policy: input.kind === "decision" ? { kind: "decision",actionSeconds: input.interaction.actionSeconds,
      ...(input.relevance.policy.deliverySeconds === undefined ? {} : { deliverySeconds: input.relevance.policy.deliverySeconds }) }
      : input.relevance.policy,
  } : input.kind === "notice"
    ? noticeSubjectCommand(undefined,input.idempotencyKey,input.createdAt)
    : decisionSubjectCommand(undefined,input.idempotencyKey,input.createdAt,input.interaction.actionSeconds);
  const admission = await applySubjectMutation(tx,actor,{
    eventId: input.eventId,command,intentHash: input.intentHash,
    actionDeadlineCap: input.kind === "decision" ? input.actionDeadlineCap : undefined,
  });
  if (admission.kind === "duplicate") return admission;
  // Replacement already holds each old activity and request. Native cleanup is
  // independent of the new head and keeps its own one-hour delivery deadline.
  for (const eventId of admission.supersededEventIds) {
    await settleInteractiveLiveActivity(tx,{ principalId: actor.principalId,
      notificationEventId: eventId,responseState: "canceled",apnsMode: input.apnsMode });
  }
  let request: AdmittedRequest | null = null;
  if (input.kind === "decision") {
    const deadline = admission.relevance.deadlines.actionExpiresAt!;
    request = (await tx.query<AdmittedRequest>(
      `WITH admission_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
       INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at,state,responded_at)
       SELECT $1,$2,$3,$4,$5,$6,
         CASE WHEN $6::timestamptz<=admission_clock.at THEN 'expired'::interaction_request_state ELSE 'pending'::interaction_request_state END,
         CASE WHEN $6::timestamptz<=admission_clock.at THEN admission_clock.at ELSE NULL END
       FROM admission_clock RETURNING id,state,expires_at`,
      [actor.principalId,input.eventId,input.interaction.kind,input.interaction.prompt,hashToken(generateToken()),deadline],
    )).rows[0]!;
    await tx.query(`UPDATE notification_events SET expires_at=$2,
      state=CASE WHEN $3='expired' THEN 'expired'::notification_state ELSE state END,
      payload=payload||$4::jsonb WHERE id=$1`,[input.eventId,deadline,request.state,
      { interactionId: publicId("int",request.id),interactionType: input.interaction.kind }]);
  } else {
    await tx.query("UPDATE notification_events SET expires_at=$2 WHERE id=$1",
      [input.eventId,admission.relevance.deadlines.relevantUntil]);
  }
  return { ...admission,request };
}
