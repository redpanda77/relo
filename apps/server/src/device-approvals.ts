import { createHash } from "node:crypto";
import { z } from "zod";
import type { ApnsMode } from "./activities.js";
import type { Database } from "./db.js";
import { internalId,publicId } from "./ids.js";
import { createNotification } from "./notifications/commands.js";
import { prepareNotificationContent } from "./notification-content.js";
import type { NotificationContentCipher } from "./notification-content.js";
import { purgeUnreadableContent } from "./unreadable-content.js";

/**
 * New devices are approved on a trusted phone (docs/END-TO-END-ENCRYPTION.md). The server lists the
 * account's newer phones that no phone has approved for their current identity key, stores the
 * approving phone's signature, and tells the other phones a device is waiting. It never decides
 * trust: computers check the signature against the phones they already trust.
 */
const b64u = (length: number) => z.string().regex(/^[A-Za-z0-9_-]+$/).refine(
  (value) => Buffer.from(value,"base64url").toString("base64url") === value && Buffer.from(value,"base64url").length === length,
  "invalid_encoding",
);

export const approveDeviceSchema = z.object({
  deviceId: z.string().regex(/^dev_[0-9a-f-]{36}$/),
  identityKey: b64u(65),
  signedAt: z.iso.datetime(),
  signature: b64u(64),
}).strict();
export type ApproveDevice = z.infer<typeof approveDeviceSchema>;

export type PendingDevice = { deviceId: string; name: string; model: string | null; registeredAt: string; keyId: string; identityKey: string };

/**
 * The account's phones registered after `callerDeviceId` (or all of them, for the Dashboard) that have
 * published keys and have no approval for their current identity key. A phone never sees itself or an
 * older phone: a new device cannot "decline" the phone that is already trusted.
 */
export async function pendingDevices(db: Pick<Database,"query">,principalId: string,callerDeviceId?: string): Promise<PendingDevice[]> {
  const result = await db.query<any>(
    `SELECT d.id,d.name,d.model,d.registered_at,k.key_id,k.public_key
     FROM devices d JOIN device_identity_keys k ON k.device_id=d.id
     LEFT JOIN devices caller ON caller.id=$2::uuid
     WHERE d.principal_id=$1 AND d.revoked_at IS NULL
       AND ($2::uuid IS NULL OR (d.id<>$2::uuid AND d.registered_at>caller.registered_at))
       AND NOT EXISTS (SELECT 1 FROM device_approvals a WHERE a.device_id=d.id AND a.identity_key=k.public_key)
       AND EXISTS (SELECT 1 FROM devices other JOIN device_identity_keys ok ON ok.device_id=other.id
         WHERE other.principal_id=d.principal_id AND other.revoked_at IS NULL AND other.id<>d.id
           AND other.registered_at<d.registered_at)
     ORDER BY d.registered_at DESC LIMIT 16`,
    [principalId,callerDeviceId ?? null],
  );
  return result.rows.map((row) => ({
    deviceId: publicId("dev",row.id),name: row.name,model: row.model ?? null,
    registeredAt: new Date(row.registered_at).toISOString(),keyId: row.key_id,identityKey: row.public_key,
  }));
}

export async function approveDevice(
  db: Pick<Database,"query">,principalId: string,callerDeviceId: string,input: ApproveDevice,
): Promise<{ ok: true } | { ok: false; error: "device_not_found" | "identity_mismatch" }> {
  const target = internalId("dev",input.deviceId);
  if (!target || target === callerDeviceId) return { ok: false,error: "device_not_found" };
  const current = await db.query<{ public_key: string }>(
    `SELECT k.public_key FROM devices d JOIN device_identity_keys k ON k.device_id=d.id
     WHERE d.id=$1 AND d.principal_id=$2 AND d.revoked_at IS NULL`,[target,principalId]);
  if (!current.rows[0]) return { ok: false,error: "device_not_found" };
  if (current.rows[0].public_key !== input.identityKey) return { ok: false,error: "identity_mismatch" };
  await db.query(
    `INSERT INTO device_approvals(device_id,principal_id,identity_key,approved_by_device,signed_at,signature)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (device_id) DO UPDATE SET identity_key=EXCLUDED.identity_key,approved_by_device=EXCLUDED.approved_by_device,
       signed_at=EXCLUDED.signed_at,signature=EXCLUDED.signature,approved_at=now()`,
    [target,principalId,input.identityKey,callerDeviceId,input.signedAt,input.signature],
  );
  return { ok: true };
}

