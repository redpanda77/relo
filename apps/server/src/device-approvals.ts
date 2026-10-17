import { createHash,createPublicKey,verify } from "node:crypto";
import { z } from "zod";
import type { ApnsMode } from "./activities.js";
import type { Database } from "./db.js";
import { friendlyModelName,simulatorSql } from "./device-models.js";
import { ownerOverviewSql } from "./owner-overview.js";
import { internalId,publicId } from "./ids.js";
import { createNotification } from "./notifications/commands.js";
import type { CreateNotificationResult } from "./notifications/types.js";
import { prepareNotificationContent } from "./notification-content.js";
import type { NotificationContentCipher } from "./notification-content.js";
import { purgeUnreadableContent } from "./unreadable-content.js";
import { revokeDeviceCredentials } from "./credentials/device.js";

/**
 * New devices are approved on a trusted phone (docs/ENCRYPTION-PROTOCOL.md). The server lists the
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

export type PendingDevice = {
  deviceId: string; name: string; model: string | null; modelName: string | null; isSimulator: boolean;
  registeredAt: string; keyId: string; identityKey: string;
};

/**
 * The account's phones registered after `callerDeviceId` (or all of them, for the Dashboard) that have
 * published keys and have no approval for their current identity key. A phone never sees itself or an
 * older phone: a new device cannot "decline" the phone that is already trusted.
 *
 * Simulators never vouch for a real phone: a real phone is pending only behind an older real phone,
 * and a simulator caller sees only simulators. An owner overview device (the Mac's notch app) vouches
 * for no device at all: it sees nothing to approve and holds no device back, so the iPhone is never
 * stuck pending behind a Mac.
 */
export async function pendingDevices(db: Pick<Database,"query">,principalId: string,callerDeviceId?: string): Promise<PendingDevice[]> {
  const result = await db.query<any>(
    `SELECT d.id,d.name,d.model,d.registered_at,k.key_id,k.public_key,${simulatorSql("d")} AS simulator
     FROM devices d JOIN device_identity_keys k ON k.device_id=d.id
     LEFT JOIN devices caller ON caller.id=$2::uuid
     WHERE d.principal_id=$1 AND d.revoked_at IS NULL
       AND ($2::uuid IS NULL OR (d.id<>$2::uuid AND d.registered_at>caller.registered_at
         AND (NOT ${simulatorSql("caller")} OR ${simulatorSql("d")}) AND NOT ${ownerOverviewSql("caller")}))
       AND NOT EXISTS (SELECT 1 FROM device_approvals a WHERE a.device_id=d.id AND a.identity_key=k.public_key)
       AND EXISTS (SELECT 1 FROM devices other JOIN device_identity_keys ok ON ok.device_id=other.id
         WHERE other.principal_id=d.principal_id AND other.revoked_at IS NULL AND other.id<>d.id
           AND other.registered_at<d.registered_at
           AND (NOT ${simulatorSql("other")} OR ${simulatorSql("d")}) AND NOT ${ownerOverviewSql("other")})
     ORDER BY d.registered_at DESC LIMIT 16`,
    [principalId,callerDeviceId ?? null],
  );
  return result.rows.map((row) => ({
    deviceId: publicId("dev",row.id),name: row.name,model: row.model ?? null,
    modelName: friendlyModelName(row.model,row.simulator),isSimulator: Boolean(row.simulator),
    registeredAt: new Date(row.registered_at).toISOString(),keyId: row.key_id,identityKey: row.public_key,
  }));
}

/** The signing input a phone or linked browser signs to approve a device (packages/cli/src/crypto/e2ee.mjs). */
export function approveDeviceSigningInput(input: { deviceId: string; identityKey: string; approverDeviceId: string; signedAt: string }): Buffer {
  return Buffer.from(["relo.e2e.v1 approve-device",input.deviceId,input.identityKey,input.approverDeviceId,input.signedAt].join("\n"));
}

/** Verifies a raw r||s ECDSA P-256 signature against a b64u X9.63 public key. */
export function verifyP256(identityKey: string,message: Buffer,signature: string): boolean {
  const raw = Buffer.from(identityKey,"base64url");
  if (raw.length !== 65 || raw[0] !== 0x04) return false;
  try {
    const key = createPublicKey({ format: "jwk",key: { kty: "EC",crv: "P-256",
      x: raw.subarray(1,33).toString("base64url"),y: raw.subarray(33).toString("base64url") } });
    return verify("sha256",message,{ key,dsaEncoding: "ieee-p1363" },Buffer.from(signature,"base64url"));
  } catch {
    return false;
  }
}

