import type { Database } from "./db.js";
import { BROWSER_LINK_DAYS,pendingDevices } from "./device-approvals.js";
import { friendlyModelName,simulatorSql } from "./device-models.js";
import { publicId } from "./ids.js";

/**
 * The Dashboard's Devices page (Account → Security): every phone, computer and browser of the
 * account with what it can do with encrypted content, in one list. The server reports what it
 * stores; computers still decide trust themselves from the signatures.
 *
 * - `can_read`: a phone trusted first or approved for its current key, or a browser a phone linked.
 * - `pending`: a phone waiting for approval on a trusted phone or a linked browser.
 * - `simulator`: an iOS Simulator; it never vouches for a real phone.
 * - `no_keys`: a phone that has not published keys yet, or a computer that never set up encryption.
 * - `unlinked`: a browser no phone linked (or whose link expired); it cannot read encrypted content.
 * - `encrypts`: a computer with an identity key; it seals what it sends.
 */
export type DeviceStatus = "can_read" | "pending" | "simulator" | "no_keys" | "unlinked" | "encrypts";

export type DashboardDevice = {
  id: string;
  kind: "phone" | "computer" | "browser";
  name: string;
  /** Friendly model ("iPhone 17 Pro", "Simulator"), or null. */
  model: string | null;
  /** The identifier the phone reported ("iPhone18,1"), for phones. */
  modelId?: string | null;
  osVersion?: string | null;
  /** A phone that has notifications turned off (it still reads cards when opened). */
  notificationsOff?: boolean;
  status: DeviceStatus;
  addedAt: string;
  lastSeenAt: string | null;
  /** Who approved this phone, or which phone linked this browser. */
  approvedBy?: string | null;
  linkedBy?: string | null;
  /** A pending phone's current identity key and key id: what an approval signs. */
  identityKey?: string;
  keyId?: string;
};

const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);

export async function dashboardDevices(db: Pick<Database,"query">,principalId: string,now = new Date()): Promise<DashboardDevice[]> {
  const [phones,pending,browsers,computers] = await Promise.all([
    db.query<any>(
      `SELECT d.id,d.name,d.model,d.os_version,d.notification_authorization,d.registered_at,d.last_seen_at,${simulatorSql("d")} AS simulator,
         k.public_key IS NOT NULL AS has_keys,approver.name AS approved_by_phone,approver_browser.name AS approved_by_browser
       FROM devices d
       LEFT JOIN device_identity_keys k ON k.device_id=d.id
       LEFT JOIN device_approvals a ON a.device_id=d.id AND a.identity_key=k.public_key
       LEFT JOIN devices approver ON approver.id=a.approved_by_device
       LEFT JOIN linked_browsers approver_browser ON approver_browser.id=a.approved_by_browser
       WHERE d.principal_id=$1 AND d.revoked_at IS NULL
       ORDER BY d.registered_at ASC,d.id ASC LIMIT 64`,[principalId]),
    pendingDevices(db,principalId),
    db.query<any>(
      `SELECT b.id,b.name,b.created_at,b.last_seen_at,b.linked_at,b.link_signed_at,phone.name AS linked_by
       FROM linked_browsers b LEFT JOIN devices phone ON phone.id=b.linked_by_device AND phone.revoked_at IS NULL
       WHERE b.principal_id=$1 AND b.revoked_at IS NULL ORDER BY b.created_at ASC LIMIT 16`,[principalId]),
    db.query<any>(
      `SELECT k.id,k.label,k.created_at,k.last_used_at,c.public_key IS NOT NULL AS has_keys
       FROM principal_api_keys k LEFT JOIN client_identity_keys c ON c.api_key_id=k.id
       WHERE k.principal_id=$1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())
       ORDER BY k.created_at ASC LIMIT 64`,[principalId]),
  ]);
  const waiting = new Map(pending.map((device) => [device.deviceId,device]));
  const linkLimit = BROWSER_LINK_DAYS * 86_400_000;
  return [
    ...phones.rows.map((row): DashboardDevice => {
      const id = publicId("dev",row.id);
      const status: DeviceStatus = row.simulator ? "simulator" : !row.has_keys ? "no_keys" : waiting.has(id) ? "pending" : "can_read";
      return {
        id,kind: "phone",name: row.name,model: friendlyModelName(row.model,row.simulator),modelId: row.model ?? null,
        osVersion: row.os_version ?? null,status,
        notificationsOff: !["authorized","provisional"].includes(row.notification_authorization),addedAt: iso(row.registered_at)!,lastSeenAt: iso(row.last_seen_at),
        approvedBy: row.approved_by_phone ?? row.approved_by_browser ?? null,
        ...(status === "pending" ? { identityKey: waiting.get(id)!.identityKey,keyId: waiting.get(id)!.keyId } : {}),
      };
    }),
    ...computers.rows.map((row): DashboardDevice => ({
      id: publicId("key",row.id),kind: "computer",name: row.label,model: null,
      status: row.has_keys ? "encrypts" : "no_keys",addedAt: iso(row.created_at)!,lastSeenAt: iso(row.last_used_at),
    })),
    ...browsers.rows.map((row): DashboardDevice => {
      const linked = Boolean(row.linked_at && row.linked_by && row.link_signed_at
        && now.getTime() - Date.parse(row.link_signed_at) < linkLimit);
      return {
        id: publicId("brw",row.id),kind: "browser",name: row.name,model: null,status: linked ? "can_read" : "unlinked",
        addedAt: iso(row.created_at)!,lastSeenAt: iso(row.last_seen_at),linkedBy: linked ? row.linked_by : null,
      };
    }),
  ];
}

