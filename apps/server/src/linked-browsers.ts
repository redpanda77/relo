import { z } from "zod";
import type { Database } from "./db.js";
import { e2eeKeyId,PREKEY_STALE_AFTER_MS,publishDeviceKeysSchema,verifyPrekeySignature,type DeviceKeyResource } from "./device-keys.js";
import { internalId,publicId } from "./ids.js";

/**
 * Linked browsers (docs/END-TO-END-ENCRYPTION.md, "Linked browsers"): a Dashboard that holds its own
 * keys, like WhatsApp Web. The server stores public keys and the phone's link signature; it never
 * decides trust. Computers seal to a browser only when a phone they trust signed its identity key.
 */
const MAX_BROWSERS = 8;
const PREKEY_SKEW_MS = 10 * 60_000;
const ENVELOPE_IDS = 100;

const b64u = (length: number) => z.string().regex(/^[A-Za-z0-9_-]+$/).refine(
  (value) => Buffer.from(value,"base64url").toString("base64url") === value && Buffer.from(value,"base64url").length === length,
  "invalid_encoding",
);

export const registerBrowserSchema = publishDeviceKeysSchema.extend({
  name: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/),
  browserId: z.string().regex(/^brw_[0-9a-f-]{36}$/),
}).strict();
export type RegisterBrowser = z.infer<typeof registerBrowserSchema>;

export const linkBrowserSchema = z.object({
  browserId: z.string().regex(/^brw_[0-9a-f-]{36}$/),
  identityKey: b64u(65),
  signedAt: z.iso.datetime(),
  signature: b64u(64),
}).strict();
export type LinkBrowser = z.infer<typeof linkBrowserSchema>;