export async function approveDevice(
  db: Pick<Database,"query">,principalId: string,callerDeviceId: string,input: ApproveDevice,
): Promise<{ ok: true } | { ok: false; error: "device_not_found" | "identity_mismatch" }> {
  const target = internalId("dev",input.deviceId);
  if (!target || target === callerDeviceId) return { ok: false,error: "device_not_found" };
  const current = await db.query<{ public_key: string; refused: boolean }>(
    `SELECT k.public_key,(${simulatorSql("caller")} AND NOT ${simulatorSql("d")} OR ${ownerOverviewSql("caller")}) AS refused
     FROM devices d JOIN device_identity_keys k ON k.device_id=d.id JOIN devices caller ON caller.id=$3
     WHERE d.id=$1 AND d.principal_id=$2 AND d.revoked_at IS NULL`,[target,principalId,callerDeviceId]);
  // A simulator never approves a real phone; an overview device approves nothing.
  if (!current.rows[0] || current.rows[0].refused) return { ok: false,error: "device_not_found" };
  if (current.rows[0].public_key !== input.identityKey) return { ok: false,error: "identity_mismatch" };
  await db.query(
    `INSERT INTO device_approvals(device_id,principal_id,identity_key,approved_by_device,signed_at,signature)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (device_id) DO UPDATE SET identity_key=EXCLUDED.identity_key,approved_by_device=EXCLUDED.approved_by_device,
       approved_by_browser=NULL,signed_at=EXCLUDED.signed_at,signature=EXCLUDED.signature,approved_at=now()`,
    [target,principalId,input.identityKey,callerDeviceId,input.signedAt,input.signature],
  );
  return { ok: true };
}

export const browserApprovalSchema = z.object({
  browserId: z.string().regex(/^brw_[0-9a-f-]{36}$/),
  identityKey: b64u(65),
  signedAt: z.iso.datetime(),
  signature: b64u(64),
  /** A fresh code from the authenticator app, when the account has two-step sign-in. */
  code: z.string().trim().regex(/^\d{6}$/).optional(),
}).strict();
export type BrowserApproval = z.infer<typeof browserApprovalSchema>;

/** A browser's link counts this long after the phone signed it (packages/cli/src/crypto/trust.mjs, LINK_DAYS). */
export const BROWSER_LINK_DAYS = 14;
const SIGNED_AT_SKEW_MS = 10 * 60_000;

export type BrowserApprovalError =
  | "device_not_found" | "identity_mismatch" | "already_approved" | "browser_not_linked" | "invalid_signature";

/**
 * A linked browser approves a pending phone (docs/ENCRYPTION-PROTOCOL.md, "Approving from a linked
 * browser"). The browser's own non-extractable identity key signs the same input a phone signs, with
 * the browser's id as the approver; the server checks the signature against the browser's published
 * key so only that browser can approve, and computers check it again against the browser they trust.
 */
