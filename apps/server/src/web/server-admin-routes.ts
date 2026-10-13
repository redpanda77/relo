import type { Hono } from "hono";
import { z } from "zod";
import { lockAccountLifecycle } from "../account-lifecycle.js";
import {
  accountAccessActions,changeAccountAccess,createServerAccount,listServerAccounts,registrationMode,
  registrationModes,ServerAccountError,setRegistrationMode,settleAccountRequest,
} from "../server-accounts.js";
import { deleteAccountRecords } from "./account-routes.js";
import { QUESTION_CEILING_SECONDS,QUESTION_SECONDS } from "../question-policy.js";
import { maxQuestionSeconds,setMaxQuestionSeconds } from "../question-wait.js";
import { PRIVATE_CALLBACK_POLICIES,privateCallbackPolicy } from "../callback-destinations.js";
import type { WebRouteContext } from "./route-context.js";

/** ADR 0004: the server admin decides who may register and who keeps access. No account data here. */
export function registerServerAdminRoutes(app: Hono, shared: WebRouteContext): void {
  const { db,bootstrapOwnerHandle,serverAdminAccount,apnsMode } = shared;

  const refused = (context: any,error: unknown) => {
    if (error instanceof ServerAccountError) return context.json({ error: error.code },error.status);
    throw error;
  };

  app.get("/api/dashboard/server", async (context) => {
    const account = await serverAdminAccount(context);
    if (account instanceof Response) return account;
    context.header("cache-control","private, no-store");
    return context.json({ registrationMode: await registrationMode(db),maxQuestionSeconds: await maxQuestionSeconds(db),
      privateCallbacks: await privateCallbackPolicy(db),accounts: await listServerAccounts(db) });
  });

  app.put("/api/dashboard/server/registration", async (context) => {
    const account = await serverAdminAccount(context);
    if (account instanceof Response) return account;
    const input = z.object({ mode: z.enum(registrationModes) }).strict().parse(await context.req.json());
    await setRegistrationMode(db,input.mode);
    return context.json({ registrationMode: input.mode });
  });

  app.put("/api/dashboard/server/private-callbacks", async (context) => {
    const account = await serverAdminAccount(context);
    if (account instanceof Response) return account;
    const input = z.object({ policy: z.enum(PRIVATE_CALLBACK_POLICIES) }).strict().parse(await context.req.json());
    await db.query("UPDATE server_settings SET private_callbacks=$1,updated_at=now() WHERE singleton",[input.policy]);
    return context.json({ privateCallbacks: input.policy });
  });

  app.put("/api/dashboard/server/question-wait", async (context) => {
    const account = await serverAdminAccount(context);
    if (account instanceof Response) return account;
    const input = z.object({ seconds: z.number().int().min(QUESTION_SECONDS).max(QUESTION_CEILING_SECONDS) })
      .strict().parse(await context.req.json());
    await setMaxQuestionSeconds(db,input.seconds);
    return context.json({ maxQuestionSeconds: input.seconds });
  });

  app.post("/api/dashboard/server/accounts", async (context) => {
    const account = await serverAdminAccount(context);
    if (account instanceof Response) return account;
    const input = z.object({
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().email().max(320),
      password: z.string().min(8).max(128),
    }).strict().parse(await context.req.json());
    try {
      return context.json(await createServerAccount(db,input),201);
    } catch (error) { return refused(context,error); }
  });

  app.post("/api/dashboard/server/accounts/:userId/delete", async (context) => {
    const account = await serverAdminAccount(context);
    if (account instanceof Response) return account;
    z.object({ confirmation: z.literal("DELETE") }).strict().parse(await context.req.json());
    const subject = context.req.param("userId");
    if (subject === account.user.id) return context.json({ error: "cannot_change_admin_access" },409);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await settleAccountRequest(client,subject,"canceled",apnsMode);
      await lockAccountLifecycle(client);
      const target = await client.query<{ principal_id: string; server_admin: boolean }>(
        `SELECT principal_id,server_admin FROM account_identities
         WHERE provider='better-auth' AND subject=$1 AND role='owner' FOR UPDATE`,[subject]);
      if (!target.rowCount) {
        await client.query("ROLLBACK");
        return context.json({ error: "account_not_found" },404);
      }
      if (target.rows[0]!.server_admin) {
        await client.query("ROLLBACK");
        return context.json({ error: "cannot_change_admin_access" },409);
      }
      await deleteAccountRecords(client,target.rows[0]!.principal_id,bootstrapOwnerHandle);
      await client.query("COMMIT");
      return context.json({ ok: true });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  app.post("/api/dashboard/server/accounts/:userId/:action", async (context) => {
    const account = await serverAdminAccount(context);
    if (account instanceof Response) return account;
    const action = z.enum(accountAccessActions).safeParse(context.req.param("action"));
    if (!action.success) return context.json({ error: "not_found" },404);
    try {
      await changeAccountAccess(db,account.user.id,context.req.param("userId"),action.data,apnsMode);
      return context.json({ ok: true });
    } catch (error) { return refused(context,error); }
  });
}
