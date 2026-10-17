import { z } from "zod";
import type { Database } from "./db.js";
import { BROWSER_LINK_DAYS,verifyP256 } from "./device-approvals.js";
import { simulatorSql } from "./device-models.js";
import { wakeAccountStreams } from "./computer-invites.js";
import { internalId,publicId } from "./ids.js";
import { ownerOverviewSql } from "./owner-overview.js";

/**
 * Computers are approved once, on any trusted device (docs/ENCRYPTION-PROTOCOL.md): a phone, the Mac app or a
 * linked browser signs a computer's login id and current identity key. The server checks that the approver is the
 * account's and that its signature verifies, stores it, and lists it with the computer's key; it never decides trust.
 * Every device verifies the signatures against the approvers it pinned, so an approval made on one device counts on
 * all of them, and the server cannot forge one.
 */
const b64u = (length: number) => z.string().regex(/^[A-Za-z0-9_-]+$/).refine(
  (value) => Buffer.from(value,"base64url").toString("base64url") === value && Buffer.from(value,"base64url").length === length,
  "invalid_encoding",
);

export const approveComputerSchema = z.object({
  clientId: z.string().regex(/^key_[0-9a-f-]{36}$/),
  identityKey: b64u(65),
  signedAt: z.iso.datetime(),
  signature: b64u(64),
}).strict();
export type ApproveComputer = z.infer<typeof approveComputerSchema>;

export const browserComputerApprovalSchema = approveComputerSchema.omit({ clientId: true }).extend({
  browserId: z.string().regex(/^brw_[0-9a-f-]{36}$/),
}).strict();
export type BrowserComputerApproval = z.infer<typeof browserComputerApprovalSchema>;

/** The bytes an approver's identity key signs (ReloCore ReloComputerApproval; the Dashboard's envelope.ts). */
export function approveComputerSigningInput(input: { clientId: string; identityKey: string; approverId: string; signedAt: string }): Buffer {
  return Buffer.from(["relo.e2e.v1 approve-computer",input.clientId,input.identityKey,input.approverId,input.signedAt].join("\n"));
}

export type ComputerApprovalError = "computer_not_found" | "identity_mismatch" | "approver_not_allowed" | "invalid_signature";
export type ComputerApprover = { deviceId: string } | { browserId: string };

const SIGNED_AT_SKEW_MS = 10 * 60_000;

/** The approver's current identity key, or null when it may not approve (another account, simulator, unlinked browser). */
async function approverKey(db: Pick<Database,"query">,principalId: string,approver: ComputerApprover,now: Date): Promise<string | null> {
  if ("deviceId" in approver) {
    const result = await db.query<{ public_key: string }>(
      `SELECT k.public_key FROM devices d JOIN device_identity_keys k ON k.device_id=d.id
       WHERE d.id=$1 AND d.principal_id=$2 AND d.revoked_at IS NULL AND NOT ${simulatorSql("d")}`,[approver.deviceId,principalId]);
    return result.rows[0]?.public_key ?? null;
  }
  const browser = internalId("brw",approver.browserId);
  if (!browser) return null;
  const result = await db.query<{ identity_key: string; link_signed_at: string }>(
    `SELECT b.identity_key,b.link_signed_at FROM linked_browsers b
     JOIN devices phone ON phone.id=b.linked_by_device AND phone.revoked_at IS NULL AND NOT ${simulatorSql("phone")}
     WHERE b.id=$1 AND b.principal_id=$2 AND b.revoked_at IS NULL AND b.linked_at IS NOT NULL AND b.link_signature IS NOT NULL`,
    [browser,principalId]);
  const row = result.rows[0];
  const age = row ? now.getTime() - Date.parse(row.link_signed_at) : Number.NaN;
  return row && age < BROWSER_LINK_DAYS * 86_400_000 ? row.identity_key : null;
}

/**
 * Stores an approval of the account's computer `clientId` for its current identity key, signed by `approver`.
 * Approving the same key again replaces that approver's earlier signature.
 */
