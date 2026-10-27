import type { Hono } from "hono";
import { z } from "zod";
import { lockAccountLifecycle } from "../account-lifecycle.js";
import { accountBackoff,authAttemptLimited,isKnownDevice,recordSignInFailure,recordSignInSuccess } from "../auth-throttle.js";
import { apnsTransportTruth } from "../delivery-observability.js";
import {
  claimBootstrappedOwner,createAccountPrincipal,isServerAdmin,registrationMode,requestAccountApproval,signInRefusal,
} from "../server-accounts.js";
import { pendingSignInRedirect } from "../mobile-sign-in.js";
import type { WebRouteContext } from "./route-context.js";

/** Owner sign-up and sign-in, the session, delivery status and account deletion. */
export function registerAccountRoutes(app: Hono, shared: WebRouteContext): void {
  const { db,accountAuth,bootstrapOwnerHandle,apnsMode,accountMutationAccount,notificationContentCipher } = shared;
  app.post("/api/auth/sign-up/email", async (context) => {
    const throttled = authAttemptLimited(context,"sign-up");
    if (throttled) return throttled;
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
      const claimed = Boolean((await client.query("SELECT 1 FROM account_identities LIMIT 1")).rowCount);
      const mode = claimed ? await registrationMode(client,shared.appUrl) : null;
      if (mode === "closed") {
        await client.query("ROLLBACK");
        return context.json({ error: "registration_closed" },403);
      }

      const authResponse = await accountAuth.handler(context.req.raw);
      if (!authResponse.ok) {
        await client.query("ROLLBACK");
        await compensateUnmappedIdentity();
        // Never say whether an email already has an account: with approval the reply is the same as
        // for a new request, and open registration gives the same generic failure for any refusal.
        const failure = await authResponse.clone().json().catch(() => null) as { code?: unknown } | null;
        if (claimed && typeof failure?.code === "string" && /ALREADY_EXISTS/u.test(failure.code)) {
          return mode === "approval"
            ? context.json({ status: "approval_pending" },202)
            : context.json({ error: "sign_up_failed",message: "Couldn't create this account. If you already have one, sign in." },400);
        }
        return authResponse;
      }
      const payload = await authResponse.clone().json() as { user?: { id?: string } };
      if (!payload.user?.id) {
        await client.query("ROLLBACK");
        await compensateUnmappedIdentity();
        return context.json({ error: "account_setup_failed" },500);
      }
      createdUserId = payload.user.id;

      if (claimed) {
        // ADR 0004: everyone after the first person gets an empty account of their own.
        await createAccountPrincipal(client,payload.user.id,{ approved: mode === "open" });
      } else {
        // The first person claims the bootstrapped account and administers the server.
        if (!await claimBootstrappedOwner(client,bootstrapOwnerHandle,payload.user.id)) {
          await client.query("DELETE FROM auth.users WHERE id=$1",[payload.user.id]);
          await client.query("COMMIT");
          return context.json({ error: "owner_not_bootstrapped" },503);
        }
      }
      if (mode === "approval") {
        await client.query("DELETE FROM auth.sessions WHERE user_id=$1",[payload.user.id]);
        await client.query("COMMIT");
        const person = payload as { user: { id: string; name?: string; email?: string } };
        try {
          await requestAccountApproval(db,{ subject: person.user.id,name: person.user.name ?? "Someone",
            email: person.user.email ?? "" },{ apnsMode,contentCipher: notificationContentCipher,appUrl: shared.appUrl });
        } catch (error) {
          // The request stays pending in the Dashboard even when the phone cannot be asked.
          console.error("account request approval failed",{ message: error instanceof Error ? error.message : "unknown" });
        }
        // Inside an app's browser sign-in the browser goes back to the app with a ticket it can poll.
        const redirect = await pendingSignInRedirect(db,context.req.raw.headers,payload.user.id);
        return context.json(redirect ? { status: "approval_pending",redirect } : { status: "approval_pending" },202);
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
    const input = await context.req.raw.clone().json().catch(() => null) as { email?: unknown; rememberMe?: unknown } | null;
    const email = typeof input?.email === "string" ? input.email : "";
    const knownDevice = email !== "" && isKnownDevice(context,email);
    const throttled = authAttemptLimited(context,"sign-in",Date.now(),knownDevice) ?? (knownDevice ? null : accountBackoff(context,email));
    if (throttled) return throttled;
    if (!input || input.rememberMe !== true) return context.json({ error: "invalid_request" }, 400);
    const response = await accountAuth.handler(context.req.raw);
    if (!response.ok) {
      if (email && response.status === 401) recordSignInFailure(email);
      return response;
    }
    const payload = await response.clone().json().catch(() => null) as { user?: { id?: string }; twoFactorRedirect?: boolean } | null;
    // The password was right and the account has two-step sign-in: no session yet, the code comes next.
    if (payload?.twoFactorRedirect === true) return response;
    return finishSignIn(response,payload?.user?.id,email,context.req.raw.headers);
  });

  /** A signed-in response for an account the server still allows; otherwise its sessions are removed. */
  async function finishSignIn(response: Response,userId: string | undefined,email: string,headers: Headers): Promise<Response> {
    const refusal = userId ? await signInRefusal(db,userId) : "account_disabled";
    if (!refusal) {
      const signedIn = new Response(response.body,response);
      if (email) signedIn.headers.append("set-cookie",recordSignInSuccess(email,shared.appUrl.startsWith("https://")));
      return signedIn;
    }
    if (userId) await db.query("DELETE FROM auth.sessions WHERE user_id=$1",[userId]);
    const redirect = refusal === "approval_pending" && userId ? await pendingSignInRedirect(db,headers,userId) : null;
    return Response.json(redirect ? { error: refusal,redirect } : { error: refusal },{ status: 403 });
  }

  // The second step of a two-step sign-in (docs/HARDENING.md, gap 1): the same limits and account checks.
  for (const step of ["verify-totp","verify-backup-code"]) {
    app.post(`/api/auth/two-factor/${step}`, async (context) => {
      const throttled = authAttemptLimited(context,"sign-in");
      if (throttled) return throttled;
      const response = await accountAuth.handler(context.req.raw);
      if (!response.ok) return response;
      const payload = await response.clone().json().catch(() => null) as { user?: { id?: string; email?: string } } | null;
      return finishSignIn(response,payload?.user?.id,payload?.user?.email ?? "",context.req.raw.headers);
    });
  }

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
      if (await isServerAdmin(client,account.user.id)) {
        const others = await client.query("SELECT 1 FROM account_identities WHERE principal_id<>$1 LIMIT 1",[account.principalId]);
        if (others.rowCount) {
          await client.query("ROLLBACK");
          return context.json({ error: "admin_has_other_accounts" },409);
        }
      }
      await deleteAccountRecords(client,account.principalId,bootstrapOwnerHandle);
      await client.query("COMMIT");
      return context.json({ ok: true });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  app.on(["GET", "POST"], "/api/auth/*", (context) => accountAuth.handler(context.req.raw));

}

/** Removes an account and everything it owns; only the bootstrapped account comes back, unclaimed. */
export async function deleteAccountRecords(
  client: { query: (sql: string,values?: unknown[]) => Promise<unknown> },
  principalId: string,
  bootstrapOwnerHandle: string,
): Promise<void> {
  await client.query(
    `DELETE FROM request_rate_limits WHERE
      (scope_kind='account' AND scope_id=$1)
      OR (scope_kind='client' AND scope_id IN (SELECT id FROM principal_api_keys WHERE principal_id=$1))
      OR (scope_kind='device' AND scope_id IN (SELECT id FROM devices WHERE principal_id=$1))
      OR (scope_kind='service' AND scope_id IN (SELECT id FROM webhook_services WHERE principal_id=$1))`,
    [principalId],
  );
  await client.query("DELETE FROM device_authorizations WHERE approved_owner_id=$1",[principalId]);
  await client.query(
    "DELETE FROM auth.users WHERE id IN (SELECT subject FROM account_identities WHERE principal_id=$1)",[principalId]);
  const handle = await client.query("SELECT handle FROM owner_principals WHERE id=$1",[principalId]) as { rows: { handle: string }[] };
  // Deleting the account revokes the phone, which ends its cards; allow their rows to go.
  await client.query("SET LOCAL relo.allow_active_activity_delete = 'on'");
  await client.query("DELETE FROM owner_principals WHERE id=$1",[principalId]);
  if (handle.rows[0]?.handle === bootstrapOwnerHandle) {
    await client.query(
      `INSERT INTO owner_principals(handle) VALUES ($1)
       ON CONFLICT (handle) DO UPDATE SET disabled_at=NULL`,
      [bootstrapOwnerHandle],
    );
  }
}
