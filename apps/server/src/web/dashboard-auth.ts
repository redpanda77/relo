import type { Handler } from "hono";
import { registrationMode } from "../server-accounts.js";
import type { Database } from "../db.js";
import { secureHtml } from "./http.js";
import { bundledMacApp,bundledWindowsApp } from "../computer-invites.js";
import type { z } from "zod";
import { dashboardAuthSchema } from "@relo/notification-contracts/dashboard/auth";

export type DashboardAuthBootstrap = z.input<typeof dashboardAuthSchema>;

type DashboardAuthDependencies = {
  db: Database;
  /** Open registration on a public HTTPS origin is shown as Approval, as sign-up treats it. */
  appUrl?: string;
  /** The launch film's https folder (RELO_LANDING_FILM_URL); the landing shows it only when set. */
  landingFilmUrl?: string | undefined;
  /** Sign in with Apple on the web (RELO_APPLE_SERVICES_ID); the form shows the button only when set. */
  appleWeb?: boolean;
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
  const { db, appUrl, landingFilmUrl, appleWeb = false, getAccount, renderDocument } = dependencies;
  const film = landingFilmUrl ? { base: landingFilmUrl.replace(/\/+$/, ""), origin: new URL(landingFilmUrl).origin } : null;

  return async (context) => {
    if (await getAccount(context.req.raw.headers))
      return context.redirect("/dashboard");

    const claimed = Boolean(
      (await db.query("SELECT 1 FROM account_identities LIMIT 1")).rowCount,
    );
    const path = context.req.path === "/sign-in" ? "/sign-in" : "/";
    const next = context.req.query("next");
    const landing = path === "/" && claimed && next === undefined;
    const bootstrap: DashboardAuthBootstrap = {
      version: 1,
      kind: "auth",
      // A visitor to a claimed server meets the landing page; a return path or setup goes straight to the form.
      view: landing ? "landing" : "form",
      route: { path, nextPath: nextPath(next) },
      mode: claimed ? "sign-in" : "sign-up",
      registration: claimed ? await registrationMode(db,appUrl) : "closed",
      title: claimed ? "Sign in to Relo" : "Create the owner account",
      description: claimed
        ? "Sign in with your Relo account."
        : "The first account owns this server and decides who else can join.",
      macApp: bundledMacApp() !== null,
      windowsApp: bundledWindowsApp() !== null,
      appleSignIn: appleWeb,
      ...(landing && film ? { film: { base: film.base } } : {}),
    };

    return secureHtml(context, await renderDocument(bootstrap), { mediaOrigin: landing && film ? film.origin : undefined });
  };
}
