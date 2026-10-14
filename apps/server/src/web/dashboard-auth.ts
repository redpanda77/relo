import type { Handler } from "hono";
import { registrationMode } from "../server-accounts.js";
import type { Database } from "../db.js";
import { secureHtml } from "./http.js";
import type { z } from "zod";
import { dashboardAuthSchema } from "@relo/notification-contracts/dashboard/auth";

export type DashboardAuthBootstrap = z.input<typeof dashboardAuthSchema>;

type DashboardAuthDependencies = {
  db: Database;
  /** Open registration on a public HTTPS origin is shown as Approval, as sign-up treats it. */
  appUrl?: string;
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
  const { db, appUrl, getAccount, renderDocument } = dependencies;

  return async (context) => {
    if (await getAccount(context.req.raw.headers))
      return context.redirect("/dashboard");

    const claimed = Boolean(
      (await db.query("SELECT 1 FROM account_identities LIMIT 1")).rowCount,
    );
    const path = context.req.path === "/sign-in" ? "/sign-in" : "/";
    const next = context.req.query("next");
    const bootstrap: DashboardAuthBootstrap = {
      version: 1,
      kind: "auth",
      // A visitor to a claimed server meets the landing page; a return path or setup goes straight to the form.
      view: path === "/" && claimed && next === undefined ? "landing" : "form",
      route: { path, nextPath: nextPath(next) },
      mode: claimed ? "sign-in" : "sign-up",
      registration: claimed ? await registrationMode(db,appUrl) : "closed",
      title: claimed ? "Sign in to Relo" : "Create the owner account",
      description: claimed
        ? "Use the same account as your iPhone."
        : "The first account owns this server and decides who else can join.",
    };

    return secureHtml(context, await renderDocument(bootstrap));
  };
}
