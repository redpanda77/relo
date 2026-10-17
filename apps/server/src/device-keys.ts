import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { computerApprovals,type ComputerApprovalResource } from "./computer-approvals.js";
import { computerIconColumns,iconFromColumns } from "./computers/store.js";
import type { Database } from "./db.js";
import type { ComputerIcon } from "@relo/notification-contracts";
import { simulatorSql } from "./device-models.js";
import { publicId } from "./ids.js";

/**
 * Key directory for end-to-end encryption (docs/ENCRYPTION-PROTOCOL.md, E2.2).
 * Phones publish an identity key and signed prekeys; CLIs read them and decide trust themselves.
 * The signing input and key id match packages/cli/src/crypto/e2ee.mjs and ReloE2EE.swift, pinned by
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
  /** A phone's approval: another phone's signature over its id and current identity key. */
  approval?: { deviceId: string; signedAt: string; signature: string } | null;
  /** True for a phone running in the iOS Simulator (never for a browser). */
  simulator?: boolean;
  /**
   * What the device declared (schemas.ts DEVICE_CAPABILITIES). Computers seal to an `owner_overview`
   * device as a reader only: it gets the content envelope, never an alert, and is never a target.
   */
  capabilities?: string[];
};

/** Every active phone of the account that has published keys, newest prekey first. */
export async function listDeviceKeys(
  db: Pick<Database,"query">,
  principalId: string,
  now = new Date(),
): Promise<DeviceKeyResource[]> {
  const result = await db.query<any>(
    `SELECT d.id,d.name,k.key_id,k.public_key AS identity_key,k.changed_at,
       p.prekey_id,p.public_key AS prekey_public_key,p.signature,p.signed_created_at,p.received_at,
       ${simulatorSql("d")} AS simulator,d.capabilities,
       approval.approved_by_device,approval.approved_by_browser,approval.signed_at AS approval_signed_at,approval.signature AS approval_signature
     FROM devices d
     JOIN device_identity_keys k ON k.device_id=d.id AND k.principal_id=d.principal_id
     LEFT JOIN device_approvals approval ON approval.device_id=d.id AND approval.identity_key=k.public_key
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
    // A trusted phone's (or linked browser's) signature approving this phone's current key; computers verify it.
    approval: (row.approved_by_device || row.approved_by_browser) && row.approval_signature ? {
      deviceId: row.approved_by_device ? publicId("dev",row.approved_by_device) : publicId("brw",row.approved_by_browser),
      signedAt: row.approval_signed_at,signature: row.approval_signature,
    } : null,
    simulator: Boolean(row.simulator),
    capabilities: Array.isArray(row.capabilities) ? [...row.capabilities].sort() : [],
  }));
}

// ---- CLI identity keys ----------------------------------------------------------------------

export const publishClientKeySchema = z.object({ identityKey: b64u(65),binding: b64u(32).optional() }).strict();

/** Stores the calling CLI credential's identity key; a different key replaces it and moves changedAt. */
export async function publishClientKey(
  db: Pick<Database,"query">,
  input: { principalId: string; apiKeyId: string; identityKey: string; binding?: string | undefined },
): Promise<{ ok: true; keyId: string; changed: boolean; created: boolean } | { ok: false; error: "invalid_identity_key" }> {
  const identity = Buffer.from(input.identityKey,"base64url");
  if (!verifyingKey(identity)) return { ok: false,error: "invalid_identity_key" };
  const keyId = e2eeKeyId(identity);
  const result = await db.query<{ changed: boolean; created: boolean }>(
    `WITH previous AS (SELECT public_key FROM client_identity_keys WHERE api_key_id=$1)
     INSERT INTO client_identity_keys(api_key_id,principal_id,key_id,public_key,binding) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (api_key_id) DO UPDATE SET key_id=EXCLUDED.key_id,public_key=EXCLUDED.public_key,
       binding=CASE WHEN client_identity_keys.public_key=EXCLUDED.public_key THEN client_identity_keys.binding ELSE EXCLUDED.binding END,
       changed_at=CASE WHEN client_identity_keys.public_key=EXCLUDED.public_key
         THEN client_identity_keys.changed_at ELSE now() END
     RETURNING COALESCE((SELECT public_key FROM previous)<>$4,false) AS changed,
       NOT EXISTS (SELECT 1 FROM previous) AS created`,
    [input.apiKeyId,input.principalId,keyId,input.identityKey,input.binding ?? null],
  );
  return { ok: true,keyId,changed: Boolean(result.rows[0]?.changed),created: Boolean(result.rows[0]?.created) };
}

export type ClientKeyResource = {
  clientId: string; name: string; keyId: string; publicKey: string; changedAt: string; icon: ComputerIcon;
  /** The join code's binding of this key (b64url HMAC), when it was published with one; the server never checks it. */
  binding: string | null;
  /** Signed approvals of this key by the account's phones, Mac app or linked browsers (computer-approvals.ts). */
  approvals: ComputerApprovalResource[];
};

/** Identity keys of the account's active CLI credentials, for the phone's security screen. */
export async function listClientKeys(db: Pick<Database,"query">,principalId: string): Promise<ClientKeyResource[]> {
  const result = await db.query<any>(
    `SELECT k.id,COALESCE(comp.display_name,k.label) AS label,c.key_id,c.public_key,c.binding,c.changed_at,${computerIconColumns("comp")}
     FROM principal_api_keys k JOIN client_identity_keys c ON c.api_key_id=k.id AND c.principal_id=k.principal_id
     LEFT JOIN computers comp ON comp.login_key_id=k.id
     WHERE k.principal_id=$1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())
     ORDER BY c.changed_at DESC,k.id DESC LIMIT 64`,
    [principalId],
  );
  const approvals = await computerApprovals(db,principalId);
  return result.rows.map((row) => ({
    clientId: publicId("key",row.id),name: row.label,keyId: row.key_id,publicKey: row.public_key,binding: row.binding ?? null,
    changedAt: new Date(row.changed_at).toISOString(),icon: iconFromColumns(row.computer_icon,row.computer_kind).icon,
    approvals: approvals.get(publicId("key",row.id)) ?? [],
  }));
}
