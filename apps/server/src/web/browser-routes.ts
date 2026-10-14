import type { Hono } from "hono";
import { listClientKeys } from "../device-keys.js";
import {
  browserStatus,
  registerBrowser,
  registerBrowserSchema,
  SEALED_ENVELOPE_IDS_MAX,
  sealedEnvelopesForBrowser,
  unlinkBrowser,
} from "../linked-browsers.js";
import { purgeUnreadableContent } from "../unreadable-content.js";
import { pendingDevices } from "../device-approvals.js";
import { endToEndPolicy,setEndToEndRequired } from "../end-to-end-policy.js";
import { getOwnerAccount } from "./owner-account.js";
import type { WebRouteContext } from "./route-context.js";

/**
 * Linked-browser routes for the signed-in Dashboard (docs/END-TO-END-ENCRYPTION.md, "Linked
 * browsers"). Registering publishes public keys only; envelopes go only to a browser a trusted
 * phone linked, and only the browser can open them.
 */
export function registerBrowserRoutes(app: Hono, shared: WebRouteContext): void {
  const { db,accountAuth,accountMutationAccount,apnsMode } = shared;

  app.post("/api/dashboard/browser", async (context) => {
    const account = await accountMutationAccount(context);
    if (account instanceof Response) return account;
    const parsed = registerBrowserSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "invalid_browser" },400);
    const result = await registerBrowser(db,account.principalId,parsed.data);
    if (!result.ok) return context.json({ error: result.error },result.error === "browser_id_taken" ? 409 : 400);
    return context.json({ browserId: result.browserId,linked: result.linked });
  });

  app.get("/api/dashboard/browser/:browserId", async (context) => {
    const account = await getOwnerAccount(db,accountAuth,context.req.raw.headers);
    if (!account) return context.json({ error: "unauthorized" },401);
    const status = await browserStatus(db,account.principalId,context.req.param("browserId") ?? "");
    context.header("cache-control","private, no-store");
    return status ? context.json(status) : context.json({ error: "browser_not_found" },404);
  });

  // Signing out: the browser revokes its own record before deleting its keys (review L5).
  app.delete("/api/dashboard/browser/:browserId", async (context) => {
    const account = await accountMutationAccount(context);
    if (account instanceof Response) return account;
    const removed = await unlinkBrowser(db,account.principalId,context.req.param("browserId") ?? "");
    if (removed) await purgeUnreadableContent(db,account.principalId,apnsMode);
    return removed ? context.body(null,204) : context.json({ error: "browser_not_found" },404);
  });

  // Phones waiting for approval (a trusted phone or a linked browser approves them: admin-routes.ts).
  app.get("/api/dashboard/pending-devices", async (context) => {
    const account = await getOwnerAccount(db,accountAuth,context.req.raw.headers);
    if (!account) return context.json({ error: "unauthorized" },401);
    context.header("cache-control","private, no-store");
    return context.json({ devices: (await pendingDevices(db,account.principalId))
      .map(({ deviceId,name,model,modelName,isSimulator,registeredAt,keyId }) =>
        ({ deviceId,name,model,modelName,isSimulator,registeredAt,keyId })) });
  });

  // The owner, signed in, may set the end-to-end requirement to on, auto or off (gap 5).
  app.get("/api/dashboard/end-to-end/policy", async (context) => {
    const account = await getOwnerAccount(db,accountAuth,context.req.raw.headers);
    if (!account) return context.json({ error: "unauthorized" },401);
    return context.json(await endToEndPolicy(db,account.principalId));
  });

  app.put("/api/dashboard/end-to-end/policy", async (context) => {
    const account = await accountMutationAccount(context);
    if (account instanceof Response) return account;
    const body = await context.req.json().catch(() => null) as { required?: unknown } | null;
    if (!body || !(typeof body.required === "boolean" || body.required === null) || Object.keys(body).length !== 1) {
      return context.json({ error: "invalid_request" },400);
    }
    await setEndToEndRequired(db,account.principalId,body.required as boolean | null);
    return context.json(await endToEndPolicy(db,account.principalId));
  });

  app.get("/api/dashboard/client-keys", async (context) => {
    const account = await getOwnerAccount(db,accountAuth,context.req.raw.headers);
    if (!account) return context.json({ error: "unauthorized" },401);
    context.header("cache-control","private, no-store");
    return context.json({ clients: await listClientKeys(db,account.principalId) });
  });

  app.get("/api/dashboard/sealed", async (context) => {
    const account = await getOwnerAccount(db,accountAuth,context.req.raw.headers);
    if (!account) return context.json({ error: "unauthorized" },401);
    const ids = new URL(context.req.url).searchParams.getAll("id");
    if (ids.length > SEALED_ENVELOPE_IDS_MAX) return context.json({ error: "too_many_ids" },400);
    const envelopes = await sealedEnvelopesForBrowser(db,account.principalId,context.req.header("x-relo-browser") ?? "",ids);
    if (!envelopes) return context.json({ error: "browser_not_linked" },403);
    context.header("cache-control","private, no-store");
    return context.json({ envelopes });
  });
}