export async function approveDeviceFromBrowser(
  db: Pick<Database,"query">,principalId: string,deviceId: string,input: BrowserApproval,now = new Date(),
): Promise<{ ok: true } | { ok: false; error: BrowserApprovalError }> {
  // The phone first: another account's device answers like a missing one.
  const pending = (await pendingDevices(db,principalId)).find((device) => device.deviceId === deviceId);
  if (!pending) {
    const target = internalId("dev",deviceId);
    const known = target ? await db.query<{ approved: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM device_approvals a WHERE a.device_id=d.id AND a.identity_key=k.public_key) AS approved
       FROM devices d JOIN device_identity_keys k ON k.device_id=d.id WHERE d.id=$1 AND d.principal_id=$2 AND d.revoked_at IS NULL`,
      [target,principalId]) : null;
    return { ok: false,error: known?.rows[0]?.approved ? "already_approved" : "device_not_found" };
  }
  const browser = internalId("brw",input.browserId);
  if (!browser) return { ok: false,error: "browser_not_linked" };
  const linked = await db.query<{ identity_key: string; link_signed_at: string; linker_simulator: boolean }>(
    `SELECT b.identity_key,b.link_signed_at,${simulatorSql("phone")} AS linker_simulator
     FROM linked_browsers b JOIN devices phone ON phone.id=b.linked_by_device AND phone.revoked_at IS NULL
     WHERE b.id=$1 AND b.principal_id=$2 AND b.revoked_at IS NULL AND b.linked_at IS NOT NULL AND b.link_signature IS NOT NULL`,
    [browser,principalId]);
  const link = linked.rows[0];
  const linkAge = link ? now.getTime() - Date.parse(link.link_signed_at) : Number.NaN;
  if (!link || !(linkAge < BROWSER_LINK_DAYS * 86_400_000)) return { ok: false,error: "browser_not_linked" };
  // A browser linked from a simulator is no better than the simulator: it never approves a real phone.
  if (link.linker_simulator && !pending.isSimulator) return { ok: false,error: "browser_not_linked" };
  if (pending.identityKey !== input.identityKey) return { ok: false,error: "identity_mismatch" };
  const signedAt = Date.parse(input.signedAt);
  if (Math.abs(now.getTime() - signedAt) > SIGNED_AT_SKEW_MS) return { ok: false,error: "invalid_signature" };
  const message = approveDeviceSigningInput({ deviceId,identityKey: input.identityKey,approverDeviceId: input.browserId,signedAt: input.signedAt });
  if (!verifyP256(link.identity_key,message,input.signature)) return { ok: false,error: "invalid_signature" };
  await db.query(
    `INSERT INTO device_approvals(device_id,principal_id,identity_key,approved_by_device,approved_by_browser,signed_at,signature)
     VALUES ($1,$2,$3,NULL,$4,$5,$6)
     ON CONFLICT (device_id) DO UPDATE SET identity_key=EXCLUDED.identity_key,approved_by_device=NULL,
       approved_by_browser=EXCLUDED.approved_by_browser,signed_at=EXCLUDED.signed_at,signature=EXCLUDED.signature,approved_at=now()`,
    [internalId("dev",deviceId),principalId,input.identityKey,browser,input.signedAt,input.signature],
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
    await revokeDeviceCredentials(client,target);
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
 * access"), opening Devices. Only the device's name and time; nothing sealed is involved.
 */
export async function requestDeviceApproval(
  db: Database,principalId: string,deviceId: string,apnsMode: ApnsMode,contentCipher: NotificationContentCipher | null,
): Promise<boolean> {
  const pending = await pendingDevices(db,principalId);
  const device = pending.find((entry) => entry.deviceId === publicId("dev",deviceId));
  if (!device) return false;
  // Before the claim: while no older phone can show a notice, the next pass asks again.
  const others = await db.query<{ id: string }>(
    `SELECT d.id FROM devices d JOIN device_identity_keys k ON k.device_id=d.id
     WHERE d.principal_id=$1 AND d.revoked_at IS NULL AND d.id<>$2 AND d.registered_at<(SELECT registered_at FROM devices WHERE id=$2)
       AND NOT ${simulatorSql("d")} AND ${notifiableSql("d")}`,
    [principalId,deviceId]);
  if (!others.rowCount) return false;
  const claimed = await db.query(
    `UPDATE device_identity_keys SET approval_requested_at=now()
     WHERE device_id=$1 AND public_key=$2 AND approval_requested_at IS NULL`,[deviceId,device.identityKey]);
  if (!claimed.rowCount) return false;
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
  noticeSent(await createNotification(db,{ kind: "owner",principalId },{
    idempotencyKey,
    requestHash: createHash("sha256").update(idempotencyKey).digest("hex"),
    sourceName: "Relo",
    title: `${device.modelName ?? "A new device"} wants to read your Relo cards`,
    content: prepareNotificationContent({ body: `“${device.name}” signed in to your Relo account. Approve or decline it in Devices.` }),
    imageUrl: null,deepLink: `relo://security/request/${device.deviceId}`,
    payload: { deviceApproval: { deviceId: device.deviceId } },
    deviceIds: targets,
    originHash: null,
  },{ apnsMode,contentCipher }));
}

/** A notice the phones can show: notifications allowed. One phone that can't would refuse the whole notice. */
const notifiableSql = (alias: string) => `${alias}.notification_authorization IN ('authorized','provisional')`;

