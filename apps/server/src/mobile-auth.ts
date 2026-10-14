import { createHash, createHmac } from "node:crypto";
import { signInRefusal } from "./server-accounts.js";
import type { Hono } from "hono";
import { z } from "zod";
import type { AccountAuth } from "./account-auth.js";
import { getAccountSession } from "./account-auth.js";
import { hashToken } from "./auth.js";
import type { Database } from "./db.js";
import { publicId } from "./ids.js";
import { registerDeviceSchema } from "./schemas.js";
import { createTransportTokenEncryption } from "./token-encryption.js";
import type { OwnerAccount } from "./web.js";
import { stableJson } from "./stable-json.js";

const mobileAuthorizationState = z.enum(["authorized", "denied", "pending"]);

const mobileRegisterSchema = registerDeviceSchema.omit({
  notificationAuthorization: true,
  liveActivityAuthorization: true,
}).extend({
  notificationAuthorization: mobileAuthorizationState,
  liveActivityAuthorization: mobileAuthorizationState,
  liveActivityPushToStartToken: z.string().min(16).max(512).optional(),
}).strict();

export function persistedMobileAuthorization(value: z.infer<typeof mobileAuthorizationState>): "authorized" | "denied" | "unknown" {
  return value === "pending" ? "unknown" : value;
}

function registrationToken(secret: string, principalId: string, deviceId: string, version: number, idempotencyKey: string): string {
  const material = `relo:device-registration\n${principalId}\n${deviceId}\n${version}\n${idempotencyKey}`;
  return `relo_${createHmac("sha256", secret).update(material).digest("base64url")}`;
}

function requestHash(input: unknown): string {
  return createHash("sha256").update(`relo:device-registration-request\n${stableJson(input)}`).digest("hex");
}

type RegistrationRow = {
  id: string;
  installation_id: string;
  credential_version: number;
  issued_at: Date;
};

type RegistrationReplayRow = RegistrationRow & {
  request_hash: string;
  current_credential_version: number;
  revoked_at: Date | null;
};

function registrationResponse(
  account: OwnerAccount,
  row: RegistrationRow,
  accessToken: string,
) {
  return {
    account: {
      accountId: account.accountId,
      name: account.user.name,
      email: account.user.email,
      imageUrl: account.user.image ?? null,
    },
    device: {
      deviceId: publicId("dev", row.id),
      installationId: row.installation_id,
      registrationState: "active",
      credentialVersion: row.credential_version,
    },
    credential: {
      accessToken,
      issuedAt: row.issued_at.toISOString(),
      expiresAt: null,
    },
  };
}