/** Registers this browser's keys, or publishes a new prekey for a browser it registered before. */
export async function registerBrowser(
  db: Pick<Database,"query">,
  principalId: string,
  input: RegisterBrowser,
  now = new Date(),
): Promise<{ ok: true; browserId: string; linked: boolean } | { ok: false; error: string }> {
  const created = Date.parse(input.prekey.createdAt);
  if (created > now.getTime() + PREKEY_SKEW_MS || created < now.getTime() - PREKEY_STALE_AFTER_MS) {
    return { ok: false,error: "prekey_clock_skew" };
  }
  // The browser picks its own id (brw_<random uuid>) and signs its prekey for it.
  const id = internalId("brw",input.browserId);
  if (!id) return { ok: false,error: "invalid_browser_id" };
  const browserId = publicId("brw",id);
  if (!verifyPrekeySignature(input.identityKey,browserId,input.prekey)) return { ok: false,error: "invalid_prekey_signature" };
  const updated = await db.query<{ linked: boolean }>(
    `UPDATE linked_browsers SET name=$3,prekey_id=$4,prekey_public_key=$5,prekey_signature=$6,prekey_created_at=$7,
       prekey_received_at=now(),last_seen_at=now()
     WHERE id=$1 AND principal_id=$2 AND identity_key=$8 AND revoked_at IS NULL
     RETURNING linked_at IS NOT NULL AS linked`,
    [id,principalId,input.name,input.prekey.prekeyId,input.prekey.publicKey,input.prekey.signature,input.prekey.createdAt,
      input.identityKey],
  );
  if (updated.rows[0]) return { ok: true,browserId,linked: updated.rows[0].linked };
  // A browser registered but never linked for a day is abandoned (storage cleared, signed out
  // elsewhere): revoke it so it neither counts toward the limit nor lingers (review L5).
  await db.query(`UPDATE linked_browsers SET revoked_at=now() WHERE principal_id=$1 AND revoked_at IS NULL
    AND linked_at IS NULL AND last_seen_at<now()-interval '1 day'`,[principalId]);
  const count = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM linked_browsers WHERE principal_id=$1 AND revoked_at IS NULL",[principalId]);
  if ((count.rows[0]?.n ?? 0) >= MAX_BROWSERS) return { ok: false,error: "too_many_browsers" };
  // A new browser; an id already used (another account, another identity, or revoked) is refused: pick a new one.
  const inserted = await db.query(
    `INSERT INTO linked_browsers(id,principal_id,name,key_id,identity_key,prekey_id,prekey_public_key,prekey_signature,prekey_created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
    [id,principalId,input.name,e2eeKeyId(Buffer.from(input.identityKey,"base64url")),input.identityKey,
      input.prekey.prekeyId,input.prekey.publicKey,input.prekey.signature,input.prekey.createdAt],
  );
  if (!inserted.rowCount) return { ok: false,error: "browser_id_taken" };
  return { ok: true,browserId,linked: false };
}

export async function browserStatus(db: Pick<Database,"query">,principalId: string,browserId: string) {
  const id = internalId("brw",browserId);
  if (!id) return null;
  const result = await db.query<any>(
    `SELECT b.linked_at,d.name AS linked_by FROM linked_browsers b LEFT JOIN devices d ON d.id=b.linked_by_device
     WHERE b.id=$1 AND b.principal_id=$2 AND b.revoked_at IS NULL`,[id,principalId]);
  const row = result.rows[0];
  if (!row) return null;
  return { linked: row.linked_at !== null,...(row.linked_by ? { linkedBy: row.linked_by as string } : {}) };
}

/** A phone links a browser by signing its identity key; the server only checks the account and the key. */
export async function linkBrowser(
  db: Pick<Database,"query">,
  principalId: string,
  deviceId: string,
  input: LinkBrowser,
): Promise<{ ok: true; browserId: string; name: string; linkedAt: string } | { ok: false; error: "browser_not_found" | "identity_mismatch" }> {
  const id = internalId("brw",input.browserId);
  if (!id) return { ok: false,error: "browser_not_found" };
  const current = await db.query<{ identity_key: string }>(
    "SELECT identity_key FROM linked_browsers WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL",[id,principalId]);
  if (!current.rows[0]) return { ok: false,error: "browser_not_found" };
  if (current.rows[0].identity_key !== input.identityKey) return { ok: false,error: "identity_mismatch" };
  const linked = await db.query<{ name: string; linked_at: Date }>(
    `UPDATE linked_browsers SET linked_by_device=$3,link_signed_at=$4,link_signature=$5,linked_at=now()
     WHERE id=$1 AND principal_id=$2 RETURNING name,linked_at`,
    [id,principalId,deviceId,input.signedAt,input.signature],
  );
  const row = linked.rows[0]!;
  return { ok: true,browserId: input.browserId,name: row.name,linkedAt: row.linked_at.toISOString() };
}

export async function listLinkedBrowsers(db: Pick<Database,"query">,principalId: string) {
  const result = await db.query<any>(
    `SELECT id,name,linked_at FROM linked_browsers WHERE principal_id=$1 AND revoked_at IS NULL AND linked_at IS NOT NULL
     ORDER BY linked_at DESC`,[principalId]);
  return result.rows.map((row) => ({ browserId: publicId("brw",row.id),name: row.name as string,linkedAt: row.linked_at.toISOString() }));
}

export async function unlinkBrowser(db: Pick<Database,"query">,principalId: string,browserId: string): Promise<boolean> {
  const id = internalId("brw",browserId);
  if (!id) return false;
  const result = await db.query("UPDATE linked_browsers SET revoked_at=now() WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL",
    [id,principalId]);
  return (result.rowCount ?? 0) > 0;
}

/** Browsers for the CLI's key directory, with the phone's link signature for the CLI to check. */
export async function browserKeys(db: Pick<Database,"query">,principalId: string,now = new Date()): Promise<DeviceKeyResource[]> {
  const result = await db.query<any>(
    `SELECT b.*,d.id AS phone_id FROM linked_browsers b LEFT JOIN devices d ON d.id=b.linked_by_device AND d.revoked_at IS NULL
     WHERE b.principal_id=$1 AND b.revoked_at IS NULL ORDER BY b.created_at DESC LIMIT ${MAX_BROWSERS}`,[principalId]);
  return result.rows.map((row) => ({
    deviceId: publicId("brw",row.id),
    kind: "browser" as const,
    name: row.name,
    identityKey: { keyId: row.key_id,publicKey: row.identity_key,changedAt: new Date(row.created_at).toISOString() },
    prekey: { prekeyId: row.prekey_id,publicKey: row.prekey_public_key,createdAt: row.prekey_created_at,signature: row.prekey_signature,
      stale: now.getTime() - new Date(row.prekey_received_at).getTime() > PREKEY_STALE_AFTER_MS },
    link: row.phone_id && row.link_signature
      ? { deviceId: publicId("dev",row.phone_id),signedAt: row.link_signed_at,signature: row.link_signature } : null,
  }));
}

/**
 * Content envelopes for a linked browser, by notification (ntf_), card (act_) or agent-session
 * (ags_) id. Returns null when `browserId` is not a linked browser of the account.
 */
export async function sealedEnvelopesForBrowser(
  db: Pick<Database,"query">,
  principalId: string,
  browserId: string,
  ids: string[],
): Promise<Record<string,unknown> | null> {
  const status = await browserStatus(db,principalId,browserId);
  if (!status?.linked) return null;
  const pick = (prefix: "ntf" | "act" | "ags") => ids.map((value) => [value,internalId(prefix,value)] as const)
    .filter((pair): pair is readonly [string,string] => Boolean(pair[1]));
  const notifications = pick("ntf");
  const cards = pick("act");
  const sessions = pick("ags");
  const envelopes: Record<string,unknown> = {};
  const fill = (pairs: readonly (readonly [string,string])[],rows: { id: string; envelope: unknown }[]) => {
    for (const row of rows) {
      const pair = pairs.find(([,id]) => id === row.id);
      if (pair && row.envelope) envelopes[pair[0]] = row.envelope;
    }
  };
  if (notifications.length) fill(notifications,(await db.query<any>(
    `SELECT e.id,COALESCE(e.payload#>'{sealed,content}',e.payload#>'{liveActivity,sealed,content}',a.sealed->'content') AS envelope
     FROM notification_events e
     LEFT JOIN live_activities a ON a.principal_id=e.principal_id AND e.kind='live_activity'
       AND e.payload#>>'{liveActivity,activityId}'=('act_'||a.id::text)
     WHERE e.principal_id=$1 AND e.id=ANY($2::uuid[])`,[principalId,notifications.map(([,id]) => id)])).rows);
  if (cards.length) fill(cards,(await db.query<any>(
    "SELECT id,sealed->'content' AS envelope FROM live_activities WHERE principal_id=$1 AND id=ANY($2::uuid[])",
    [principalId,cards.map(([,id]) => id)])).rows);
  if (sessions.length) fill(sessions,(await db.query<any>(
    "SELECT id,sealed_names AS envelope FROM agent_sessions WHERE principal_id=$1 AND id=ANY($2::uuid[])",
    [principalId,sessions.map(([,id]) => id)])).rows);
  return envelopes;
}

export const SEALED_ENVELOPE_IDS_MAX = ENVELOPE_IDS;
