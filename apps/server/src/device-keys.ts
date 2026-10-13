import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import type { Database } from "./db.js";
import { publicId } from "./ids.js";

/**
 * Key directory for end-to-end encryption (docs/END-TO-END-ENCRYPTION.md, E2.2).
 * Phones publish an identity key and signed prekeys; CLIs read them and decide trust themselves.
 * The signing input and key id match packages/cli/src/e2ee.mjs and ReloE2EE.swift, pinned by
 * packages/contracts/fixtures/e2ee-v1.json.
 */
const E2EE_VERSION = "relo.e2e.v1";
/** Public halves kept per device; a CLI always seals to the newest. */
const PREKEYS_KEPT = 4;
/** A prekey older than this is still served but marked stale, so the CLI can say the phone needs opening. */
export const PREKEY_STALE_AFTER_MS = 7 * 86_400_000;

const b64u = (length: number) => z.string().regex(/^[A-Za-z0-9_-]+$/).refine(
  (value) => Buffer.from(value,"base64url").toString("base64url") === value
    && Buffer.from(value,"base64url").length === length,
  "invalid_encoding",
);

export const publishDeviceKeysSchema = z.object({
  identityKey: b64u(65),
  prekey: z.object({
    prekeyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    publicKey: b64u(65),
    createdAt: z.iso.datetime(),
    signature: b64u(64),
  }).strict(),
}).strict();

export type PublishDeviceKeys = z.infer<typeof publishDeviceKeysSchema>;

export function e2eeKeyId(publicKey: Buffer): string {
  return `k_${createHash("sha256").update(publicKey).digest().subarray(0,16).toString("base64url")}`;
}

function verifyingKey(publicKey: Buffer) {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) return undefined;
  try {
    return createPublicKey({ format: "jwk", key: {
      kty: "EC",crv: "P-256",
      x: publicKey.subarray(1,33).toString("base64url"),y: publicKey.subarray(33).toString("base64url"),
    } });
  } catch {
    return undefined;
  }
}

export function prekeySigningInput(input: { deviceId: string; prekeyId: string; publicKey: string; createdAt: string }): Buffer {
  return Buffer.from([`${E2EE_VERSION} prekey`,input.deviceId,input.prekeyId,input.publicKey,input.createdAt].join("\n"));
}

/** True when `signature` is the device identity key's ECDSA P-256 (raw r||s) over the prekey. */
export function verifyPrekeySignature(identityKey: string, deviceId: string, prekey: PublishDeviceKeys["prekey"]): boolean {
  const key = verifyingKey(Buffer.from(identityKey,"base64url"));
  if (!key || !verifyingKey(Buffer.from(prekey.publicKey,"base64url"))) return false;
  try {
    return verify("sha256",prekeySigningInput({ ...prekey,deviceId }),{ key,dsaEncoding: "ieee-p1363" },
      Buffer.from(prekey.signature,"base64url"));
  } catch {
    return false;
  }
}

export type PublishResult =
  | { ok: true; identityChanged: boolean; keyId: string }
  | { ok: false; error: "invalid_identity_key" | "invalid_prekey_signature" | "prekey_clock_skew" | "prekey_conflict" };

