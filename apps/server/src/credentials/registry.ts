import type { Database } from "../db.js";
import { findDeviceCredential } from "./device.js";
import type { CredentialKind } from "@relo/notification-contracts";
import { findHarnessCredential,rotateHarnessCredential } from "./harness.js";
import { kindFacts } from "./kinds.js";
import { loginDigests,machineDigest,plainDigest } from "./hash.js";
import { findLogin,rotateCiToken } from "./login.js";
import { rotateService } from "./service.js";
import { touch } from "./touch.js";

type Queryable = Pick<Database,"query">;

/**
 * Which credential a bearer token is (plan 10 M1). A `relo_` token is a login, a phone or a computer's hooks,
 * tried in that order; webhook secrets never come here (they travel in their own header to /hooks).
 */
export type Authenticated =
  | { kind: "login"; login: NonNullable<Awaited<ReturnType<typeof findLogin>>> }
  | { kind: "device"; device: NonNullable<Awaited<ReturnType<typeof findDeviceCredential>>> }
  | { kind: "harness"; harness: NonNullable<Awaited<ReturnType<typeof findHarnessCredential>>> };

export async function authenticate(db: Queryable,token: string): Promise<Authenticated | undefined> {
  const login = await findLogin(db,token);
  if (login) {
    await touch(db,"login",login.id);
    return { kind: "login",login };
  }
  const device = await findDeviceCredential(db,token);
  if (device) {
    await touch(db,"device",device.credential_id);
    return { kind: "device",device };
  }
  const harness = await findHarnessCredential(db,token);
  if (harness) {
    await touch(db,"harness",harness.id);
    return { kind: "harness",harness };
  }
  return undefined;
}

/**
 * Why a credential that was once valid no longer works, so an app knows whether signing in again
 * can help. Only the token's holder learns this; an unknown token stays plain "unauthorized".
 */
export async function refusal(db: Queryable,token: string): Promise<{ error: string; message?: string }> {
  const found = await db.query<{ disabled: boolean; revoked: boolean; expired: boolean }>(
    `SELECT p.disabled_at IS NOT NULL AS disabled,k.revoked_at IS NOT NULL AS revoked,
       (k.expires_at IS NOT NULL AND k.expires_at<=now()) AS expired
     FROM principal_api_keys k JOIN owner_principals p ON p.id=k.principal_id WHERE k.token_hash=ANY($1::text[])
     UNION ALL
     SELECT p.disabled_at IS NOT NULL,(c.revoked_at IS NOT NULL OR d.revoked_at IS NOT NULL),
       (c.expires_at IS NOT NULL AND c.expires_at<=now())
     FROM device_credentials c JOIN devices d ON d.id=c.device_id JOIN owner_principals p ON p.id=d.principal_id
     WHERE c.token_hash=$2
     UNION ALL
     SELECT p.disabled_at IS NOT NULL,h.revoked_at IS NOT NULL,false
     FROM harness_credentials h JOIN owner_principals p ON p.id=h.principal_id WHERE h.token_hash=$3
     LIMIT 1`,
    [loginDigests(token),plainDigest(token),machineDigest(token)],
  );
  const row = found.rows[0];
  if (!row) return { error: "unauthorized" };
  if (row.disabled) return { error: "account_disabled",message: "The server admin turned off this account's access." };
  if (row.revoked) return { error: "credential_revoked",message: "This login was revoked." };
  if (row.expired) return { error: "login_expired",message: "This login expired." };
  return { error: "unauthorized" };
}

/**
 * A rotation (plan 10 M1.2): a new token for the same credential, the old one dead at once. `id` is the stored
 * (internal) id for ci-token and service, the public `hck_…` id for a harness credential. The kinds table says
 * which kinds rotate: a login signs in again and a phone registers again, so those are refused, never guessed.
 */
export type Rotated =
  | { kind: "ci-token"; token: string; row: any }
  | { kind: "harness"; token: string; id: string }
  | { kind: "service"; secret: string; row: any };
export type RotationRefusal = "not_rotatable" | "not_found";

export async function rotateCredential(db: Queryable,kind: CredentialKind,principalId: string,id: string): Promise<Rotated | RotationRefusal> {
  if (!kindFacts(kind).rotation.rotatable) return "not_rotatable";
  switch (kind) {
    case "ci-token": {
      const rotated = await rotateCiToken(db,principalId,id);
      return rotated ? { kind,...rotated } : "not_found";
    }
    case "harness": {
      const rotated = await rotateHarnessCredential(db,principalId,id);
      return rotated ? { kind,...rotated } : "not_found";
    }
    case "service": {
      const rotated = await rotateService(db,principalId,id);
      return rotated ? { kind,...rotated } : "not_found";
    }
    default:
      return "not_rotatable";
  }
}
