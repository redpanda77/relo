import { registerActivityUpdateToken } from "../activity-token-registration.js";
import { Hono } from "hono";
import {  requireScope } from "../auth.js";
import { internalId, publicId } from "../ids.js";
import {  heartbeatSchema,  liveActivityUpdateTokenSchema } from "../schemas.js";
import {
  activityPresentationScopeKey } from "../activity-presentation-leases.js";
import { encodeDeviceInventoryCursor,decodeDeviceInventoryCursor,deviceInventoryResource } from "./resources.js";
import type { ApiRouteContext } from "./route-context.js";

/** Phone inventory, self-registration updates, Live Activity tokens and dismissals, and revocation. */
export function registerDeviceRoutes(app: Hono, shared: ApiRouteContext): void {
  const { db,encryptedTransportToken } = shared;
  app.get("/api/devices", requireScope("devices:read"), async (context) => {
    const auth = context.get("auth");
    const searchParams = new URL(context.req.url).searchParams;
    const rawLimits = searchParams.getAll("limit");
    const rawCursors = searchParams.getAll("cursor");
    const rawLimit = rawLimits[0];
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (rawLimits.length > 1 || !Number.isInteger(limit) || limit < 1 || limit > 100
      || (rawLimit !== undefined && !/^\d+$/.test(rawLimit))) {
      return context.json({ error: "invalid_limit" },400);
    }
    const rawCursor = rawCursors[0];
    const cursor = decodeDeviceInventoryCursor(rawCursor);
    if (rawCursors.length > 1 || (rawCursor !== undefined && !cursor)) {
      return context.json({ error: "cursor_expired" },410);
    }
    const result = await db.query<any>(
      `WITH scoped AS MATERIALIZED (
         SELECT id,name,installation_id,bundle_identifier,app_version,app_build,
           os_version,model,apns_environment,notification_authorization,
           live_activity_authorization,last_seen_at,registered_at,
           to_char(registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS registered_at_cursor
         FROM devices WHERE principal_id=$1 AND revoked_at IS NULL
       ), metadata AS (
         SELECT ($2::timestamptz IS NULL OR EXISTS (
           SELECT 1 FROM scoped anchor
           WHERE (anchor.registered_at,anchor.id)=($2::timestamptz,$3::uuid)
         )) AS cursor_valid
       ), page AS (
         SELECT scoped.* FROM scoped,metadata
         WHERE metadata.cursor_valid
           AND ($2::timestamptz IS NULL OR (scoped.registered_at,scoped.id)<($2::timestamptz,$3::uuid))
         ORDER BY scoped.registered_at DESC,scoped.id DESC
         LIMIT ${limit + 1}
       )
       SELECT page.*,metadata.cursor_valid
       FROM metadata LEFT JOIN page ON metadata.cursor_valid
       ORDER BY page.registered_at DESC,page.id DESC`,
      [auth.principalId,cursor?.registeredAt ?? null,cursor?.id ?? null],
    );
    const metadata = result.rows[0] as { id: string | null; cursor_valid: boolean } | undefined;
    if (!metadata?.cursor_valid) return context.json({ error: "cursor_expired" },410);
    const pageRows = result.rows.filter((row: any) => row.id !== null);
    const hasMore = pageRows.length > limit;
    const rows = pageRows.slice(0,limit);
    const last = rows.at(-1);
    return context.json({
      devices: rows.map(deviceInventoryResource),
      cursor: hasMore && last ? encodeDeviceInventoryCursor(last.registered_at_cursor,last.id) : null,
      hasMore,
    });
  });

  app.get("/api/devices/self", requireScope("device:self"), async (context) => {
    const auth = context.get("auth");
    if (!auth.deviceId) return context.json({ error: "device_credential_required" }, 403);
    const result = await db.query<any>(
      `SELECT d.id,d.installation_id,d.credential_version,d.revoked_at,
              p.id AS principal_id,u.name,u.email,u.image
       FROM devices d
       JOIN owner_principals p ON p.id=d.principal_id
       JOIN account_identities i ON i.principal_id=p.id AND i.provider='better-auth'
       JOIN auth.users u ON u.id=i.subject
       WHERE d.id=$1 AND d.principal_id=$2`,
      [auth.deviceId,auth.principalId],
    );
    if (!result.rowCount) return context.json({ error: "not_found" }, 404);
    const row = result.rows[0];
    return context.json({
      account: { accountId: publicId("acc",row.principal_id), name: row.name, email: row.email, imageUrl: row.image ?? null },
      device: {
        deviceId: publicId("dev",row.id), installationId: row.installation_id,
        registrationState: row.revoked_at ? "revoked" : "active",
        credentialVersion: row.credential_version,
      },
    });
  });

  app.put("/api/devices/:deviceId", requireScope("device:self"), async (context) => {
    const auth = context.get("auth");
    const requested = internalId("dev", context.req.param("deviceId") ?? "");
    if (!requested || requested !== auth.deviceId) return context.json({ error: "forbidden" }, 403);
    const input = heartbeatSchema.parse(await context.req.json());
    const fields: string[] = ["last_seen_at=now()"];
    const values: unknown[] = [];
    const mapping: Record<string, string> = {
      appVersion: "app_version", appBuild: "app_build", osVersion: "os_version", model: "model",
      apnsEnvironment: "apns_environment", apnsToken: "apns_token",
      notificationAuthorization: "notification_authorization",
      liveActivityAuthorization: "live_activity_authorization",
      liveActivityPushToStartToken: "live_activity_push_to_start_token",
    };
    for (const [key, column] of Object.entries(mapping)) {
      let value = (input as Record<string, unknown>)[key];
      if (key === "apnsToken" && typeof value === "string") {
        value = encryptedTransportToken(value,"device.apns_token");
      } else if (key === "liveActivityPushToStartToken" && typeof value === "string") {
        value = encryptedTransportToken(value,"device.live_activity_push_to_start_token");
      }
      if (value !== undefined) { values.push(value); fields.push(`${column}=$${values.length}`); }
    }
    values.push(auth.deviceId, auth.principalId);
    await db.query(`UPDATE devices SET ${fields.join(",")} WHERE id=$${values.length - 1} AND principal_id=$${values.length}`, values);
    return context.json({ status: "ok" });
  });

  app.put("/api/devices/self/live-activities/:activityId/token", requireScope("device:self"), async (context) => {
    const auth = context.get("auth");
    if (!auth.deviceId) return context.json({ error: "device_credential_required" },403);
    const activityId = internalId("act",context.req.param("activityId") ?? "");
    if (!activityId) return context.json({ error: "not_found" },404);
    const input = liveActivityUpdateTokenSchema.parse(await context.req.json());
    const encryptedToken = encryptedTransportToken(input.token.toLowerCase(),"live_activity_update_token.token");
    if (!encryptedToken) throw new Error("Activity token encryption returned no token");
    const result = await registerActivityUpdateToken(db,{
      activityId,deviceId: auth.deviceId,principalId: auth.principalId,generation: input.generation,
      nativeActivityId: input.nativeActivityId,environment: input.environment,
      encryptedToken,
    });
    if (result.kind === "registered") {
      return context.json({ activityId: publicId("act",activityId),generation: result.generation,status: "registered" });
    }
    if (result.kind === "generation_mismatch") {
      return context.json({ error: "activity_generation_mismatch",code: "ACTIVITY_GENERATION_MISMATCH",
        generation: result.generation },409);
    }
    return context.json({ error: "not_found" },404);
  });

  app.post("/api/devices/self/live-activities/:activityId/dismissed", requireScope("device:self"), async (context) => {
    const auth = context.get("auth");
    if (!auth.deviceId) return context.json({ error: "device_credential_required" },403);
    const activityId = internalId("act",context.req.param("activityId") ?? "");
    if (!activityId) return context.json({ error: "not_found" },404);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const activity = await client.query<any>(
        `SELECT * FROM live_activities
         WHERE id=$1 AND principal_id=$2 AND ($3=ANY(target_device_ids) OR target_device_ids IS NULL)
         FOR UPDATE`,
        [activityId,auth.principalId,auth.deviceId],
      );
      if (!activity.rowCount) {
        await client.query("ROLLBACK");
        return context.json({ error: "not_found" },404);
      }
      const active = activity.rows[0]?.state === "active";
      const dismissed = active ? await client.query(
        `INSERT INTO live_activity_presentation_leases(
           live_activity_id,principal_id,device_id,scope_key,state,reason,relevance_score,
           last_command_sequence,selected_at,ended_at,updated_at
         ) VALUES ($1,$2,$3,$4,'not_presented','device_dismissed',0,$5,NULL,NULL,now())
         ON CONFLICT (live_activity_id,device_id) DO UPDATE SET
           state='not_presented',reason='device_dismissed',relevance_score=0,
           last_command_sequence=GREATEST(
             live_activity_presentation_leases.last_command_sequence,EXCLUDED.last_command_sequence
           ),selected_at=NULL,ended_at=NULL,updated_at=now()
         WHERE live_activity_presentation_leases.state<>'not_presented'
         RETURNING live_activity_id`,
        [activityId,auth.principalId,auth.deviceId,
          activityPresentationScopeKey(activity.rows[0]),Number(activity.rows[0].sequence)],
      ) : { rowCount: 0 };
      const changed = Boolean(dismissed.rowCount);
      await client.query(
        "DELETE FROM live_activity_update_tokens WHERE live_activity_id=$1 AND device_id=$2",
        [activityId,auth.deviceId],
      );
      await client.query("COMMIT");
      return context.json({ activityId: publicId("act",activityId),status: "dismissed",changed });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete("/api/devices/:deviceId", requireScope("device:self"), async (context) => {
    const auth = context.get("auth");
    const requested = internalId("dev", context.req.param("deviceId") ?? "");
    if (!requested || requested !== auth.deviceId) return context.json({ error: "forbidden" }, 403);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE device_credentials SET revoked_at=now() WHERE device_id=$1 AND revoked_at IS NULL", [auth.deviceId]);
      await client.query(
        `UPDATE devices SET revoked_at=now(),apns_token=NULL,live_activity_push_to_start_token=NULL,
           credential_version=credential_version+1 WHERE id=$1 AND principal_id=$2`,
        [auth.deviceId,auth.principalId],
      );
      await client.query("UPDATE delivery_jobs SET state='canceled',updated_at=now() WHERE device_id=$1 AND state IN ('pending','retry')", [auth.deviceId]);
      await client.query("COMMIT");
      return context.body(null, 204);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  });

}
