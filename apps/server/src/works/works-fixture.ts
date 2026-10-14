import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { createApp } from "../app.js";
import { bootstrapOwner } from "../bootstrap.js";
import type { Database } from "../db.js";
import { createTransportTokenEncryption } from "../token-encryption.js";

/** Shared fixture for G1's works tests: an owner with one sandbox phone and session-scoped calls. */
export const OWNER_TOKEN = "works_g1_owner_abcdefghijklmnopqrstuvwxyz0123456789";
export const SECRET = "works-g1-secret-with-at-least-32-characters-long";
export const SESSION_A = "sessionGAAAAAAAAAAAAAAAAAAAAAAA";
export const SESSION_B = "sessionGBBBBBBBBBBBBBBBBBBBBBBB";
export const CONTEXT = { providerName: "Claude Code",project: "relo",threadName: "Release" };

export async function resetOwner(db: Database): Promise<{ principalId: string; deviceId: string }> {
  await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
  await bootstrapOwner(db,"owner",OWNER_TOKEN);
  const principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  const deviceId = randomUUID();
  const encryption = createTransportTokenEncryption(SECRET);
  await db.query(
    `INSERT INTO devices (id,principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
       os_version,model,apns_environment,apns_token,live_activity_push_to_start_token,notification_authorization,
       live_activity_authorization,credential_version)
     VALUES ($1,$2,$3,$4,'Phone','com.example.relo.notifications','1','1','18','iPhone','sandbox',$5,$6,
       'authorized','authorized',1)`,
    [deviceId,principalId,`stable-${deviceId}`,randomUUID(),encryption.encrypt("a".repeat(64),"device.apns_token"),
      encryption.encrypt("b".repeat(64),"device.live_activity_push_to_start_token")]);
  return { principalId,deviceId };
}

export function caller(app: ReturnType<typeof createApp>) {
  return async (method: string,path: string,body?: unknown,session: string | null = SESSION_A) => {
    const response = await app.request(path,{
      method,headers: { authorization: `Bearer ${OWNER_TOKEN}`,"content-type": "application/json","idempotency-key": randomUUID(),
        ...(session ? { "relo-session-key": session,"relo-harness": "claude-code" } : {}) },
      body: body === undefined ? null : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  };
}

export async function startWork(call: ReturnType<typeof caller>,body: Record<string,unknown> = {},session = SESSION_A) {
  const started = await call("POST","/api/session/works",{ goal: { readable: "Ship works" },context: CONTEXT,...body },session);
  expect(started.status,JSON.stringify(started.body)).toBeLessThan(300);
  return started.body.work;
}
