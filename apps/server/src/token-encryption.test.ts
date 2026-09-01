import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.js";
import { generateToken, hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import {
  clearTransportTokenIfUnchanged,
  createTransportTokenEncryption,
  InvalidTransportTokenError,
  verifyCurrentTransportTokenEnvelopes,
  verifyTransportTokenAuthenticity,
} from "./token-encryption.js";

const secret = "transport-token-test-secret-with-at-least-32-characters";

describe("transport token encryption", () => {
  const encryption = createTransportTokenEncryption(secret);
  const token = "a".repeat(64);

  test("uses randomized authenticated ciphertext and preserves null", () => {
    const first = encryption.encrypt(token,"device.apns_token");
    const second = encryption.encrypt(token,"device.apns_token");
    expect(first).not.toBe(second);
    expect(first).not.toContain(token);
    expect(encryption.decrypt(first,"device.apns_token")).toBe(token);
    expect(encryption.encrypt(null,"device.apns_token")).toBeNull();
    expect(encryption.decrypt(null,"device.apns_token")).toBeNull();
  });

  test("binds ciphertext to its purpose and fails closed on corruption or unknown versions", () => {
    const encrypted = encryption.encrypt(token,"device.apns_token")!;
    expect(() => encryption.decrypt(encrypted,"device.live_activity_push_to_start_token"))
      .toThrow(InvalidTransportTokenError);
    const corrupted = `${encrypted.slice(0,-1)}${encrypted.endsWith("A") ? "B" : "A"}`;
    expect(() => encryption.decrypt(corrupted,"device.apns_token")).toThrow(InvalidTransportTokenError);
    expect(() => encryption.decrypt(encrypted.replace(".current.",".retired."),"device.apns_token"))
      .toThrow(InvalidTransportTokenError);
    expect(() => encryption.decrypt(token,"device.apns_token")).toThrow(InvalidTransportTokenError);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

postgresSuite("transport token PostgreSQL boundaries", () => {
  let db: Database;
  const ownerToken = "owner_transport_abcdefghijklmnopqrstuvwxyz_0123456789";
  const encryption = createTransportTokenEncryption(secret);

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
  });

  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");
    await bootstrapOwner(db,"transport-owner",ownerToken);
  });

  afterAll(async () => db.end());

  test("current registration tokens, cleanup, and rotation preserve encrypted tokens", async () => {
    const app = createApp(db,{ apnsMode: "sandbox", credentialDerivationSecret: secret });
    const rawApnsToken = "1".repeat(64);
    const deviceId = randomUUID();
    const principal = await db.query<{ principal_id: string }>(
      "SELECT principal_id FROM principal_api_keys WHERE token_hash=$1",
      [hashToken(ownerToken)],
    );
    await db.query(
      `INSERT INTO devices (
         id,principal_id,stable_device_id,installation_id,name,bundle_identifier,
         app_version,app_build,os_version,apns_environment,apns_token,
         notification_authorization,live_activity_authorization,credential_version
       ) VALUES ($1,$2,'transport-stable','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
         'Encrypted iPhone','com.example.relo.notifications','1.0.0','1','18.0',
         'sandbox',$3,'authorized','authorized',1)`,
      [deviceId,principal.rows[0]!.principal_id,encryption.encrypt(rawApnsToken,"device.apns_token")],
    );
    const accessToken = generateToken();
    await db.query(
      "INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)",
      [deviceId,hashToken(accessToken)],
    );
    const registered = { deviceId: `dev_${deviceId}`,accessToken };
    const firstStored = await db.query<{ apns_token: string }>("SELECT apns_token FROM devices WHERE id=$1",[deviceId]);
    expect(firstStored.rows[0]!.apns_token).not.toBe(rawApnsToken);
    expect(encryption.decrypt(firstStored.rows[0]!.apns_token,"device.apns_token")).toBe(rawApnsToken);

    const rawPushToken = "2".repeat(64);
    const heartbeat = await app.request(`/api/devices/${registered.deviceId}`,{
      method: "PUT",
      headers: { authorization: `Bearer ${registered.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ apnsToken: rawApnsToken, liveActivityPushToStartToken: rawPushToken }),
    });
    expect(heartbeat.status).toBe(200);
    const updatedDevice = await db.query<{ apns_token: string; live_activity_push_to_start_token: string }>(
      "SELECT apns_token,live_activity_push_to_start_token FROM devices WHERE id=$1",
      [deviceId],
    );
    expect(updatedDevice.rows[0]!.apns_token).not.toBe(firstStored.rows[0]!.apns_token);
    expect(updatedDevice.rows[0]!.live_activity_push_to_start_token).not.toBe(rawPushToken);
    expect(encryption.decrypt(updatedDevice.rows[0]!.live_activity_push_to_start_token,
      "device.live_activity_push_to_start_token")).toBe(rawPushToken);

    const activity = await app.request("/api/live-activities",{
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
        "idempotency-key": "encrypted-token-activity-start",
      },
      body: JSON.stringify({ key: "encrypted-token", title: "Encrypt tokens", status: "Starting" }),
    });
    expect(activity.status).toBe(201);
    const activityResource = (await activity.json() as { activity: { id: string; generation: number } }).activity;
    const activityId = activityResource.id;
    const rawUpdateToken = "3".repeat(64);
    const tokenUpdate = await app.request(`/api/devices/self/live-activities/${activityId}/token`,{
      method: "PUT",
      headers: { authorization: `Bearer ${registered.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token: rawUpdateToken, nativeActivityId: "native-encrypted",
        environment: "sandbox", generation: activityResource.generation }),
    });
    expect(tokenUpdate.status).toBe(200);
    const activityToken = await db.query<{ token: string }>("SELECT token FROM live_activity_update_tokens");
    expect(activityToken.rows[0]!.token).not.toBe(rawUpdateToken);
    expect(encryption.decrypt(activityToken.rows[0]!.token,"live_activity_update_token.token")).toBe(rawUpdateToken);

    const rotatedHeartbeat = await app.request(`/api/devices/${registered.deviceId}`,{
      method: "PUT",
      headers: { authorization: `Bearer ${registered.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ apnsToken: rawApnsToken, liveActivityPushToStartToken: rawPushToken }),
    });
    expect(rotatedHeartbeat.status).toBe(200);
    const rotatedTokenUpdate = await app.request(`/api/devices/self/live-activities/${activityId}/token`,{
      method: "PUT",
      headers: { authorization: `Bearer ${registered.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token: rawUpdateToken, nativeActivityId: "native-encrypted",
        environment: "sandbox", generation: activityResource.generation }),
    });
    expect(rotatedTokenUpdate.status).toBe(200);
    const rotated = await db.query<{ apns_token: string; live_activity_push_to_start_token: string; token: string }>(
      `SELECT d.apns_token,d.live_activity_push_to_start_token,t.token FROM devices d
       JOIN live_activity_update_tokens t ON t.device_id=d.id WHERE d.id=$1`,
      [deviceId],
    );
    expect(rotated.rows[0]!.apns_token).not.toBe(updatedDevice.rows[0]!.apns_token);
    expect(rotated.rows[0]!.live_activity_push_to_start_token)
      .not.toBe(updatedDevice.rows[0]!.live_activity_push_to_start_token);
    expect(rotated.rows[0]!.token).not.toBe(activityToken.rows[0]!.token);
    expect(await Promise.all([
      clearTransportTokenIfUnchanged(db,{
        purpose: "device.apns_token", deviceId, ciphertext: updatedDevice.rows[0]!.apns_token,
      }),
      clearTransportTokenIfUnchanged(db,{
        purpose: "device.live_activity_push_to_start_token",
        deviceId,
        ciphertext: updatedDevice.rows[0]!.live_activity_push_to_start_token,
      }),
      clearTransportTokenIfUnchanged(db,{
        purpose: "live_activity_update_token.token",
        deviceId,
        liveActivityId: activityId.slice("act_".length),
        liveActivityGeneration: activityResource.generation,
        ciphertext: activityToken.rows[0]!.token,
      }),
    ])).toEqual([false,false,false]);
    expect((await db.query<{ apns_token: string; live_activity_push_to_start_token: string; token: string }>(
      `SELECT d.apns_token,d.live_activity_push_to_start_token,t.token FROM devices d
       JOIN live_activity_update_tokens t ON t.device_id=d.id WHERE d.id=$1`,
      [deviceId],
    )).rows[0]).toEqual(rotated.rows[0]);
    expect(await clearTransportTokenIfUnchanged(db,{
      purpose: "device.apns_token", deviceId, ciphertext: rotated.rows[0]!.apns_token,
    })).toBe(true);
    expect((await db.query<{ apns_token: string | null }>(
      "SELECT apns_token FROM devices WHERE id=$1",[deviceId],
    )).rows[0]!.apns_token).toBeNull();

    await expect(verifyCurrentTransportTokenEnvelopes(db)).resolves.toBeUndefined();
    await expect(verifyTransportTokenAuthenticity(db,encryption)).resolves.toBe(2);
    await expect(verifyTransportTokenAuthenticity(
      db,createTransportTokenEncryption("different-transport-secret-with-at-least-32-characters"),
    )).rejects.toThrow(InvalidTransportTokenError);
    const validCiphertext = rotated.rows[0]!.live_activity_push_to_start_token;
    const corruptedCiphertext = `${validCiphertext.slice(0,-1)}${validCiphertext.endsWith("A") ? "B" : "A"}`;
    await db.query(
      "UPDATE devices SET live_activity_push_to_start_token=$2 WHERE id=$1",
      [deviceId,corruptedCiphertext],
    );
    await expect(verifyTransportTokenAuthenticity(db,encryption)).rejects.toThrow(InvalidTransportTokenError);
  });
});