/** Stores the calling phone's identity key and one signed prekey in one transaction; idempotent. */
export async function publishDeviceKeys(
  db: Database,
  input: { principalId: string; deviceId: string; keys: PublishDeviceKeys; now?: Date },
): Promise<PublishResult | { ok: false; error: "device_not_found" }> {
  const identity = Buffer.from(input.keys.identityKey,"base64url");
  if (!verifyingKey(identity)) return { ok: false,error: "invalid_identity_key" };
  if (!verifyPrekeySignature(input.keys.identityKey,publicId("dev",input.deviceId),input.keys.prekey)) {
    return { ok: false,error: "invalid_prekey_signature" };
  }
  const now = input.now ?? new Date();
  const created = Date.parse(input.keys.prekey.createdAt);
  if (created > now.getTime() + 10 * 60_000 || created < now.getTime() - PREKEY_STALE_AFTER_MS) {
    return { ok: false,error: "prekey_clock_skew" };
  }
  const keyId = e2eeKeyId(identity);
  const prekey = input.keys.prekey;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const device = await client.query(
      "SELECT 1 FROM devices WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL FOR UPDATE",
      [input.deviceId,input.principalId],
    );
    if (!device.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false,error: "device_not_found" };
    }
    const previous = await client.query<{ public_key: string }>(
      "SELECT public_key FROM device_identity_keys WHERE device_id=$1",[input.deviceId],
    );
    const identityChanged = previous.rows[0] !== undefined && previous.rows[0].public_key !== input.keys.identityKey;
    if (identityChanged) {
      // A new identity invalidates every prekey it did not sign; CLIs see an untrusted key and stop.
      await client.query("DELETE FROM device_prekeys WHERE device_id=$1",[input.deviceId]);
    }
    await client.query(
      `INSERT INTO device_identity_keys(device_id,principal_id,key_id,public_key)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (device_id) DO UPDATE SET key_id=EXCLUDED.key_id,public_key=EXCLUDED.public_key,
         changed_at=CASE WHEN device_identity_keys.public_key=EXCLUDED.public_key
           THEN device_identity_keys.changed_at ELSE now() END`,
      [input.deviceId,input.principalId,keyId,input.keys.identityKey],
    );
    const stored = await client.query<{ same: boolean }>(
      `INSERT INTO device_prekeys(device_id,principal_id,prekey_id,public_key,signature,signed_created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (device_id,prekey_id) DO UPDATE SET prekey_id=device_prekeys.prekey_id
       RETURNING (public_key=$4 AND signed_created_at=$6) AS same`,
      [input.deviceId,input.principalId,prekey.prekeyId,prekey.publicKey,prekey.signature,prekey.createdAt],
    );
    if (!stored.rows[0]?.same) {
      await client.query("ROLLBACK");
      return { ok: false,error: "prekey_conflict" };
    }
    await client.query(
      `DELETE FROM device_prekeys WHERE device_id=$1 AND prekey_id NOT IN (
         SELECT prekey_id FROM device_prekeys WHERE device_id=$1
         ORDER BY received_at DESC,prekey_id DESC LIMIT ${PREKEYS_KEPT})`,
      [input.deviceId],
    );
    await client.query("COMMIT");
    return { ok: true,identityChanged,keyId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type DeviceKeyResource = {
  deviceId: string;
  kind: "phone" | "browser";
  name: string;
  identityKey: { keyId: string; publicKey: string; changedAt: string };
  prekey: { prekeyId: string; publicKey: string; createdAt: string; signature: string; stale: boolean } | null;
  /** A browser's link: a phone's signature over its identity key (linked-browsers.ts). */
  link?: { deviceId: string; signedAt: string; signature: string } | null;
};

/** Every active phone of the account that has published keys, newest prekey first. */
export async function listDeviceKeys(
  db: Pick<Database,"query">,
  principalId: string,
  now = new Date(),
): Promise<DeviceKeyResource[]> {
  const result = await db.query<any>(
    `SELECT d.id,d.name,k.key_id,k.public_key AS identity_key,k.changed_at,
       p.prekey_id,p.public_key AS prekey_public_key,p.signature,p.signed_created_at,p.received_at
     FROM devices d
     JOIN device_identity_keys k ON k.device_id=d.id AND k.principal_id=d.principal_id
     LEFT JOIN LATERAL (
       SELECT * FROM device_prekeys p WHERE p.device_id=d.id
       ORDER BY p.received_at DESC,p.prekey_id DESC LIMIT 1
     ) p ON true
     WHERE d.principal_id=$1 AND d.revoked_at IS NULL
     ORDER BY d.registered_at DESC,d.id DESC
     LIMIT 32`,
    [principalId],
  );
  return result.rows.map((row) => ({
    deviceId: publicId("dev",row.id),
    kind: "phone" as const,
    name: row.name,
    identityKey: { keyId: row.key_id,publicKey: row.identity_key,changedAt: new Date(row.changed_at).toISOString() },
    prekey: row.prekey_id ? {
      prekeyId: row.prekey_id,publicKey: row.prekey_public_key,createdAt: row.signed_created_at,signature: row.signature,
      stale: now.getTime() - new Date(row.received_at).getTime() > PREKEY_STALE_AFTER_MS,
    } : null,
  }));
}

// ---- CLI identity keys ----------------------------------------------------------------------

export const publishClientKeySchema = z.object({ identityKey: b64u(65) }).strict();

/** Stores the calling CLI credential's identity key; a different key replaces it and moves changedAt. */
export async function publishClientKey(
  db: Pick<Database,"query">,
  input: { principalId: string; apiKeyId: string; identityKey: string },
): Promise<{ ok: true; keyId: string; changed: boolean } | { ok: false; error: "invalid_identity_key" }> {
  const identity = Buffer.from(input.identityKey,"base64url");
  if (!verifyingKey(identity)) return { ok: false,error: "invalid_identity_key" };
  const keyId = e2eeKeyId(identity);
  const result = await db.query<{ changed: boolean }>(
    `WITH previous AS (SELECT public_key FROM client_identity_keys WHERE api_key_id=$1)
     INSERT INTO client_identity_keys(api_key_id,principal_id,key_id,public_key) VALUES ($1,$2,$3,$4)
     ON CONFLICT (api_key_id) DO UPDATE SET key_id=EXCLUDED.key_id,public_key=EXCLUDED.public_key,
       changed_at=CASE WHEN client_identity_keys.public_key=EXCLUDED.public_key
         THEN client_identity_keys.changed_at ELSE now() END
     RETURNING COALESCE((SELECT public_key FROM previous)<>$4,false) AS changed`,
    [input.apiKeyId,input.principalId,keyId,input.identityKey],
  );
  return { ok: true,keyId,changed: Boolean(result.rows[0]?.changed) };
}

export type ClientKeyResource = { clientId: string; name: string; keyId: string; publicKey: string; changedAt: string };

/** Identity keys of the account's active CLI credentials, for the phone's security screen. */
export async function listClientKeys(db: Pick<Database,"query">,principalId: string): Promise<ClientKeyResource[]> {
  const result = await db.query<any>(
    `SELECT k.id,k.label,c.key_id,c.public_key,c.changed_at
     FROM principal_api_keys k JOIN client_identity_keys c ON c.api_key_id=k.id AND c.principal_id=k.principal_id
     WHERE k.principal_id=$1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())
     ORDER BY c.changed_at DESC,k.id DESC LIMIT 64`,
    [principalId],
  );
  return result.rows.map((row) => ({
    clientId: publicId("key",row.id),name: row.label,keyId: row.key_id,publicKey: row.public_key,
    changedAt: new Date(row.changed_at).toISOString(),
  }));
}
