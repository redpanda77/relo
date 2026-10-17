import { lookup } from "node:dns/promises";
import { allowsPrivateCallbacks,callbackSignature,resolveCallbackTarget,sendPinnedCallback,standardWebhookSignature,type CallbackSend } from "./callback-destinations.js";
import { publicId } from "./ids.js";
import type { TransportTokenEncryption } from "./token-encryption.js";
import { FACTS } from "@relo/notification-contracts";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: any[] }> };

export const CALLBACK_TOKEN_PURPOSE = "interaction_callback.token" as const;
/** Ten attempts over about three days: now, then 30 s, 2 min, 10 min, 1 h, 3 h, 6 h, 12 h, 24 h, 24 h. */
export const CALLBACK_RETRY_DELAYS_SECONDS = FACTS.callback.retryDelaysSeconds;
export const CALLBACK_MAX_ATTEMPTS = CALLBACK_RETRY_DELAYS_SECONDS.length + 1;
/** A callback stops retrying 72 hours after its first attempt (or after a redelivery). */
export const CALLBACK_GIVE_UP_SECONDS = FACTS.callback.giveUpSeconds;
export const CALLBACK_REDELIVERIES_PER_DAY = FACTS.callback.redeliveriesPerDay;
const CALLBACK_TIMEOUT_MS = 10_000;
const CALLBACK_BATCH = 10;
const ANSWERED = ["approved","denied","yes","no","replied"];
const UNANSWERED = ["expired","canceled"];

export type CallbackRegistration = {
  principalId: string;
  interactionRequestId: string;
  url: string;
  token: string;
  correlationId?: string | undefined;
};

/** Idempotent: a replayed create keeps the first registration. */
export async function registerInteractionCallback(
  query: Queryable,
  encryption: Pick<TransportTokenEncryption,"encrypt">,
  registration: CallbackRegistration,
): Promise<void> {
  await query.query(
    `INSERT INTO interaction_callbacks(principal_id,interaction_request_id,url,token_ciphertext,correlation_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (interaction_request_id) DO NOTHING`,
    [registration.principalId,registration.interactionRequestId,registration.url,
      encryption.encrypt(registration.token,CALLBACK_TOKEN_PURPOSE),registration.correlationId ?? null],
  );
}

export function callbackPayload(row: {
  interaction_request_id: string; notification_event_id: string; correlation_id: string | null;
  kind: string; request_state: string; response: unknown; responded_at: Date | string | null;
  response_device_id?: string | null;
  response_browser_id?: string | null;
  response_request_id?: string | null; response_event_id?: string | null;
}) {
  const answer = row.response && typeof row.response === "object" ? row.response as Record<string,unknown> : {};
  const chosen = row.kind === "choice" && typeof answer.optionId === "string";
  const action = chosen ? "choose"
    : ({ approved: "approve",denied: "deny",yes: "yes",no: "no",replied: "reply" } as Record<string,string>)[row.request_state] ?? null;
  const response = answer.response;
  return {
    type: "notification.response",
    eventId: publicId("ntf",row.notification_event_id),
    interactionId: publicId("int",row.interaction_request_id),
    correlationId: row.correlation_id,
    kind: row.kind === "text" ? "reply" : row.kind,
    status: row.request_state,
    action,
    text: typeof response === "string" ? response : null,
    ...(chosen ? { optionId: answer.optionId,label: answer.label ?? null } : {}),
    respondedAt: row.responded_at ? new Date(row.responded_at).toISOString() : null,
    ...answerSignature(row.response_device_id ?? null,answer,row.response_browser_id ?? null),
    // Answered on another copy of the question: the signature covers that copy's ids.
    ...answeredCopyResource({ id: row.interaction_request_id,response_request_id: row.response_request_id ?? null,
      response_event_id: row.response_event_id ?? null }),
  };
}

/**
 * The phone's own signature over the answer (ADR 0005), passed through untouched so a verifying
 * receiver trusts the phone, not this server. `signature` is null for phones without published keys.
 * A linked browser's answer names the browser (`brw_…`); a receiver applies the browser rule
 * (docs/ENCRYPTION-PROTOCOL.md, "Answering from a linked browser").
 */
export function answerSignature(deviceId: string | null,answer: Record<string,unknown>,browserId: string | null = null) {
  const str = (value: unknown) => typeof value === "string" ? value : null;
  const sig = str(answer.e2eeSignature);
  return {
    device: browserId ? { id: publicId("brw",browserId),keyId: str(answer.e2eeKeyId) }
      : deviceId ? { id: publicId("dev",deviceId),keyId: str(answer.e2eeKeyId) } : null,
    signature: sig ? {
      v: "relo.e2e.v1",kind: "answer",
      keyId: str(answer.e2eeKeyId),signedAt: str(answer.e2eeSignedAt),sig,
      question: str(answer.e2eeQuestion),questionSig: str(answer.e2eeQuestionSignature),
    } : null,
  };
}