export function registerMobileAccountRoutes(
  app: Hono,
  db: Database,
  accountAuth: AccountAuth,
  credentialDerivationSecret: string,
): void {
  const tokenEncryption = createTransportTokenEncryption(credentialDerivationSecret);
  app.post("/api/devices/register", async (context) => {
    const session = await getAccountSession(accountAuth, context.req.raw.headers);
    if (!session) return context.json({ error: "reauthentication_required" }, 401);
    const mapped = await db.query<{ principal_id: string; disabled_at: Date | null }>(
      `SELECT i.principal_id,p.disabled_at FROM account_identities i
       JOIN owner_principals p ON p.id=i.principal_id
       WHERE i.provider='better-auth' AND i.subject=$1`, [session.user.id],
    );
    if (!mapped.rowCount) return context.json({ error: "reauthentication_required" }, 401);
    const refusal = await signInRefusal(db,session.user.id);
    if (refusal) return context.json({ error: refusal }, 403);
    const account: OwnerAccount = {
      ...session,
      principalId: mapped.rows[0]!.principal_id,
      accountId: publicId("acc",mapped.rows[0]!.principal_id),
    };
    const idempotencyKey = z.string().trim().min(1).max(200).parse(context.req.header("idempotency-key"));
    const input = mobileRegisterSchema.parse(await context.req.json());
    const digest = requestHash(input);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const replay = await client.query<RegistrationReplayRow>(
        `SELECT i.request_hash,i.device_id AS id,d.installation_id,i.credential_version,i.issued_at,
           d.credential_version AS current_credential_version,d.revoked_at
         FROM device_registration_idempotency i
         JOIN devices d ON d.id=i.device_id
         WHERE i.principal_id=$1 AND i.idempotency_key=$2 FOR UPDATE OF i,d`,
        [account.principalId, idempotencyKey],
      );
      if (replay.rowCount) {
        const row = replay.rows[0]!;
        if (row.request_hash !== digest) {
          await client.query("ROLLBACK");
          return context.json({ error: "idempotency_conflict" }, 409);
        }
        if (row.revoked_at || row.current_credential_version !== row.credential_version) {
          await client.query("ROLLBACK");
          return context.json({ error: "idempotency_conflict" }, 409);
        }
        await client.query("COMMIT");
        const accessToken = registrationToken(credentialDerivationSecret, account.principalId, row.id, row.credential_version, idempotencyKey);
        return context.json(registrationResponse(account, row, accessToken));
      }

      const device = await client.query<RegistrationRow>(
        `INSERT INTO devices (
           principal_id,stable_device_id,installation_id,name,bundle_identifier,
           app_version,app_build,os_version,model,apns_environment,apns_token,
           notification_authorization,live_activity_authorization,
           live_activity_push_to_start_token,credential_version,registered_by_subject,capabilities,is_simulator
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16::text[],$17)
         ON CONFLICT (principal_id,stable_device_id,installation_id) DO UPDATE SET
           name=EXCLUDED.name,bundle_identifier=EXCLUDED.bundle_identifier,
           app_version=EXCLUDED.app_version,app_build=EXCLUDED.app_build,
           os_version=EXCLUDED.os_version,model=EXCLUDED.model,
           apns_environment=EXCLUDED.apns_environment,apns_token=EXCLUDED.apns_token,
           notification_authorization=EXCLUDED.notification_authorization,
           live_activity_authorization=EXCLUDED.live_activity_authorization,
           live_activity_push_to_start_token=EXCLUDED.live_activity_push_to_start_token,
           last_seen_at=now(),revoked_at=NULL,
           registered_by_subject=EXCLUDED.registered_by_subject,capabilities=EXCLUDED.capabilities,
           is_simulator=EXCLUDED.is_simulator,
           credential_version=devices.credential_version+1
         RETURNING id,installation_id,credential_version,now() AS issued_at`,
        [account.principalId,input.stableDeviceId,input.installationId,input.name,input.bundleIdentifier,
          input.appVersion,input.appBuild,input.osVersion,input.model ?? null,input.apnsEnvironment,
          tokenEncryption.encrypt(input.apnsToken ?? null,"device.apns_token"),persistedMobileAuthorization(input.notificationAuthorization),persistedMobileAuthorization(input.liveActivityAuthorization),
          tokenEncryption.encrypt(input.liveActivityPushToStartToken ?? null,"device.live_activity_push_to_start_token"),session.user.id,
          input.capabilities,input.isSimulator ?? false],
      );
      const row = device.rows[0]!;
      const accessToken = registrationToken(credentialDerivationSecret, account.principalId, row.id, row.credential_version, idempotencyKey);
      await client.query("UPDATE device_credentials SET revoked_at=now() WHERE device_id=$1 AND revoked_at IS NULL", [row.id]);
      await client.query("INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)", [row.id, hashToken(accessToken)]);
      await client.query(
        `INSERT INTO device_registration_idempotency(principal_id,idempotency_key,request_hash,device_id,credential_version,issued_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [account.principalId,idempotencyKey,digest,row.id,row.credential_version,row.issued_at],
      );
      await client.query("COMMIT");
      return context.json(registrationResponse(account, row, accessToken));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
