import {

liveActivityPresentationPolicySchema } from "@relo/notification-contracts";
import type { Hono } from "hono";

import { z } from "zod";


import { internalId,publicId } from "../ids.js";

import {

parsePresentationPolicy,

SYSTEM_PRESENTATION_POLICY } from "../presentation-policy.js";
import { createWebhookService,rotateWebhookService } from "../services.js";
import { destinationUrlSchema,publicHttpsUrlSchema } from "../url-policy.js";
import { createAccountUser,resetAccountUserPassword } from "../user-admin.js";

import type { WebRouteContext } from "./route-context.js";

/** Owner administration: presentation policies, users, services, phones and CLI clients. */
export function registerAdminRoutes(app: Hono, shared: WebRouteContext): void {
  const { db,appUrl,dashboardMutationAccount,ownerAdminAccount } = shared;
  app.put("/api/dashboard/account/live-activity-policy", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const policy = liveActivityPresentationPolicySchema.parse(await context.req.json());
    await db.query(
      "UPDATE owner_principals SET live_activity_policy=$2::jsonb WHERE id=$1 AND disabled_at IS NULL",
      [account.principalId,policy],
    );
    return context.json({ policy,source: "account" });
  });

  app.delete("/api/dashboard/account/live-activity-policy", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    await db.query(
      "UPDATE owner_principals SET live_activity_policy=NULL WHERE id=$1 AND disabled_at IS NULL",
      [account.principalId],
    );
    return context.json({
      reset: true,
      policy: SYSTEM_PRESENTATION_POLICY,
      source: "system",
    });
  });

  app.post("/api/dashboard/users", async (context) => {
    const account = await ownerAdminAccount(context);
    if (account instanceof Response) return account;
    const input = z.object({
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().email().max(320),
      password: z.string().min(8).max(128),
    }).strict().parse(await context.req.json());
    const user = await createAccountUser({ db,principalId: account.principalId,...input });
    return context.json({ id: user.id },201);
  });

  app.post("/api/dashboard/users/:userId/reset-password", async (context) => {
    const account = await ownerAdminAccount(context);
    if (account instanceof Response) return account;
    const input = z.object({ password: z.string().min(8).max(128) }).strict().parse(await context.req.json());
    await resetAccountUserPassword({ db,principalId: account.principalId,
      subject: context.req.param("userId"),password: input.password });
    return context.json({ ok: true });
  });

  app.post("/api/dashboard/users/:userId/:action", async (context) => {
    const account = await ownerAdminAccount(context);
    if (account instanceof Response) return account;
    const action = z.enum(["disable","enable","revoke-sessions"]).parse(context.req.param("action"));
    const subject = context.req.param("userId");
    if (action === "revoke-sessions") {
      await db.query(`DELETE FROM auth.sessions s USING account_identities i
        WHERE s.user_id=i.subject AND i.principal_id=$1 AND i.subject=$2`,[account.principalId,subject]);
    } else {
      await db.query(`UPDATE account_identities SET disabled_at=${action === "disable" ? "now()" : "NULL"}
        WHERE principal_id=$1 AND subject=$2 AND role<>'owner'`,[account.principalId,subject]);
      if (action === "disable") await db.query("DELETE FROM auth.sessions WHERE user_id=$1",[subject]);
    }
    if (action === "disable" || action === "revoke-sessions") {
      await db.query(`UPDATE device_credentials c SET revoked_at=now()
        FROM devices d WHERE c.device_id=d.id AND d.principal_id=$1
          AND d.registered_by_subject=$2 AND c.revoked_at IS NULL`,[account.principalId,subject]);
      await db.query(`UPDATE devices SET revoked_at=now() WHERE principal_id=$1
        AND registered_by_subject=$2 AND revoked_at IS NULL`,[account.principalId,subject]);
    }
    return context.json({ ok: true });
  });

  app.post("/api/dashboard/services", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const input = z.object({
      title: z.string().trim().min(1).max(80),
      imageUrl: publicHttpsUrlSchema.nullable().optional(),
      destinationUrl: destinationUrlSchema.nullable().optional(),
    }).strict().parse(await context.req.json());
    const defaults = {
      ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
      ...(input.destinationUrl !== undefined ? { destinationUrl: input.destinationUrl } : {}),
    };
    const created = await createWebhookService(db, account.principalId, input.title, appUrl, defaults);
    const policyResult = await db.query<{ live_activity_policy: unknown }>(
      "SELECT live_activity_policy FROM owner_principals WHERE id=$1",
      [account.principalId],
    );
    const accountPolicy = parsePresentationPolicy(policyResult.rows[0]?.live_activity_policy);
    return context.json({
      service: {
        id: publicId("svc",created.row.id),
        title: created.row.title,
        prefix: created.row.secret_prefix,
        liveActivityPolicy: null,
        effectiveLiveActivityPolicy: accountPolicy ?? SYSTEM_PRESENTATION_POLICY,
        liveActivityPolicySource: accountPolicy ? "account" : "system",
      },
      webhookUrl: created.webhookUrl,
    }, 201);
  });

  app.patch("/api/dashboard/services/:serviceId", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const serviceId = internalId("svc",context.req.param("serviceId"));
    if (!serviceId) return context.json({ error: "not_found" }, 404);
    const input = z.object({
      title: z.string().trim().min(1).max(80),
      imageUrl: publicHttpsUrlSchema.nullable(),
      destinationUrl: destinationUrlSchema.nullable(),
    }).strict().parse(await context.req.json());
    const result = await db.query<any>(
      `UPDATE webhook_services SET title=$3,image_url=$4,default_url=$5,updated_at=now()
       WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING id,title,secret_prefix,image_url,default_url`,
      [serviceId,account.principalId,input.title,input.imageUrl,input.destinationUrl],
    );
    return result.rowCount
      ? context.json({ service: {
        id: publicId("svc",result.rows[0].id), title: result.rows[0].title,
        prefix: result.rows[0].secret_prefix, imageUrl: result.rows[0].image_url,
        destinationUrl: result.rows[0].default_url,
      } })
      : context.json({ error: "not_found" },404);
  });

  app.post("/api/dashboard/services/:serviceId/rotate", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const serviceId = internalId("svc",context.req.param("serviceId"));
    if (!serviceId) return context.json({ error: "not_found" }, 404);
    const rotated = await rotateWebhookService(db, account.principalId, serviceId, appUrl);
    if (!rotated) return context.json({ error: "not_found" }, 404);
    return context.json({
      service: { id: publicId("svc",rotated.row.id), title: rotated.row.title, prefix: rotated.row.secret_prefix },
      webhookUrl: rotated.webhookUrl,
    });
  });

  app.delete("/api/dashboard/services/:serviceId", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const serviceId = internalId("svc",context.req.param("serviceId"));
    if (!serviceId) return context.json({ error: "not_found" }, 404);
    const result = await db.query("UPDATE webhook_services SET revoked_at=COALESCE(revoked_at,now()),updated_at=now() WHERE id=$1 AND principal_id=$2 RETURNING id", [serviceId,account.principalId]);
    return result.rowCount ? context.json({ revoked: true }) : context.json({ error: "not_found" }, 404);
  });

  app.put("/api/dashboard/services/:serviceId/live-activity-policy", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const serviceId = internalId("svc",context.req.param("serviceId"));
    if (!serviceId) return context.json({ error: "not_found" },404);
    const policy = liveActivityPresentationPolicySchema.parse(await context.req.json());
    const result = await db.query(
      `UPDATE webhook_services SET live_activity_policy=$3::jsonb,updated_at=now()
       WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING id`,
      [serviceId,account.principalId,policy],
    );
    return result.rowCount
      ? context.json({ policy,source: "service" })
      : context.json({ error: "not_found" },404);
  });

  app.delete("/api/dashboard/services/:serviceId/live-activity-policy", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const serviceId = internalId("svc",context.req.param("serviceId"));
    if (!serviceId) return context.json({ error: "not_found" },404);
    const result = await db.query(
      `UPDATE webhook_services SET live_activity_policy=NULL,updated_at=now()
       WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING id`,
      [serviceId,account.principalId],
    );
    if (!result.rowCount) return context.json({ error: "not_found" },404);
    const inherited = await db.query<{ live_activity_policy: unknown }>(
      "SELECT live_activity_policy FROM owner_principals WHERE id=$1",
      [account.principalId],
    );
    const accountPolicy = parsePresentationPolicy(inherited.rows[0]?.live_activity_policy);
    return context.json({
      reset: true,
      policy: accountPolicy ?? SYSTEM_PRESENTATION_POLICY,
      source: accountPolicy ? "account" : "system",
    });
  });

  app.post("/api/dashboard/devices/:deviceId/revoke", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const deviceId = internalId("dev",context.req.param("deviceId"));
    if (!deviceId) return context.json({ error: "not_found" }, 404);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE devices SET revoked_at=COALESCE(revoked_at,now()),apns_token=NULL,
           live_activity_push_to_start_token=NULL,
           credential_version=credential_version+CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END
         WHERE id=$1 AND principal_id=$2 RETURNING id`,
        [deviceId,account.principalId],
      );
      if (!result.rowCount) { await client.query("ROLLBACK"); return context.json({ error: "not_found" }, 404); }
      await client.query("UPDATE device_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE device_id=$1", [deviceId]);
      await client.query("UPDATE delivery_jobs SET state='canceled',updated_at=now() WHERE device_id=$1 AND state IN ('pending','retry')", [deviceId]);
      await client.query("COMMIT");
      return context.json({ revoked: true });
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  });

  app.post("/api/dashboard/credentials/:credentialId/revoke", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const credentialId = internalId("key",context.req.param("credentialId"));
    if (!credentialId) return context.json({ error: "not_found" }, 404);
    const result = await db.query("UPDATE principal_api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND principal_id=$2 RETURNING id", [credentialId,account.principalId]);
    return result.rowCount ? context.json({ revoked: true }) : context.json({ error: "not_found" }, 404);
  });

  app.put("/api/dashboard/credentials/:credentialId/live-activity-policy", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const credentialId = internalId("key",context.req.param("credentialId"));
    if (!credentialId) return context.json({ error: "not_found" },404);
    const policy = liveActivityPresentationPolicySchema.parse(await context.req.json());
    const result = await db.query(
      `UPDATE principal_api_keys SET live_activity_policy=$3::jsonb
       WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING id`,
      [credentialId,account.principalId,policy],
    );
    return result.rowCount
      ? context.json({ policy,source: "client" })
      : context.json({ error: "not_found" },404);
  });

  app.delete("/api/dashboard/credentials/:credentialId/live-activity-policy", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const credentialId = internalId("key",context.req.param("credentialId"));
    if (!credentialId) return context.json({ error: "not_found" },404);
    const result = await db.query(
      `UPDATE principal_api_keys SET live_activity_policy=NULL
       WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING id`,
      [credentialId,account.principalId],
    );
    if (!result.rowCount) return context.json({ error: "not_found" },404);
    const inherited = await db.query<{ live_activity_policy: unknown }>(
      "SELECT live_activity_policy FROM owner_principals WHERE id=$1",
      [account.principalId],
    );
    const accountPolicy = parsePresentationPolicy(inherited.rows[0]?.live_activity_policy);
    return context.json({
      reset: true,
      policy: accountPolicy ?? SYSTEM_PRESENTATION_POLICY,
      source: accountPolicy ? "account" : "system",
    });
  });

}