/**
 * The copy of the question that was answered, when it is not this one (docs/ENCRYPTION-PROTOCOL.md,
 * "Answers on another copy"): a question folded onto a card has one copy per phone, and a long one
 * continues as a notification; every copy takes the decision. The answering phone signed that copy's
 * ids, so a computer verifies the signature over them (and accepts it only bound to its sealed question).
 */
export function answeredCopyResource(row: { id: string; response_request_id?: string | null; response_event_id?: string | null }) {
  return row.response_request_id && row.response_event_id && row.response_request_id !== row.id
    ? { answeredCopy: { id: publicId("int",row.response_request_id),eventId: publicId("ntf",row.response_event_id) } }
    : {};
}

export type CallbackDispatchDependencies = {
  encryption: Pick<TransportTokenEncryption,"decrypt">;
  send?: CallbackSend;
  resolve?: typeof lookup;
  userAgent?: string;
  now?: () => number;
};

/** Settles waiting callbacks against their requests, then delivers what is due. Returns attempts made. */
export async function dispatchDueInteractionCallbacks(db: Queryable, dependencies: CallbackDispatchDependencies): Promise<number> {
  await db.query(
    `UPDATE interaction_callbacks c SET state=CASE WHEN r.state::text=ANY($1::text[]) THEN 'pending' ELSE 'not_answered' END,
       next_attempt_at=CASE WHEN r.state::text=ANY($1::text[]) THEN now() ELSE NULL END,
       give_up_at=CASE WHEN r.state::text=ANY($1::text[]) THEN now()+($3*interval '1 second') ELSE NULL END,updated_at=now()
     FROM interaction_requests r
     WHERE r.id=c.interaction_request_id AND c.state='waiting' AND r.state::text=ANY($1::text[] || $2::text[])`,
    [ANSWERED,UNANSWERED,CALLBACK_GIVE_UP_SECONDS],
  );
  const claimed = await db.query(
    `UPDATE interaction_callbacks c SET state='delivering',lease_expires_at=now()+interval '30 seconds',updated_at=now()
     FROM interaction_requests r
     WHERE r.id=c.interaction_request_id AND c.id IN (
       SELECT id FROM interaction_callbacks
       WHERE (state='pending' AND next_attempt_at<=now()) OR (state='delivering' AND lease_expires_at<now())
       ORDER BY next_attempt_at NULLS FIRST LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING c.id,c.principal_id,c.url,c.token_ciphertext,c.correlation_id,c.attempts,c.interaction_request_id,
       c.give_up_at <= now() AS past_give_up,
       (SELECT i.device_id FROM interactions i WHERE i.interaction_request_id=COALESCE(r.answered_on_request_id,r.id) ORDER BY i.created_at,i.id LIMIT 1) AS response_device_id,
       (SELECT i.browser_id FROM interactions i WHERE i.interaction_request_id=COALESCE(r.answered_on_request_id,r.id) ORDER BY i.created_at,i.id LIMIT 1) AS response_browser_id,
       r.answered_on_request_id AS response_request_id,
       (SELECT a.notification_event_id FROM interaction_requests a WHERE a.id=r.answered_on_request_id) AS response_event_id,
       r.notification_event_id,r.kind::text AS kind,r.state::text AS request_state,r.response,r.responded_at`,
    [CALLBACK_BATCH],
  );
  const send = dependencies.send ?? sendPinnedCallback;
  const privateAllowed = new Map<string,boolean>();
  for (const row of claimed.rows) {
    let status: number | null = null;
    let error: string | null = null;
    try {
      if (!privateAllowed.has(row.principal_id)) {
        privateAllowed.set(row.principal_id,await allowsPrivateCallbacks(db as any,row.principal_id));
      }
      const target = await resolveCallbackTarget(row.url,{
        allowPrivate: privateAllowed.get(row.principal_id)!,resolve: dependencies.resolve,
      });
      if (!target.ok) {
        error = target.error;
      } else {
        const token = dependencies.encryption.decrypt(row.token_ciphertext,CALLBACK_TOKEN_PURPOSE);
        if (!token) throw new Error("callback_token_missing");
        const body = JSON.stringify(callbackPayload(row));
        const timestamp = Math.floor((dependencies.now?.() ?? Date.now()) / 1_000);
        const deliveryId = publicId("cbk",row.id);
        status = await send({ url: row.url,target,body,timeoutMs: CALLBACK_TIMEOUT_MS,headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": dependencies.userAgent ?? "Relo-Callbacks/1",
          // The same id on every retry of one answer: a receiver handles each id once.
          "relo-delivery-id": deliveryId,
          "relo-signature": callbackSignature(token,body,timestamp),
          // Standard Webhooks (standardwebhooks.com): the same id on retries and redeliveries.
          "webhook-id": deliveryId,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": standardWebhookSignature(token,deliveryId,timestamp,body),
        } });
        if (status === 410) error = "gone";
        else if (status < 200 || status >= 300) error = `http_${status}`;
      }
    } catch (cause) {
      error = cause instanceof Error && cause.name === "TimeoutError" ? "timeout" : "network_error";
    }
    const attempts = Number(row.attempts) + 1;
    if (error === null) {
      await db.query(
        `UPDATE interaction_callbacks SET state='delivered',attempts=$2,last_status=$3,last_error=NULL,
           lease_expires_at=NULL,next_attempt_at=NULL,delivered_at=now(),updated_at=now() WHERE id=$1`,
        [row.id,attempts,status],
      );
    } else if (attempts >= CALLBACK_MAX_ATTEMPTS || error === "gone" || row.past_give_up === true) {
      await db.query(
        `UPDATE interaction_callbacks SET state='failed',attempts=$2,last_status=$3,last_error=$4,
           lease_expires_at=NULL,next_attempt_at=NULL,updated_at=now() WHERE id=$1`,
        [row.id,attempts,status,error],
      );
      console.warn(JSON.stringify({ event: "interaction_callback_failed",callbackId: row.id,attempts,error }));
    } else {
      await db.query(
        `UPDATE interaction_callbacks SET state='pending',attempts=$2,last_status=$3,last_error=$4,lease_expires_at=NULL,
           next_attempt_at=now()+($5*interval '1 second'),updated_at=now() WHERE id=$1`,
        [row.id,attempts,status,error,CALLBACK_RETRY_DELAYS_SECONDS[attempts-1]],
      );
    }
  }
  return claimed.rows.length;
}

