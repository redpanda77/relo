import type { Database } from "../db.js";
import { plainDigest } from "./hash.js";

type Queryable = Pick<Database,"query">;

/**
 * Phone credentials (kind "device", `device_credentials`): one active credential per registered phone, its
 * token derived at registration (mobile-auth). Only this module writes their token and revocation columns
 * (plan 10 M1); the `devices` row itself stays with the device modules.
 */

export type DeviceCredentialRow = {
  credential_id: string; expires_at: Date | null; principal_id: string; device_id: string; credential_version: number; scopes: string[];
  /** The phone's declared capabilities (schemas.ts DEVICE_CAPABILITIES), read once per request. */
  capabilities: string[];
};

/** The active credential a token belongs to, on an active phone of an account that still has access. */
export async function findDeviceCredential(db: Queryable,token: string): Promise<DeviceCredentialRow | undefined> {
  const result = await db.query<DeviceCredentialRow>(
    `SELECT c.id AS credential_id,c.expires_at,d.principal_id, d.id AS device_id, d.credential_version, c.scopes, d.capabilities
     FROM device_credentials c
     JOIN devices d ON d.id = c.device_id
     JOIN owner_principals p ON p.id = d.principal_id
     WHERE c.token_hash = $1 AND c.revoked_at IS NULL
       AND (c.expires_at IS NULL OR c.expires_at > now())
       AND d.revoked_at IS NULL AND p.disabled_at IS NULL`,
    [plainDigest(token)],
  );
  return result.rows[0];
}

/** A phone (re)registered: its earlier credentials end and the new token is the only one. In the caller's transaction. */
export async function issueDeviceCredential(client: Queryable,deviceId: string,token: string): Promise<void> {
  await revokeDeviceCredentials(client,deviceId);
  await client.query("INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)",[deviceId,plainDigest(token)]);
}

/** Ends every credential of one phone (signing out, declining, the owner revoking it). Idempotent. */
export async function revokeDeviceCredentials(client: Queryable,deviceId: string): Promise<void> {
  await client.query("UPDATE device_credentials SET revoked_at=now() WHERE device_id=$1 AND revoked_at IS NULL",[deviceId]);
}

/** Ends the credentials of every phone a person registered (their account access was disabled or signed out). */
export async function revokeDeviceCredentialsRegisteredBy(client: Queryable,principalId: string,subject: string): Promise<void> {
  await client.query(`UPDATE device_credentials c SET revoked_at=now()
    FROM devices d WHERE c.device_id=d.id AND d.principal_id=$1
      AND d.registered_by_subject=$2 AND c.revoked_at IS NULL`,[principalId,subject]);
}
