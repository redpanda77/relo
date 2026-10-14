import { randomBytes,randomUUID } from "node:crypto";
import type { Database } from "../db.js";
import type { SealedEnvelope,SealedNotice } from "../sealed-content.js";

const b64 = (length: number) => randomBytes(length).toString("base64url");

/** An envelope with the right shape; the server cannot open any envelope, so random bytes do. */
export function fixtureEnvelope(devices: string[],kind: SealedEnvelope["kind"] = "card",context = "act:test"): SealedEnvelope {
  return { v: "relo.e2e.v1",kind,context,sender: "k_AAAAAAAAAAAAAAAAAAAAAA",
    recipients: devices.map((device) => ({ device,prekey: "pk_1",enc: b64(65),key: b64(48) })),
    nonce: b64(12),ct: b64(272),sig: b64(64) };
}

/** Sealed card text: one alert per phone, the content to every reader (phones, browsers, the computer). */
export function fixtureSealedCard(phones: string[],{ readers = [] as string[],context = `act:${randomUUID()}` } = {}): SealedNotice {
  return { alerts: phones.map((phone) => fixtureEnvelope([phone],"card",context)),
    content: fixtureEnvelope([...phones,...readers],"card",context) };
}

/** A phone that shows Live Activities, with an identity and the prekey pk_1 published. */
export async function fixturePhone(db: Database,principalId: string): Promise<{ id: string; publicId: string }> {
  const id = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
    app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token,
    live_activity_push_to_start_token) VALUES ($1,$2,$3,'Phone','com.example.relo.notifications','1','1','26','sandbox',
    'authorized','authorized','fixture-alert','fixture-start') RETURNING id`,
  [principalId,randomUUID(),randomUUID()])).rows[0]!.id;
  await db.query("INSERT INTO device_identity_keys(device_id,principal_id,key_id,public_key) VALUES ($1,$2,$3,$4)",
    [id,principalId,`k_${b64(16)}`,b64(65)]);
  await db.query(`INSERT INTO device_prekeys(device_id,principal_id,prekey_id,public_key,signature,signed_created_at)
    VALUES ($1,$2,'pk_1',$3,$4,$5)`,[id,principalId,b64(65),b64(64),new Date().toISOString()]);
  return { id,publicId: `dev_${id}` };
}
