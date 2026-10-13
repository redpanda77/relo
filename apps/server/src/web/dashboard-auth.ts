import type { Handler } from "hono";
import { registrationMode } from "../server-accounts.js";
import type { Database } from "../db.js";
import { secureHtml } from "./http.js";
import type { z } from "zod";
import { dashboardAuthSchema } from "@relo/notification-contracts/dashboard/auth";

export type DashboardAuthBootstrap = z.input<typeof dashboardAuthSchema>;

type DashboardAuthDependencies = {
  db: Database;
  getAccount(headers: Headers): Promise<unknown | null>;
  renderDocument(bootstrap: DashboardAuthBootstrap): Promise<string>;
};

function nextPath(value: string | undefined): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f]/.test(value)
  )
    return "/dashboard";
  return value;
}

export function createDashboardAuthHandler(
  dependencies: DashboardAuthDependencies,
): Handler {
  const { db, getAccount, renderDocument } = dependencies;

  return async (context) => {
    if (await getAccount(context.req.raw.headers))
      return context.redirect("/dashboard");

    const claimed = Boolean(
      (await db.query("SELECT 1 FROM account_identities LIMIT 1")).rowCount,
    );
    const bootstrap: DashboardAuthBootstrap = {
      version: 1,
      kind: "auth",
      route: { path: "/", nextPath: nextPath(context.req.query("next")) },
      mode: claimed ? "sign-in" : "sign-up",
      registration: claimed ? await registrationMode(db) : "closed",
      title: claimed ? "Sign in to Relo" : "Create the owner account",
      description: claimed
        ? "Use the same account as your iPhone."
        : "The first account owns this server and decides who else can join.",
    };

    return secureHtml(context, await renderDocument(bootstrap));
  };
}
