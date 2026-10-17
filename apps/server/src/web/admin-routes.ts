import { LOGIN_SCOPES,computerRenameSchema } from "@relo/notification-contracts";
import { loadComputerRecord } from "../computers/record.js";
import { changeAppearance } from "../activity-commands/reproject.js";
import { findComputer,updateComputer } from "../computers/store.js";
import {

liveActivityPresentationPolicySchema } from "@relo/notification-contracts";
import type { Hono } from "hono";

import { z } from "zod";


import { approveDeviceFromBrowser,browserApprovalSchema } from "../device-approvals.js";
import { dashboardDevices,twoFactorEnabled } from "../device-overview.js";
import { revokeHarnessCredential } from "../credentials/harness.js";
import { internalId,publicId } from "../ids.js";
import { purgeUnreadableContent } from "../unreadable-content.js";

import {

parsePresentationPolicy,

SYSTEM_PRESENTATION_POLICY } from "../presentation-policy.js";
import { revokeService } from "../credentials/service.js";
import { createWebhookService,rotateWebhookService,updateWebhookService } from "../webhooks/admin.js";
import { serviceCreateSchema } from "../webhooks/schemas.js";

const serviceScopesSchema = serviceCreateSchema.shape.scopes.unwrap();
import { destinationUrlSchema,publicHttpsUrlSchema } from "../url-policy.js";
import { createAccountUser,resetAccountUserPassword } from "../user-admin.js";

import { getOwnerAccount } from "./owner-account.js";
import type { WebRouteContext } from "./route-context.js";
import { revokeDeviceCredentials,revokeDeviceCredentialsRegisteredBy } from "../credentials/device.js";
import { mintCiToken,revokeLogin } from "../credentials/login.js";
import { CI_TOKEN_REFUSALS,ciTokenCreateSchema,ciTokenResource } from "../api/credential-routes.js";

/** Approving from the Dashboard: at most this many attempts per account per window (any outcome). */
const APPROVAL_ATTEMPTS = 10;
const APPROVAL_WINDOW_MS = 15 * 60_000;
const approvalAttempts = new Map<string,number[]>();

function approvalLimited(principalId: string,now = Date.now()): boolean {
  const recent = (approvalAttempts.get(principalId) ?? []).filter((at) => now - at < APPROVAL_WINDOW_MS);
  if (recent.length >= APPROVAL_ATTEMPTS) { approvalAttempts.set(principalId,recent); return true; }
  recent.push(now);
  approvalAttempts.set(principalId,recent);
  if (approvalAttempts.size > 10_000) approvalAttempts.delete(approvalAttempts.keys().next().value!);
  return false;
}

/** Tests only. */
export function resetApprovalAttempts(): void { approvalAttempts.clear(); }