/** Declining signs the newer device out (only a device the caller would see as pending). */
export async function declineDevice(
  db: Database,principalId: string,callerDeviceId: string,deviceId: string,apnsMode: ApnsMode,
): Promise<boolean> {
  const pending = await pendingDevices(db,principalId,callerDeviceId);
  const target = internalId("dev",deviceId);
  if (!target || !pending.some((device) => device.deviceId === deviceId)) return false;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE device_credentials SET revoked_at=now() WHERE device_id=$1 AND revoked_at IS NULL",[target]);
    await client.query(
      `UPDATE devices SET revoked_at=now(),apns_token=NULL,live_activity_push_to_start_token=NULL,
         credential_version=credential_version+1 WHERE id=$1 AND principal_id=$2`,[target,principalId]);
    await client.query("UPDATE delivery_jobs SET state='canceled',updated_at=now() WHERE device_id=$1 AND state IN ('pending','retry')",[target]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await purgeUnreadableContent(db,principalId,apnsMode);
  return true;
}

/**
 * Once per device and identity key: a plain notice to the account's other phones ("New device wants
 * access"), opening Settings → Security. Only the device's name and time; nothing sealed is involved.
 */
export async function requestDeviceApproval(
  db: Database,principalId: string,deviceId: string,apnsMode: ApnsMode,contentCipher: NotificationContentCipher | null,
): Promise<boolean> {
  const pending = await pendingDevices(db,principalId);
  const device = pending.find((entry) => entry.deviceId === publicId("dev",deviceId));
  if (!device) return false;
  const claimed = await db.query(
    `UPDATE device_identity_keys SET approval_requested_at=now()
     WHERE device_id=$1 AND public_key=$2 AND approval_requested_at IS NULL`,[deviceId,device.identityKey]);
  if (!claimed.rowCount) return false;
  const others = await db.query<{ id: string }>(
    `SELECT d.id FROM devices d JOIN device_identity_keys k ON k.device_id=d.id
     WHERE d.principal_id=$1 AND d.revoked_at IS NULL AND d.id<>$2 AND d.registered_at<(SELECT registered_at FROM devices WHERE id=$2)`,
    [principalId,deviceId]);
  if (!others.rowCount) return false;
  const idempotencyKey = `device-approval:${deviceId}:${device.keyId}`;
  try {
    await sendApprovalNotice(db,principalId,device,others.rows.map((row) => row.id),idempotencyKey,apnsMode,contentCipher);
  } catch (error) {
    // Not sent: the next pass tries again.
    await db.query("UPDATE device_identity_keys SET approval_requested_at=NULL WHERE device_id=$1",[deviceId]);
    throw error;
  }
  return true;
}

async function sendApprovalNotice(
  db: Database,principalId: string,device: PendingDevice,targets: string[],idempotencyKey: string,
  apnsMode: ApnsMode,contentCipher: NotificationContentCipher | null,
): Promise<void> {
  await createNotification(db,{ kind: "owner",principalId },{
    idempotencyKey,
    requestHash: createHash("sha256").update(idempotencyKey).digest("hex"),
    sourceName: "Relo",
    title: "New device wants access",
    content: prepareNotificationContent({ body: `“${device.name}” signed in to your Relo account. Approve or decline it in Settings → Security.` }),
    imageUrl: null,deepLink: "relo://settings/security",
    payload: { deviceApproval: { deviceId: device.deviceId } },
    deviceIds: targets,
    originHash: null,
  },{ apnsMode,contentCipher });
}

/** The worker's pass: devices already waiting before this existed (or whose notice failed) get theirs. */
export async function requestAllPendingApprovals(db: Database,apnsMode: ApnsMode,contentCipher: NotificationContentCipher | null): Promise<number> {
  const waiting = await db.query<{ principal_id: string; device_id: string }>(
    `SELECT d.principal_id,d.id AS device_id FROM device_identity_keys k JOIN devices d ON d.id=k.device_id
     WHERE k.approval_requested_at IS NULL AND d.revoked_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM device_approvals a WHERE a.device_id=d.id AND a.identity_key=k.public_key)
     LIMIT 50`,
  );
  let sent = 0;
  for (const row of waiting.rows) {
    try {
      if (await requestDeviceApproval(db,row.principal_id,row.device_id,apnsMode,contentCipher)) sent += 1;
    } catch (error) {
      console.warn(JSON.stringify({ event: "device_approval_request_failed",message: error instanceof Error ? error.message : String(error) }));
    }
  }
  return sent;
}