/** Whether this user has two-step sign-in on (then approving from the Dashboard needs a fresh code). */
export async function twoFactorEnabled(db: Pick<Database,"query">,userId: string): Promise<boolean> {
  const result = await db.query<{ enabled: boolean }>("SELECT two_factor_enabled AS enabled FROM auth.users WHERE id=$1",[userId]);
  return Boolean(result.rows[0]?.enabled);
}

export type AccountPhone = {
  deviceId: string; name: string; model: string | null; isSimulator: boolean | null;
  registeredAt: string; lastSeenAt: string | null; isCurrent: boolean; trusted: boolean;
};

/**
 * The account's phones for the iPhone's Devices screen (`GET /api/devices/self/devices`). `trusted`
 * is what the server stores, not a trust decision: the account's first real phone with keys, or a
 * phone approved (by a phone or a linked browser) for its current identity key.
 */
export async function accountPhones(db: Pick<Database,"query">,principalId: string,callerDeviceId: string): Promise<AccountPhone[]> {
  const result = await db.query<any>(
    `WITH active AS (
       SELECT d.*,${simulatorSql("d")} AS simulator,k.public_key FROM devices d
       LEFT JOIN device_identity_keys k ON k.device_id=d.id
       WHERE d.principal_id=$1 AND d.revoked_at IS NULL
     ), first_real AS (
       SELECT id FROM active WHERE NOT simulator AND public_key IS NOT NULL ORDER BY registered_at ASC,id ASC LIMIT 1
     )
     SELECT a.id,a.name,a.model,a.simulator,a.registered_at,a.last_seen_at,
       a.public_key IS NOT NULL AND (a.id IN (SELECT id FROM first_real) OR EXISTS (
         SELECT 1 FROM device_approvals ap WHERE ap.device_id=a.id AND ap.identity_key=a.public_key
           AND (ap.approved_by_device IS NOT NULL OR ap.approved_by_browser IS NOT NULL))) AS trusted
     FROM active a ORDER BY a.registered_at ASC,a.id ASC LIMIT 64`,[principalId]);
  return result.rows.map((row) => ({
    deviceId: publicId("dev",row.id),name: row.name,model: row.model ?? null,isSimulator: Boolean(row.simulator),
    registeredAt: iso(row.registered_at)!,lastSeenAt: iso(row.last_seen_at),isCurrent: row.id === callerDeviceId,
    trusted: Boolean(row.trusted),
  }));
}