/** A refused notice is a failure, never a silent success: the caller logs it and the claim is released. */
function noticeSent(result: CreateNotificationResult): void {
  if (result.kind !== "created" && result.kind !== "replayed") throw new Error(`approval_notice_not_sent:${result.kind}`);
}

/**
 * A computer's first key on an account that already has one: the phones hold it as pending until the
 * owner approves it in Devices (docs/HARDENING.md, gap 3), so tell them once. The first
 * computer is trusted on first contact and needs no notice.
 */
export async function announceNewComputer(
  db: Database,principalId: string,apiKeyId: string,keyId: string,apnsMode: ApnsMode,contentCipher: NotificationContentCipher | null,
): Promise<boolean> {
  const computer = await db.query<{ label: string; others: boolean }>(
    `SELECT COALESCE(comp.display_name,k.label) AS label,EXISTS (SELECT 1 FROM client_identity_keys c JOIN principal_api_keys o ON o.id=c.api_key_id
       WHERE c.principal_id=$1 AND c.api_key_id<>$2 AND o.revoked_at IS NULL) AS others
     FROM principal_api_keys k LEFT JOIN computers comp ON comp.login_key_id=k.id
     WHERE k.id=$2 AND k.principal_id=$1`,[principalId,apiKeyId]);
  if (!computer.rows[0]?.others) return false;
  const phones = await db.query<{ id: string }>(
    `SELECT d.id FROM devices d JOIN device_identity_keys k ON k.device_id=d.id
     WHERE d.principal_id=$1 AND d.revoked_at IS NULL AND NOT ${simulatorSql("d")} AND ${notifiableSql("d")}`,[principalId]);
  if (!phones.rowCount) return false;
  const idempotencyKey = `computer-approval:${apiKeyId}:${keyId}`;
  noticeSent(await createNotification(db,{ kind: "owner",principalId },{
    idempotencyKey,
    requestHash: createHash("sha256").update(idempotencyKey).digest("hex"),
    sourceName: "Relo",
    title: "New computer wants access",
    content: prepareNotificationContent({ body: `“${computer.rows[0].label}” signed in to your Relo account. Approve or decline it in Devices.` }),
    imageUrl: null,deepLink: `relo://security/request/${publicId("key",apiKeyId)}`,
    payload: { computerApproval: { clientId: publicId("key",apiKeyId) } },
    deviceIds: phones.rows.map((row) => row.id),
    originHash: null,
  },{ apnsMode,contentCipher }));
  return true;
}

/**
 * A browser asked for approval (docs/ENCRYPTION-PROTOCOL.md, "Linking (approval on the iPhone)"): tell the
 * trusted phones. Returns how many phones got the notice; 0 means none could show it. The notice has no
 * Approve action: the owner must compare the link code first.
 */
export async function announceBrowserLinkRequest(
  db: Database,principalId: string,browser: { id: string; name: string; requestedAt: Date },
  apnsMode: ApnsMode,contentCipher: NotificationContentCipher | null,
): Promise<number> {
  const waiting = new Set((await pendingDevices(db,principalId)).map((device) => device.deviceId));
  const phones = await db.query<{ id: string }>(
    `SELECT d.id FROM devices d JOIN device_identity_keys k ON k.device_id=d.id
     WHERE d.principal_id=$1 AND d.revoked_at IS NULL AND NOT ${simulatorSql("d")} AND ${notifiableSql("d")}`,[principalId]);
  const targets = phones.rows.map((row) => row.id).filter((id) => !waiting.has(publicId("dev",id)));
  if (!targets.length) return 0;
  const browserId = publicId("brw",browser.id);
  const idempotencyKey = `browser-link:${browser.id}:${browser.requestedAt.getTime()}`;
  noticeSent(await createNotification(db,{ kind: "owner",principalId },{
    idempotencyKey,
    requestHash: createHash("sha256").update(idempotencyKey).digest("hex"),
    sourceName: "Relo",
    title: `${browser.name} wants to read your Relo cards`,
    content: prepareNotificationContent({ body: "Approve it in Devices if the code matches the one in your browser." }),
    imageUrl: null,deepLink: `relo://security/request/${browserId}`,
    payload: { browserLink: { browserId } },
    deviceIds: targets,
    originHash: null,
  },{ apnsMode,contentCipher }));
  return targets.length;
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
