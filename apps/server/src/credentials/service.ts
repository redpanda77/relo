import { scopesFor } from "@relo/notification-contracts";
import type { Database } from "../db.js";
import { touch } from "./touch.js";
import { newWebhookSecret,secretPrefix,WEBHOOK_SECRET_PATTERN,webhookDigest } from "./hash.js";

type Queryable = Pick<Database,"query">;

/**
 * Webhook service secrets (kind "service", `webhook_services`): one secret per service, sent in a header
 * (never a URL). Only this module writes the secret and revocation columns (plan 10 M1); the service's title,
 * image and presentation stay with the webhooks module.
 */

/** A service sends for its account only while the account has access (ADR 0004: disabling stops it). */
const ACTIVE_OWNER = "JOIN owner_principals service_owner ON service_owner.id=s.principal_id AND service_owner.disabled_at IS NULL";

/**
 * The active service a secret belongs to, on an account that still has access; undefined for anything else
 * (a malformed, unknown, rotated or revoked secret, or a disabled account). `forShare` locks the row.
 */
export async function resolveService(db: Queryable,secret: string,options: { forShare?: boolean } = {}): Promise<any | undefined> {
  if (!WEBHOOK_SECRET_PATTERN.test(secret)) return undefined;
  const result = await db.query(
    `SELECT s.* FROM webhook_services s ${ACTIVE_OWNER}
     WHERE s.secret_hash=$1 AND s.revoked_at IS NULL${options.forShare ? " FOR SHARE OF s" : ""}`,
    [webhookDigest(secret)],
  );
  if (result.rows[0]) await touch(db,"service",result.rows[0].id);
  return result.rows[0];
}

/** What a caller needs to send as a service: where (the endpoint, no secret in it) and the secret for the header. */
export function serviceCredential(appUrl: string,secret: string): { endpoint: string; secret: string } {
  return { endpoint: `${new URL(appUrl).origin}/hooks`,secret };
}

export async function createService(db: Queryable,input: {
  principalId: string; title: string; imageUrl?: string | null | undefined; destinationUrl?: string | null | undefined;
  readableAllowed?: boolean | undefined; scopes?: string[] | undefined;
}): Promise<{ row: any; secret: string }> {
  const secret = newWebhookSecret();
  const result = await db.query<any>(
    `INSERT INTO webhook_services(principal_id,title,image_url,default_url,secret_hash,secret_prefix,readable_allowed,scopes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.principalId,input.title,input.imageUrl ?? null,input.destinationUrl ?? null,webhookDigest(secret),secretPrefix(secret),
      input.readableAllowed ?? false,input.scopes ?? scopesFor("service")],
  );
  return { row: result.rows[0],secret };
}

/** A new secret for an active service; the old one stops working at once. A revoked service stays revoked. */
export async function rotateService(db: Queryable,principalId: string,serviceId: string): Promise<{ row: any; secret: string } | null> {
  const secret = newWebhookSecret();
  const result = await db.query<any>(
    `UPDATE webhook_services SET secret_hash=$3,secret_prefix=$4,updated_at=now()
     WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING *`,
    [serviceId,principalId,webhookDigest(secret),secretPrefix(secret)],
  );
  return result.rowCount ? { row: result.rows[0],secret } : null;
}

/** Revokes an active service; false when it is unknown or already revoked. */
export async function revokeService(db: Queryable,principalId: string,serviceId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE webhook_services SET revoked_at=COALESCE(revoked_at,now()),updated_at=now()
     WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING id`,
    [serviceId,principalId],
  );
  return Boolean(result.rowCount);
}
