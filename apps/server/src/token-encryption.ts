import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const envelopePrefix = "relo.tt.current";
const keySalt = Buffer.from("relo:transport-token:key-derivation:current", "utf8");
const keyInfo = Buffer.from("aes-256-gcm", "utf8");

export type TransportTokenPurpose =
  | "device.apns_token"
  | "device.live_activity_push_to_start_token"
  | "live_activity_update_token.token";
/** Other at-rest secrets sealed with the same key under their own AAD. */
export type SealedSecretPurpose = TransportTokenPurpose | "interaction_callback.token";

export class InvalidTransportTokenError extends Error {
  constructor() {
    super("Invalid encrypted transport token");
    this.name = "InvalidTransportTokenError";
  }
}

export type TransportTokenEncryption = {
  encrypt: (token: string | null, purpose: SealedSecretPurpose) => string | null;
  decrypt: (value: string | null, purpose: SealedSecretPurpose) => string | null;
};

export type StoredTransportToken =
  | { purpose: "device.apns_token"; deviceId: string; ciphertext: string }
  | { purpose: "device.live_activity_push_to_start_token"; deviceId: string; ciphertext: string }
  | { purpose: "live_activity_update_token.token"; deviceId: string; liveActivityId: string;
    liveActivityGeneration: number; ciphertext: string };

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: any[] }> };

function aad(purpose: SealedSecretPurpose): Buffer {
  return Buffer.from(`relo:transport-token:aad:current\n${purpose}`, "utf8");
}

function decodePart(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new InvalidTransportTokenError();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new InvalidTransportTokenError();
  return decoded;
}

function validateCurrentEnvelope(value: string): void {
  const parts = value.split(".");
  if (parts.length !== 6 || `${parts[0]}.${parts[1]}.${parts[2]}` !== envelopePrefix) {
    throw new InvalidTransportTokenError();
  }
  const nonce = decodePart(parts[3]!);
  const ciphertext = decodePart(parts[4]!);
  const tag = decodePart(parts[5]!);
  if (nonce.length !== 12 || ciphertext.length === 0 || tag.length !== 16) {
    throw new InvalidTransportTokenError();
  }
}

export function createTransportTokenEncryption(secret: string): TransportTokenEncryption {
  if (!secret) throw new Error("Transport token key derivation secret is required");
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), keySalt, keyInfo, 32));

  return {
    encrypt(token, purpose) {
      if (token === null) return null;
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(purpose));
      const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [envelopePrefix, nonce.toString("base64url"),
        ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
    },

    decrypt(value, purpose) {
      if (value === null) return null;
      try {
        validateCurrentEnvelope(value);
        const parts = value.split(".");
        const nonce = decodePart(parts[3]!);
        const ciphertext = decodePart(parts[4]!);
        const tag = decodePart(parts[5]!);
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(aad(purpose));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch (error) {
        if (error instanceof InvalidTransportTokenError) throw error;
        throw new InvalidTransportTokenError();
      }
    },
  };
}

export async function clearTransportTokenIfUnchanged(
  query: Queryable,
  stored: StoredTransportToken,
): Promise<boolean> {
  const result = stored.purpose === "device.apns_token"
    ? await query.query(
      "UPDATE devices SET apns_token=NULL WHERE id=$1 AND apns_token=$2",
      [stored.deviceId,stored.ciphertext],
    )
    : stored.purpose === "device.live_activity_push_to_start_token"
      ? await query.query(
        "UPDATE devices SET live_activity_push_to_start_token=NULL WHERE id=$1 AND live_activity_push_to_start_token=$2",
        [stored.deviceId,stored.ciphertext],
      )
      : await query.query(
        `DELETE FROM live_activity_update_tokens
         WHERE live_activity_id=$1 AND device_id=$2 AND generation=$3 AND token=$4`,
        [stored.liveActivityId,stored.deviceId,stored.liveActivityGeneration,stored.ciphertext],
      );
  return (result.rowCount ?? 0) > 0;
}

export async function verifyCurrentTransportTokenEnvelopes(query: Queryable): Promise<void> {
  const tokens = await query.query(
    `SELECT apns_token AS value FROM devices WHERE apns_token IS NOT NULL
     UNION ALL
     SELECT live_activity_push_to_start_token AS value FROM devices
       WHERE live_activity_push_to_start_token IS NOT NULL
     UNION ALL
     SELECT token AS value FROM live_activity_update_tokens`,
  );
  for (const row of tokens.rows as Array<{ value: string }>) validateCurrentEnvelope(row.value);
}

export async function verifyTransportTokenAuthenticity(
  query: Queryable,
  encryption: TransportTokenEncryption,
): Promise<number> {
  const tokens = await query.query(
    `SELECT 'device.apns_token' AS purpose,apns_token AS value
       FROM devices WHERE apns_token IS NOT NULL
     UNION ALL
     SELECT 'device.live_activity_push_to_start_token' AS purpose,live_activity_push_to_start_token AS value
       FROM devices WHERE live_activity_push_to_start_token IS NOT NULL
     UNION ALL
     SELECT 'live_activity_update_token.token' AS purpose,token AS value
       FROM live_activity_update_tokens`,
  );
  for (const row of tokens.rows as Array<{ purpose: TransportTokenPurpose; value: string }>) {
    encryption.decrypt(row.value,row.purpose);
  }
  return tokens.rows.length;
}
