import { lookup } from "node:dns/promises";
import { publicId } from "./ids.js";
import type { TransportTokenEncryption } from "./token-encryption.js";
import { isPublicHttpsUrl } from "./url-policy.js";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: any[] }> };

export const CALLBACK_TOKEN_PURPOSE = "interaction_callback.token" as const;
/** Five attempts: now, then after 30 seconds, 2 minutes, 10 minutes, and 1 hour. */
export const CALLBACK_RETRY_DELAYS_SECONDS = [30, 120, 600, 3_600] as const;
export const CALLBACK_MAX_ATTEMPTS = CALLBACK_RETRY_DELAYS_SECONDS.length + 1;
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
}) {
  const action = ({ approved: "approve",denied: "deny",yes: "yes",no: "no",replied: "reply" } as Record<string,string>)[row.request_state] ?? null;
  const response = row.response && typeof row.response === "object" ? (row.response as Record<string,unknown>).response : undefined;
  return {
    type: "notification.response",
    eventId: publicId("ntf",row.notification_event_id),
    interactionId: publicId("int",row.interaction_request_id),
    correlationId: row.correlation_id,
    kind: row.kind === "text" ? "reply" : row.kind,
    status: row.request_state,
    action,
    text: typeof response === "string" ? response : null,
    respondedAt: row.responded_at ? new Date(row.responded_at).toISOString() : null,
  };
}

/** Refuses hosts that resolve to private, loopback, or link-local addresses. */
async function resolvesPublicly(url: string, resolve: typeof lookup): Promise<boolean> {
  if (!isPublicHttpsUrl(url)) return false;
  try {
    const addresses = await resolve(new URL(url).hostname,{ all: true,verbatim: true });
    return addresses.length > 0 && addresses.every(({ address,family }) =>
      isPublicHttpsUrl(family === 6 ? `https://[${address}]/` : `https://${address}/`));
  } catch {
    return false;
  }
}

export type CallbackDispatchDependencies = {
  encryption: Pick<TransportTokenEncryption,"decrypt">;
  fetchImpl?: typeof fetch;
  resolve?: typeof lookup;
  userAgent?: string;
};

/** Settles waiting callbacks against their requests, then delivers what is due. Returns attempts made. */
export async function dispatchDueInteractionCallbacks(db: Queryable, dependencies: CallbackDispatchDependencies): Promise<number> {
  await db.query(
    `UPDATE interaction_callbacks c SET state=CASE WHEN r.state::text=ANY($1::text[]) THEN 'pending' ELSE 'not_answered' END,
       next_attempt_at=CASE WHEN r.state::text=ANY($1::text[]) THEN now() ELSE NULL END,updated_at=now()
     FROM interaction_requests r
     WHERE r.id=c.interaction_request_id AND c.state='waiting' AND r.state::text=ANY($1::text[] || $2::text[])`,
    [ANSWERED,UNANSWERED],
  );
  const claimed = await db.query(
    `UPDATE interaction_callbacks c SET state='delivering',lease_expires_at=now()+interval '30 seconds',updated_at=now()
     FROM interaction_requests r
     WHERE r.id=c.interaction_request_id AND c.id IN (
       SELECT id FROM interaction_callbacks
       WHERE (state='pending' AND next_attempt_at<=now()) OR (state='delivering' AND lease_expires_at<now())
       ORDER BY next_attempt_at NULLS FIRST LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING c.id,c.url,c.token_ciphertext,c.correlation_id,c.attempts,c.interaction_request_id,
       r.notification_event_id,r.kind::text AS kind,r.state::text AS request_state,r.response,r.responded_at`,
    [CALLBACK_BATCH],
  );
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const resolve = dependencies.resolve ?? lookup;
  for (const row of claimed.rows) {
    let status: number | null = null;
    let error: string | null = null;
    try {
      if (!await resolvesPublicly(row.url,resolve)) {
        error = "callback_host_not_public";
      } else {
        const token = dependencies.encryption.decrypt(row.token_ciphertext,CALLBACK_TOKEN_PURPOSE);
        const response = await fetchImpl(row.url,{
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "user-agent": dependencies.userAgent ?? "Relo-Callbacks/1",
          },
          body: JSON.stringify(callbackPayload(row)),
        });
        status = response.status;
        await response.body?.cancel().catch(() => {});
        if (status < 200 || status >= 300) error = `http_${status}`;
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
    } else if (attempts >= CALLBACK_MAX_ATTEMPTS) {
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