export async function approveComputer(
  db: Pick<Database,"query">,principalId: string,approver: ComputerApprover,input: ApproveComputer,now = new Date(),
): Promise<{ ok: true } | { ok: false; error: ComputerApprovalError }> {
  const computer = internalId("key",input.clientId);
  if (!computer) return { ok: false,error: "computer_not_found" };
  const current = await db.query<{ public_key: string }>(
    `SELECT c.public_key FROM client_identity_keys c JOIN principal_api_keys k ON k.id=c.api_key_id
     WHERE c.api_key_id=$1 AND c.principal_id=$2 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())`,
    [computer,principalId]);
  if (!current.rows[0]) return { ok: false,error: "computer_not_found" };
  if (current.rows[0].public_key !== input.identityKey) return { ok: false,error: "identity_mismatch" };
  const key = await approverKey(db,principalId,approver,now);
  if (!key) return { ok: false,error: "approver_not_allowed" };
  if (Math.abs(now.getTime() - Date.parse(input.signedAt)) > SIGNED_AT_SKEW_MS) return { ok: false,error: "invalid_signature" };
  const approverId = "deviceId" in approver ? publicId("dev",approver.deviceId) : approver.browserId;
  const message = approveComputerSigningInput({ clientId: input.clientId,identityKey: input.identityKey,approverId,signedAt: input.signedAt });
  if (!verifyP256(key,message,input.signature)) return { ok: false,error: "invalid_signature" };
  const [byDevice,byBrowser] = "deviceId" in approver ? [approver.deviceId,null] : [null,internalId("brw",approver.browserId)];
  await db.query(
    `DELETE FROM computer_approvals WHERE api_key_id=$1 AND identity_key=$2
       AND approved_by_device IS NOT DISTINCT FROM $3::uuid AND approved_by_browser IS NOT DISTINCT FROM $4::uuid`,
    [computer,input.identityKey,byDevice,byBrowser]);
  await db.query(
    `INSERT INTO computer_approvals(api_key_id,principal_id,identity_key,approved_by_device,approved_by_browser,signed_at,signature)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [computer,principalId,input.identityKey,byDevice,byBrowser,input.signedAt,input.signature]);
  // The Connect a computer wizard waits on this ("Approve it on your iPhone"): wake the account's live streams.
  await wakeAccountStreams(db,principalId);
  return { ok: true };
}

export type ComputerApprovalResource = { approverId: string; signedAt: string; signature: string };

/** Login id → the approvals that cover its computer's current identity key (from approvers still on the account). */
export async function computerApprovals(db: Pick<Database,"query">,principalId: string): Promise<Map<string,ComputerApprovalResource[]>> {
  const result = await db.query<any>(
    `SELECT a.api_key_id,a.approved_by_device,a.approved_by_browser,a.signed_at,a.signature
     FROM computer_approvals a JOIN client_identity_keys c ON c.api_key_id=a.api_key_id AND c.public_key=a.identity_key
     LEFT JOIN devices d ON d.id=a.approved_by_device AND d.revoked_at IS NULL
     LEFT JOIN linked_browsers b ON b.id=a.approved_by_browser AND b.revoked_at IS NULL
     WHERE a.principal_id=$1 AND (d.id IS NOT NULL OR b.id IS NOT NULL)
     ORDER BY a.approved_at`,[principalId]);
  const approvals = new Map<string,ComputerApprovalResource[]>();
  for (const row of result.rows) {
    const clientId = publicId("key",row.api_key_id);
    const approverId = row.approved_by_device ? publicId("dev",row.approved_by_device) : publicId("brw",row.approved_by_browser);
    approvals.set(clientId,[...(approvals.get(clientId) ?? []),{ approverId,signedAt: row.signed_at,signature: row.signature }]);
  }
  return approvals;
}

export type ApproverResource = {
  id: string; kind: "phone" | "mac" | "browser"; name: string; identityKey: string;
  vouchedBy: { approverId: string; signedAt: string; signature: string; statement: "approve-device" | "link" } | null;
};

/**
 * Who can approve on this account, with what vouches for each one's current key: a device's approval (by a phone or
 * a linked browser), or a browser's link (by a phone). Simulators approve nothing and are not listed.
 */
export async function listApprovers(db: Pick<Database,"query">,principalId: string): Promise<ApproverResource[]> {
  const [devices,browsers] = await Promise.all([
    db.query<any>(
      `SELECT d.id,d.name,k.public_key,${ownerOverviewSql("d")} AS mac,
         a.approved_by_device,a.approved_by_browser,a.signed_at,a.signature
       FROM devices d JOIN device_identity_keys k ON k.device_id=d.id
       LEFT JOIN device_approvals a ON a.device_id=d.id AND a.identity_key=k.public_key
       WHERE d.principal_id=$1 AND d.revoked_at IS NULL AND NOT ${simulatorSql("d")}
       ORDER BY d.registered_at LIMIT 32`,[principalId]),
    db.query<any>(
      `SELECT b.id,b.name,b.identity_key,b.linked_by_device,b.link_signed_at,b.link_signature
       FROM linked_browsers b JOIN devices phone ON phone.id=b.linked_by_device AND phone.revoked_at IS NULL
       WHERE b.principal_id=$1 AND b.revoked_at IS NULL AND b.linked_at IS NOT NULL AND b.link_signature IS NOT NULL
       ORDER BY b.linked_at LIMIT 8`,[principalId]),
  ]);
  return [
    ...devices.rows.map((row): ApproverResource => ({
      id: publicId("dev",row.id),kind: row.mac ? "mac" : "phone",name: row.name,identityKey: row.public_key,
      vouchedBy: row.signature ? {
        approverId: row.approved_by_device ? publicId("dev",row.approved_by_device) : publicId("brw",row.approved_by_browser),
        signedAt: row.signed_at,signature: row.signature,statement: "approve-device",
      } : null,
    })),
    ...browsers.rows.map((row): ApproverResource => ({
      id: publicId("brw",row.id),kind: "browser",name: row.name,identityKey: row.identity_key,
      vouchedBy: { approverId: publicId("dev",row.linked_by_device),signedAt: row.link_signed_at,signature: row.link_signature,statement: "link" },
    })),
  ];
}
