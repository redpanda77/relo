import type { Hono } from "hono";
import { z } from "zod";
import { lockAccountLifecycle } from "../account-lifecycle.js";
import { apnsTransportTruth } from "../delivery-observability.js";
import type { WebRouteContext } from "./route-context.js";

/** Owner sign-up and sign-in, the session, delivery status and account deletion. */
export function registerAccountRoutes(app: Hono, shared: WebRouteContext): void {
  const { db,accountAuth,bootstrapOwnerHandle,apnsMode,accountMutationAccount } = shared;
  app.post("/api/auth/sign-up/email", async (context) => {
    const client = await db.connect();
    let createdUserId: string | undefined;
    // The database clock writes auth.users.created_at; compare against the same clock.
    const signupStartedAt = (await db.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    const signupPayload = await context.req.raw.clone().json().catch(() => null) as { email?: unknown } | null;
    const signupEmail = typeof signupPayload?.email === "string" ? signupPayload.email : undefined;
    const compensateUnmappedIdentity = async () => {
      await db.query(
        `DELETE FROM auth.users u WHERE NOT EXISTS (
           SELECT 1 FROM account_identities i WHERE i.provider='better-auth' AND i.subject=u.id
         ) AND (
           ($1::text IS NOT NULL AND u.id=$1)
           OR ($2::text IS NOT NULL AND lower(u.email)=lower($2) AND u.created_at >= $3)
         )`,
        [createdUserId ?? null,signupEmail ?? null,signupStartedAt],
      );
    };
    try {
      await client.query("BEGIN");
      await lockAccountLifecycle(client);
      const claimed = await client.query("SELECT 1 FROM account_identities LIMIT 1");
      if (claimed.rowCount) {
        await client.query("ROLLBACK");
        return context.json({ error: "account_already_configured" },403);
      }

      const authResponse = await accountAuth.handler(context.req.raw);
      if (!authResponse.ok) {
        await client.query("ROLLBACK");
        await compensateUnmappedIdentity();
        return authResponse;
      }
      const payload = await authResponse.clone().json() as { user?: { id?: string } };
      if (!payload.user?.id) {
        await client.query("ROLLBACK");
        await compensateUnmappedIdentity();
        return context.json({ error: "account_setup_failed" },500);
      }
      createdUserId = payload.user.id;

      const mapping = await client.query(
        `INSERT INTO account_identities(principal_id,provider,subject)
         SELECT id,'better-auth',$2 FROM owner_principals WHERE handle=$1 AND disabled_at IS NULL
         ON CONFLICT DO NOTHING RETURNING principal_id`,
        [bootstrapOwnerHandle,payload.user.id],
      );
      if (!mapping.rowCount) {
        await client.query("DELETE FROM auth.users WHERE id=$1",[payload.user.id]);
        await client.query("COMMIT");
        return context.json({ error: "owner_not_bootstrapped" },503);
      }
      await client.query("COMMIT");
      return authResponse;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {
        // The separately committed Better Auth identity is compensated through the pool below.
      }
      try {
        await compensateUnmappedIdentity();
      } catch (cleanupError) {
        throw new AggregateError([error,cleanupError],"Owner signup and orphan-identity compensation both failed");
      }
      throw error;
    } finally { client.release(); }
  });

  app.post("/api/auth/sign-in/email", async (context) => {
    const input = await context.req.raw.clone().json().catch(() => null) as { rememberMe?: unknown } | null;
    if (!input || input.rememberMe !== true) return context.json({ error: "invalid_request" }, 400);
    return accountAuth.handler(context.req.raw);
  });

  app.get("/api/auth/get-session", async (context) => {
    const response = await accountAuth.handler(context.req.raw);
    if (!response.ok) return response;
    const payload = await response.clone().json().catch(() => null);
    return payload ? response : context.json({ error: "reauthentication_required" }, 401);
  });

  app.get("/api/account/deliveries/status", async (context) => {
    const account = await accountMutationAccount(context);
    if (account instanceof Response) return account;
    context.header("cache-control", "private, no-store");
    return context.json({ apns: apnsTransportTruth(apnsMode) });
  });

  app.post("/api/account/delete", async (context) => {
    const account = await accountMutationAccount(context);
    if (account instanceof Response) return account;
    const input = z.object({
      password: z.string().min(8).max(128),
      confirmation: z.literal("DELETE"),
    }).strict().parse(await context.req.json());
    try {
      await accountAuth.api.verifyPassword({
        body: { password: input.password },
        headers: context.req.raw.headers,
      });
    } catch {
      return context.json({ error: "invalid_password" },401);
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await lockAccountLifecycle(client);
      const locked = await client.query<{ principal_id: string }>(
        `SELECT principal_id FROM account_identities
         WHERE provider='better-auth' AND subject=$1 AND principal_id=$2 FOR UPDATE`,
        [account.user.id,account.principalId],
      );
      if (!locked.rowCount) {
        await client.query("ROLLBACK");
        return context.json({ error: "account_not_found" },404);
      }
      await client.query(
        `DELETE FROM request_rate_limits WHERE
          (scope_kind='account' AND scope_id=$1)
          OR (scope_kind='client' AND scope_id IN (SELECT id FROM principal_api_keys WHERE principal_id=$1))
          OR (scope_kind='device' AND scope_id IN (SELECT id FROM devices WHERE principal_id=$1))
          OR (scope_kind='service' AND scope_id IN (SELECT id FROM webhook_services WHERE principal_id=$1))`,
        [account.principalId],
      );
      await client.query("DELETE FROM device_authorizations WHERE approved_owner_id=$1 OR approved_owner_id IS NULL",[account.principalId]);
      await client.query("DELETE FROM auth.verifications");
      await client.query("DELETE FROM auth.users WHERE id=$1",[account.user.id]);
      // Deleting the account revokes the phone, which ends its cards; allow their rows to go.
      await client.query("SET LOCAL relo.allow_active_activity_delete = 'on'");
      await client.query("DELETE FROM owner_principals WHERE id=$1",[account.principalId]);
      await client.query(
        `INSERT INTO owner_principals(handle) VALUES ($1)
         ON CONFLICT (handle) DO UPDATE SET disabled_at=NULL RETURNING id`,
        [bootstrapOwnerHandle],
      );
      await client.query("COMMIT");
      return context.json({ ok: true });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  app.on(["GET", "POST"], "/api/auth/*", (context) => accountAuth.handler(context.req.raw));

}
