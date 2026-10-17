import { createAccountAuth } from "../account-auth.js";
import { createApp } from "../app.js";
import { createAuthDatabase } from "../db.js";

/**
 * Every route the server registers, as `METHOD /path` with Hono's `:param` patterns, from the whole app as it
 * runs (API and web routes). Building it queries nothing. The route sweeps (API description, request policy,
 * webhook scopes) all read this one inventory.
 */
export function listRoutes(filter: RegExp = /^\/(api|hooks)(\/|$)/u): string[] {
  const db = { query: async () => ({ rows: [],rowCount: 0 }),connect: async () => ({ query: async () => ({ rows: [] }),release() {} }) } as never;
  const secret = "route-inventory-secret-at-least-32-characters";
  const appUrl = "https://relo.example.com";
  const app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: secret,appUrl,
    accountAuth: createAccountAuth(createAuthDatabase("postgresql://relo@127.0.0.1:1/never"),appUrl,secret) });
  return [...new Set(app.routes.filter((route) => route.method !== "ALL" && filter.test(route.path))
    .map((route) => `${route.method} ${route.path}`))];
}
