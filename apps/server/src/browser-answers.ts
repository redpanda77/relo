import { choiceOptionIdSchema } from "@relo/notification-contracts";
import { z } from "zod";
import type { Database } from "./db.js";
import { BROWSER_LINK_DAYS,verifyP256 } from "./device-approvals.js";
import { internalId,publicId } from "./ids.js";
import { answerSignatureSchema,sealedForDevice } from "./sealed-content.js";

/**
 * Answering from a linked browser (docs/ENCRYPTION-PROTOCOL.md, "Answering from a linked browser").
 * The Dashboard's own non-extractable identity key signs exactly the input a phone signs, with the
 * browser's `brw_…` id as the answering device. The server only admits the answer: the browser must
 * be linked now (a phone still on the account signed its link 14 days ago or less), the signature
 * must verify against its published key, and a sealed question must have been sealed to it. It never
 * decides trust: each computer checks the signature and the link again, and refuses a browser's
 * answer in strict mode.
 */
const SIGNED_AT_SKEW_MS = 10 * 60_000;

export const browserAnswerSchema = z.object({
  notificationId: z.string().regex(/^ntf_[0-9a-f-]{36}$/),
  action: z.enum(["approve","deny","yes","no","choose"]),
  optionId: choiceOptionIdSchema.optional(),
  /** Made once per tap by the browser and repeated on a retry, so a retry is one answer. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_:.-]{8,120}$/),
  signature: answerSignatureSchema,
}).strict().refine((input) => (input.action === "choose") === (input.optionId !== undefined),
  "A choice is answered with exactly one optionId");
export type BrowserAnswer = z.infer<typeof browserAnswerSchema>;

export type BrowserAnswerError = "browser_not_linked" | "invalid_signature" | "question_unreadable" | "not_found" | "not_asked_copy";

/**
 * The copy of a question its asker waits on, for any copy's internal id (docs/ENCRYPTION-PROTOCOL.md,
 * "Answering from a linked browser"). A question folded onto a card gets one copy per phone (each
 * phone answers its own), and one that outlives its card continues as a notification of the same
 * decision; the asking computer follows exactly one of them and verifies an answer's signature over
 * that copy's ids. A browser has no copy of its own, so it always answers that one: the copy the
 * card's wait recorded (`live_activity_operations.interaction_request_id`), else the card update's
 * first copy (the rule `foldQuestionIntoCard` returns), else the question itself. Null when it is
 * not a question of this account.
 */
export async function askedCopy(db: Pick<Database,"query">,principalId: string,requestId: string): Promise<string | null> {
  const row = (await db.query<{ id: string }>(
    `SELECT ${askedCopySql("r","e")} AS id
     FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id AND e.principal_id=r.principal_id
     WHERE r.id=$1 AND r.principal_id=$2`,[requestId,principalId])).rows[0];
  return row?.id ?? null;
}

/**
 * SQL for `askedCopy` of the request row `request` with its event row `event`: the one place the rule
 * is written (the pending list of an owner overview device uses it too).
 */
export function askedCopySql(request: string,event: string): string {
  const activity = `substring(${event}.payload#>>'{liveActivity,activityId}' from 5)`;
  const sequence = `(${event}.payload#>>'{liveActivity,sequence}')`;
  return `COALESCE(
       (SELECT o.interaction_request_id FROM live_activity_operations o
         JOIN interaction_requests waited ON waited.id=o.interaction_request_id AND waited.principal_id=o.principal_id
         WHERE o.principal_id=${request}.principal_id AND o.live_activity_id::text=${activity} AND o.operation='wait'
           AND o.resulting_sequence::text=${sequence} ORDER BY o.created_at,o.id LIMIT 1),
       (SELECT first_copy.id FROM interaction_requests first_copy
         JOIN notification_events first_event ON first_event.id=first_copy.notification_event_id
         WHERE first_event.principal_id=${request}.principal_id AND first_copy.principal_id=${request}.principal_id
           AND first_event.idempotency_key LIKE 'activity:'||${activity}||':'||${sequence}||':update:%'
         ORDER BY first_copy.created_at,first_copy.id LIMIT 1),
       ${request}.id)`;
}

/** The bytes a phone or linked browser signs for an answer (packages/cli/src/crypto/e2ee.mjs). */
export function answerSigningInput(input: { interactionId: string; notificationId: string; deviceId: string; value: string; respondedAt: string }): Buffer {
  return Buffer.from(["relo.e2e.v1 answer",input.interactionId,input.notificationId,input.deviceId,input.value,input.respondedAt].join("\n"));
}

/** The same, bound to the context of the sealed question envelope the answerer opened. */
export function questionAnswerSigningInput(input: { interactionId: string; notificationId: string; deviceId: string; value: string;
  respondedAt: string; question: string }): Buffer {
  return Buffer.from(["relo.e2e.v1 answer-to",input.interactionId,input.notificationId,input.deviceId,input.value,input.respondedAt,
    input.question].join("\n"));
}

/** What the signature covers: the action, or `choose:<optionId>` for a picked option. */
export function signedAnswerValue(action: BrowserAnswer["action"],optionId?: string): string {
  return action === "choose" ? `choose:${optionId ?? ""}` : action;
}

/**
 * The browser's internal id when it may answer `interactionId` with `input`, or why not. Tenant
 * isolation: a browser, a notification or a sealed question of another account answers like a
 * missing one.
 */
export async function admitBrowserAnswer(
  db: Pick<Database,"query">,principalId: string,browserPublicId: string,interactionPublicId: string,input: BrowserAnswer,now = new Date(),
): Promise<{ ok: true; browserId: string } | { ok: false; error: BrowserAnswerError }> {
  // The question first: another account's question answers like a missing one (tenant isolation).
  const eventId = internalId("ntf",input.notificationId);
  const requestId = internalId("int",interactionPublicId);
  const event = eventId && requestId ? (await db.query<{ payload: unknown }>(
    `SELECT e.payload FROM notification_events e JOIN interaction_requests r ON r.notification_event_id=e.id AND r.principal_id=e.principal_id
     WHERE e.id=$1 AND r.id=$2 AND e.principal_id=$3`,[eventId,requestId,principalId])).rows[0] : undefined;
  if (!event) return { ok: false,error: "not_found" };
  // Only the copy the asker waits on: an answer signed for another copy names a question the
  // computer did not ask and would be refused there, so it is refused here, before it decides anything.
  if (await askedCopy(db,principalId,requestId!) !== requestId) return { ok: false,error: "not_asked_copy" };
  const browser = internalId("brw",browserPublicId);
  if (!browser) return { ok: false,error: "browser_not_linked" };
  const linked = (await db.query<{ key_id: string; identity_key: string; link_signed_at: string }>(
    `SELECT b.key_id,b.identity_key,b.link_signed_at
     FROM linked_browsers b JOIN devices phone ON phone.id=b.linked_by_device AND phone.revoked_at IS NULL
     WHERE b.id=$1 AND b.principal_id=$2 AND b.revoked_at IS NULL AND b.linked_at IS NOT NULL AND b.link_signature IS NOT NULL`,
    [browser,principalId])).rows[0];
  const linkAge = linked ? now.getTime() - Date.parse(linked.link_signed_at) : Number.NaN;
  if (!linked || !(linkAge < BROWSER_LINK_DAYS * 86_400_000)) return { ok: false,error: "browser_not_linked" };
  const { e2eeKeyId,e2eeSignedAt,e2eeSignature,e2eeQuestion,e2eeQuestionSignature } = input.signature;
  const signedAt = Date.parse(e2eeSignedAt);
  if (e2eeKeyId !== linked.key_id || !(Math.abs(now.getTime() - signedAt) <= SIGNED_AT_SKEW_MS)) {
    return { ok: false,error: "invalid_signature" };
  }
  const fields = { interactionId: interactionPublicId,notificationId: input.notificationId,deviceId: publicId("brw",browser),
    value: signedAnswerValue(input.action,input.optionId),respondedAt: e2eeSignedAt };
  if (!verifyP256(linked.identity_key,answerSigningInput(fields),e2eeSignature)) return { ok: false,error: "invalid_signature" };
  // A sealed question is answered only by a browser it was sealed to, bound to the envelope it opened.
  const sealed = sealedForDevice(event.payload,undefined);
  if (sealed) {
    if (!sealed.content.recipients.some((recipient) => recipient.device === publicId("brw",browser))) {
      return { ok: false,error: "question_unreadable" };
    }
    if (e2eeQuestion !== sealed.content.context || !e2eeQuestionSignature) return { ok: false,error: "invalid_signature" };
  }
  if (e2eeQuestion !== undefined) {
    if (!e2eeQuestionSignature || !verifyP256(linked.identity_key,questionAnswerSigningInput({ ...fields,question: e2eeQuestion }),
      e2eeQuestionSignature)) return { ok: false,error: "invalid_signature" };
  }
  return { ok: true,browserId: browser };
}

export type BrowserQuestionAction = { action: "approve" | "deny" | "yes" | "no" | "choose"; label: string; optionId?: string };

/**
 * One question as the Dashboard answers it, by the id of any of its copies (a Now item names the
 * newest): the copy the asker waits on (`askedCopy`) with the ids the browser signs, the sender's own
 * button labels, and whether it is sealed (the browser then opens `notificationId`'s envelope for the
 * prompt and the context it binds the answer to). `readableHere` (sealed, with `browserPublicId` given)
 * says whether that browser is among the recipients: a question sealed only to phones is answered on a phone.
 * Null when it is not a question of this account.
 */
export async function browserQuestion(db: Pick<Database,"query">,principalId: string,interactionPublicId: string,browserPublicId?: string) {
  const copy = internalId("int",interactionPublicId);
  const id = copy ? await askedCopy(db,principalId,copy) : null;
  if (!id) return null;
  const row = (await db.query<any>(
    `SELECT r.id,r.notification_event_id,r.kind::text AS kind,r.prompt,r.options,r.state::text AS state,r.expires_at,
       e.source,e.payload->'sealed' IS NOT NULL AS encrypted,e.payload,a.presentation->'behavior' AS behavior
     FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id AND e.principal_id=r.principal_id
     LEFT JOIN live_activities a ON a.principal_id=e.principal_id AND e.kind='live_activity'
       AND e.payload#>>'{liveActivity,activityId}'=('act_'||a.id::text)
     WHERE r.id=$1 AND r.principal_id=$2`,[id,principalId])).rows[0];
  if (!row || !["approval","yes_no","choice"].includes(row.kind)) return null;
  const sealed = row.encrypted === true ? sealedForDevice(row.payload,undefined) : null;
  const browser = browserPublicId && /^brw_[0-9a-f-]{36}$/.test(browserPublicId) ? browserPublicId : null;
  return {
    id: publicId("int",row.id),
    notificationId: publicId("ntf",row.notification_event_id),
    kind: row.kind as "approval" | "yes_no" | "choice",
    prompt: String(row.prompt),
    encrypted: row.encrypted === true,
    // Only when the Dashboard named its browser: without one, the server cannot say.
    ...(row.encrypted === true && browser ? { readableHere: Boolean(sealed?.content.recipients.some((recipient) => recipient.device === browser)) } : {}),
    state: String(row.state),
    expiresAt: new Date(row.expires_at).toISOString(),
    source: String(row.source ?? ""),
    actions: questionActions(row.kind,row.options,row.behavior),
  };
}

/** The sender's labels: a card question's own buttons, a choice's options, or the defaults. */
export function questionActions(kind: string,options: unknown,behavior: unknown): BrowserQuestionAction[] {
  if (kind === "choice") {
    return (Array.isArray(options) ? options : []).flatMap((option: any) =>
      typeof option?.id === "string" && typeof option?.label === "string" ? [{ action: "choose" as const,label: option.label,optionId: option.id }] : []);
  }
  const shown = behavior && typeof behavior === "object" ? behavior as Record<string,any> : null;
  const label = (side: "primary" | "secondary",action: string,fallback: string) =>
    shown?.type === kind && shown?.[side]?.action === action && typeof shown[side].label === "string" ? shown[side].label as string : fallback;
  return kind === "approval"
    ? [{ action: "deny",label: label("secondary","deny","Deny") },{ action: "approve",label: label("primary","approve","Approve") }]
    : [{ action: "no",label: label("secondary","no","No") },{ action: "yes",label: label("primary","yes","Yes") }];
}