/** Owner administration: presentation policies, users, services, phones and computers. */
export function registerAdminRoutes(app: Hono, shared: WebRouteContext): void {
  const { db,appUrl,accountAuth,apnsMode,dashboardMutationAccount,ownerAdminAccount } = shared;
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

  /** Only users of the admin's own account; anyone else answers like a user that does not exist. */
  const isAccountUser = async (principalId: string,subject: string) => Boolean((await db.query(
    "SELECT 1 FROM account_identities WHERE principal_id=$1 AND subject=$2",[principalId,subject])).rowCount);

  app.post("/api/dashboard/users/:userId/reset-password", async (context) => {
    const account = await ownerAdminAccount(context);
    if (account instanceof Response) return account;
    if (!await isAccountUser(account.principalId,context.req.param("userId"))) {
      return context.json({ error: "user_not_found" },404);
    }
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
    if (!await isAccountUser(account.principalId,subject)) return context.json({ error: "user_not_found" },404);
    if (action === "revoke-sessions") {
      await db.query(`DELETE FROM auth.sessions s USING account_identities i
        WHERE s.user_id=i.subject AND i.principal_id=$1 AND i.subject=$2`,[account.principalId,subject]);
    } else {
      await db.query(`UPDATE account_identities SET disabled_at=${action === "disable" ? "now()" : "NULL"}
        WHERE principal_id=$1 AND subject=$2 AND role<>'owner'`,[account.principalId,subject]);
      if (action === "disable") await db.query("DELETE FROM auth.sessions WHERE user_id=$1",[subject]);
    }
    if (action === "disable" || action === "revoke-sessions") {
      await revokeDeviceCredentialsRegisteredBy(db,account.principalId,subject);
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
      endpoint: created.endpoint,
      secret: created.secret,
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
      readableAllowed: z.boolean().optional(),
      scopes: serviceScopesSchema.optional(),
    }).strict().parse(await context.req.json());
    const row = await updateWebhookService(db,account.principalId,serviceId,input);
    return row
      ? context.json({ service: {
        id: publicId("svc",row.id), title: row.title, prefix: row.secret_prefix, imageUrl: row.image_url,
        destinationUrl: row.default_url, readableAllowed: row.readable_allowed === true, scopes: row.scopes,
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
      endpoint: rotated.endpoint,
      secret: rotated.secret,
    });
  });

  app.delete("/api/dashboard/services/:serviceId", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const serviceId = internalId("svc",context.req.param("serviceId"));
    if (!serviceId) return context.json({ error: "not_found" }, 404);
    return await revokeService(db,account.principalId,serviceId) ? context.json({ revoked: true }) : context.json({ error: "not_found" }, 404);
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
      await revokeDeviceCredentials(client,deviceId);
      await client.query("UPDATE delivery_jobs SET state='canceled',updated_at=now() WHERE device_id=$1 AND state IN ('pending','retry')", [deviceId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    // Like signing out on the phone: what only this phone could open is deleted.
    await purgeUnreadableContent(db,account.principalId,apnsMode);
    return context.json({ revoked: true });
  });

  // Account → Security → Devices: phones, computers and browsers with their encryption status.
  app.get("/api/dashboard/devices", async (context) => {
    const account = await getOwnerAccount(db,accountAuth,context.req.raw.headers);
    if (!account) return context.json({ error: "unauthorized" },401);
    context.header("cache-control","private, no-store");
    const [devices,twoFactor] = await Promise.all([dashboardDevices(db,account.principalId),twoFactorEnabled(db,account.user.id)]);
    return context.json({ devices,twoFactorEnabled: twoFactor });
  });

  // A linked browser approves a pending phone (docs/ENCRYPTION-PROTOCOL.md, "Approving from a linked browser").
  app.post("/api/dashboard/devices/:deviceId/approve", async (context) => {
    const account = await ownerAdminAccount(context);
    if (account instanceof Response) return account;
    if (approvalLimited(account.principalId)) {
      return context.json({ error: "rate_limited",message: "Too many attempts. Wait a few minutes and try again." },429,
        { "retry-after": String(APPROVAL_WINDOW_MS / 1000) });
    }
    const parsed = browserApprovalSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "invalid_approval" },400);
    if (await twoFactorEnabled(db,account.user.id)) {
      if (!parsed.data.code) return context.json({ error: "two_factor_code_required" },403);
      const verified = await accountAuth.api.verifyTOTP({ headers: context.req.raw.headers,body: { code: parsed.data.code } })
        .then(() => true,() => false);
      if (!verified) return context.json({ error: "invalid_two_factor_code" },403);
    }
    const deviceId = context.req.param("deviceId");
    const result = await approveDeviceFromBrowser(db,account.principalId,deviceId,parsed.data);
    if (!result.ok) {
      const status = result.error === "device_not_found" ? 404 : result.error === "browser_not_linked" ? 403
        : result.error === "invalid_signature" ? 400 : 409;
      return context.json({ error: result.error },status);
    }
    return context.json({ deviceId,approved: true });
  });

  // CI tokens (plan 10 A1): the owner makes one from the Dashboard; its secret is shown once. Revoked like any login.
  app.post("/api/dashboard/ci-tokens", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const input = ciTokenCreateSchema.parse(await context.req.json());
    const minted = await mintCiToken(db,{ principalId: account.principalId,name: input.name,scopes: input.scopes ?? [...LOGIN_SCOPES].sort(),
      expiresInDays: input.expiresInDays,maker: { credentialId: null,kind: "owner",scopes: "all" } });
    if (typeof minted === "string") {
      const [status,message] = CI_TOKEN_REFUSALS[minted];
      return context.json({ error: minted,message },status);
    }
    return context.json({ token: minted.token,credential: ciTokenResource(minted.row) },201);
  });

  // Computers (ADR 0011): the owner renames one and picks its icon. The login's label is never edited.
  app.patch("/api/dashboard/computers/:computerId", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const computerId = internalId("cmp",context.req.param("computerId"));
    if (!computerId) return context.json({ error: "not_found" },404);
    const input = computerRenameSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!input.success) return context.json({ error: "invalid_request" },400);
    const existing = await findComputer(db,account.principalId,computerId);
    if (!existing) return context.json({ error: "not_found" },404);
    // A new icon changes how the computer's open cards look: they are shown again in the same transaction.
    const saved = await changeAppearance(db,{ principalId: account.principalId,credentialId: existing.login_key_id },apnsMode,
      async (tx) => await updateComputer(tx,account.principalId,computerId,input.data) ? true : null);
    if (!saved) return context.json({ error: "not_found" },404);
    const record = await loadComputerRecord(db,account.principalId,computerId);
    return record ? context.json(record) : context.json({ error: "not_found" },404);
  });

  app.post("/api/dashboard/credentials/:credentialId/revoke", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const credentialId = internalId("key",context.req.param("credentialId"));
    if (!credentialId) return context.json({ error: "not_found" }, 404);
    return await revokeLogin(db,account.principalId,credentialId) ? context.json({ revoked: true }) : context.json({ error: "not_found" }, 404);
  });

  // Hooks credentials (kind "harness"): the owner can revoke one from the Dashboard too.
  app.post("/api/dashboard/harness-credentials/:harnessCredentialId/revoke", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    return await revokeHarnessCredential(db,account.principalId,context.req.param("harnessCredentialId"))
      ? context.json({ revoked: true }) : context.json({ error: "not_found" }, 404);
  });

  app.put("/api/dashboard/credentials/:credentialId/card-limit", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const credentialId = internalId("key",context.req.param("credentialId"));
    if (!credentialId) return context.json({ error: "not_found" },404);
    const input = z.object({ limit: z.number().int().min(1).max(10).nullable() }).strict().parse(await context.req.json());
    const result = await db.query(
      `UPDATE principal_api_keys SET max_active_cards=$3
       WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING id`,
      [credentialId,account.principalId,input.limit],
    );
    return result.rowCount ? context.json({ maxActiveCards: input.limit }) : context.json({ error: "not_found" },404);
  });

  app.put("/api/dashboard/credentials/:credentialId/live-activity-policy", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const credentialId = internalId("key",context.req.param("credentialId"));
    if (!credentialId) return context.json({ error: "not_found" },404);
    const policy = liveActivityPresentationPolicySchema.parse(await context.req.json());
    // The computer's open cards follow the change in the same transaction.
    const saved = await changeAppearance(db,{ principalId: account.principalId,credentialId },apnsMode,
      async (tx) => (await tx.query(
        `UPDATE principal_api_keys SET live_activity_policy=$3::jsonb
         WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING id`,
        [credentialId,account.principalId,policy])).rowCount ? true : null);
    return saved
      ? context.json({ policy,source: "client" })
      : context.json({ error: "not_found" },404);
  });

  app.delete("/api/dashboard/credentials/:credentialId/live-activity-policy", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const credentialId = internalId("key",context.req.param("credentialId"));
    if (!credentialId) return context.json({ error: "not_found" },404);
    const reset = await changeAppearance(db,{ principalId: account.principalId,credentialId },apnsMode,
      async (tx) => (await tx.query(
        `UPDATE principal_api_keys SET live_activity_policy=NULL
         WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING id`,
        [credentialId,account.principalId])).rowCount ? true : null);
    if (!reset) return context.json({ error: "not_found" },404);
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