export type RedeliverResult = "redelivered" | "not_found" | "not_redeliverable" | "redeliver_rate_limited";

/**
 * Sends a delivered or failed callback again with the same webhook-id: attempts reset, a fresh
 * 72-hour window, at most ten redeliveries per callback per day. Only the asking account may do it.
 */
export async function redeliverInteractionCallback(db: Queryable,principalId: string,interactionRequestId: string): Promise<RedeliverResult> {
  const current = await db.query(
    `SELECT state,redelivered_today,redeliver_window_start > now()-interval '1 day' AS window_open
     FROM interaction_callbacks WHERE principal_id=$1 AND interaction_request_id=$2`,
    [principalId,interactionRequestId],
  );
  const row = current.rows[0];
  if (!row) return "not_found";
  if (row.state !== "failed" && row.state !== "delivered") return "not_redeliverable";
  if (row.window_open === true && Number(row.redelivered_today) >= CALLBACK_REDELIVERIES_PER_DAY) return "redeliver_rate_limited";
  const updated = await db.query(
    `UPDATE interaction_callbacks SET state='pending',attempts=0,next_attempt_at=now(),lease_expires_at=NULL,
       last_error=NULL,give_up_at=now()+($3*interval '1 second'),redelivered_count=redelivered_count+1,
       redelivered_today=CASE WHEN redeliver_window_start > now()-interval '1 day' THEN redelivered_today+1 ELSE 1 END,
       redeliver_window_start=CASE WHEN redeliver_window_start > now()-interval '1 day' THEN redeliver_window_start ELSE now() END,
       updated_at=now()
     WHERE principal_id=$1 AND interaction_request_id=$2 AND state IN ('failed','delivered')`,
    [principalId,interactionRequestId,CALLBACK_GIVE_UP_SECONDS],
  );
  return updated.rowCount ? "redelivered" : "not_redeliverable";
}

/** What a caller may see about its callback: never the URL's token or the URL itself. */
export function callbackResource(row: { callback_state?: string | null; callback_attempts?: number | null;
  callback_last_status?: number | null; callback_last_error?: string | null; callback_delivered_at?: Date | string | null }) {
  if (!row.callback_state) return null;
  return {
    state: row.callback_state,
    attempts: Number(row.callback_attempts ?? 0),
    lastStatus: row.callback_last_status ?? null,
    lastError: row.callback_last_error ?? null,
    deliveredAt: row.callback_delivered_at ? new Date(row.callback_delivered_at).toISOString() : null,
  };
}
