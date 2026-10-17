import type { Hono } from "hono";
import { listClientKeys } from "../device-keys.js";
import {
  browserStatus,
  declineBrowserLinkRequest,
  registerBrowser,
  registerBrowserSchema,
  requestBrowserLink,
  SEALED_ENVELOPE_IDS_MAX,
  sealedEnvelopesForBrowser,
  unlinkBrowser,
} from "../linked-browsers.js";
import { purgeUnreadableContent } from "../unreadable-content.js";
import { announceBrowserLinkRequest,pendingDevices } from "../device-approvals.js";
import { approveComputer,browserComputerApprovalSchema,listApprovers } from "../computer-approvals.js";
import { createInvite,createInviteSchema,inviteStatus } from "../computer-invites.js";
import { setupProgress } from "./setup-progress.js";
import { endToEndPolicy,setEndToEndRequired } from "../end-to-end-policy.js";
import { admitBrowserAnswer,browserAnswerSchema,browserQuestion } from "../browser-answers.js";
import { internalId,publicId } from "../ids.js";
import { respondToInteraction } from "../interactions/commands.js";
import { consumeRateLimit } from "../rate-limit.js";
import { getOwnerAccount } from "./owner-account.js";
import type { WebRouteContext } from "./route-context.js";

/**
 * Linked-browser routes for the signed-in Dashboard (docs/ENCRYPTION-PROTOCOL.md, "Linked
 * browsers"). Registering publishes public keys only; envelopes go only to a browser a trusted
 * phone linked, and only the browser can open them.
 */
export function registerBrowserRoutes(app: Hono, shared: WebRouteContext): void {
  const { db,accountAuth,accountMutationAccount,ownerAdminAccount,apnsMode,notificationContentCipher } = shared;

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

  // "Approve on my iPhone" (docs/ENCRYPTION-PROTOCOL.md, "Linking (approval on the iPhone)"): the trusted phones
  // are told; the phone lists the request and signs the same link statement as a scanned QR code.
  app.post("/api/dashboard/browser/:browserId/link-request", async (context) => {
    const account = await accountMutationAccount(context);
    if (account instanceof Response) return account;
    const browserId = context.req.param("browserId") ?? "";
    const result = await requestBrowserLink(db,account.principalId,browserId);
    if (!result.ok) {
      if (result.error === "too_soon") context.header("retry-after","30");
      return context.json({ error: result.error },result.error === "browser_not_found" ? 404 : result.error === "already_linked" ? 409 : 429);
    }
    let phones: number;
    try {
      phones = await announceBrowserLinkRequest(db,account.principalId,result,apnsMode,notificationContentCipher);
    } catch (error) {
      // Not sent: free the request so a retry is not held back by too_soon.
      await declineBrowserLinkRequest(db,account.principalId,browserId);
      console.warn(JSON.stringify({ event: "browser_link_notice_failed",message: error instanceof Error ? error.message : String(error) }));
      return context.json({ error: "notice_not_sent" },502);
    }
    if (!phones) {
      await declineBrowserLinkRequest(db,account.principalId,browserId);
      return context.json({ error: "no_phone" },409);
    }
    return context.json({ requested: true,phones });
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

  // Computers are approved once, on any trusted device (docs/ENCRYPTION-PROTOCOL.md): a linked browser signs a
  // computer's current key with its own identity key; every device verifies it against the approvers it pinned.
  app.post("/api/dashboard/computers/:clientId/approve", async (context) => {
    const account = await ownerAdminAccount(context);
    if (account instanceof Response) return account;
    const parsed = browserComputerApprovalSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "invalid_approval" },400);
    const clientId = context.req.param("clientId") ?? "";
    const { browserId,...approval } = parsed.data;
    const result = await approveComputer(db,account.principalId,{ browserId },{ clientId,...approval });
    if (!result.ok) {
      const status = result.error === "computer_not_found" ? 404 : result.error === "identity_mismatch" ? 409
        : result.error === "approver_not_allowed" ? 403 : 400;
      return context.json({ error: result.error },status);
    }
    return context.json({ clientId,approved: true });
  });

  // Add a computer from the Dashboard (docs/site/guides/servers.md): a one-time code and the command to paste.
  app.post("/api/dashboard/computer-invites", async (context) => {
    const account = await ownerAdminAccount(context);
    if (account instanceof Response) return account;
    const parsed = createInviteSchema.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success) return context.json({ error: "invalid_invite" },400);
    return context.json(await createInvite(db,account.principalId,{ kind: "browser",name: "the Dashboard" },parsed.data,
      new URL(shared.appUrl).origin),201);
  });

  app.get("/api/dashboard/computer-invites/:inviteId", async (context) => {
    const account = await ownerAdminAccount(context);
    if (account instanceof Response) return account;
    const status = await inviteStatus(db,account.principalId,context.req.param("inviteId"));
    context.header("cache-control","private, no-store");
    return status ? context.json(status) : context.json({ error: "not_found" },404);
  });

  // The Now page's Set up checklist, read from real state.
  app.get("/api/dashboard/setup", async (context) => {
    const account = await getOwnerAccount(db,accountAuth,context.req.raw.headers);
    if (!account) return context.json({ error: "unauthorized" },401);
    context.header("cache-control","private, no-store");
    return context.json(await setupProgress(db,account.principalId));
  });

  app.get("/api/dashboard/approvers", async (context) => {
    const account = await getOwnerAccount(db,accountAuth,context.req.raw.headers);
    if (!account) return context.json({ error: "unauthorized" },401);
    context.header("cache-control","private, no-store");
    return context.json({ approvers: await listApprovers(db,account.principalId) });
  });

  // A question as a linked browser answers it (docs/ENCRYPTION-PROTOCOL.md, "Answering from a linked browser").
  app.get("/api/dashboard/questions/:interactionId", async (context) => {
    const account = await getOwnerAccount(db,accountAuth,context.req.raw.headers);
    if (!account) return context.json({ error: "unauthorized" },401);
    context.header("cache-control","private, no-store");
    // Any copy's id resolves to the copy the asker waits on; the header tells whether this browser can open it.
    const question = await browserQuestion(db,account.principalId,context.req.param("interactionId") ?? "",
      context.req.header("x-relo-browser") ?? undefined);
    return question ? context.json({ question }) : context.json({ error: "not_found" },404);
  });

  // A linked browser answers with its own identity key's signature, like a phone. The server admits
  // and relays it exactly like a phone's answer; computers decide whether a browser's answer counts.
  app.post("/api/dashboard/questions/:interactionId/answer", async (context) => {
    const account = await ownerAdminAccount(context);
    if (account instanceof Response) return account;
    const limited = await consumeRateLimit(db,{ scope: "account",id: account.principalId,family: "decision-responses",limit: 300 });
    if (!limited.allowed) {
      context.header("retry-after",String(limited.retryAfterSeconds));
      return context.json({ error: "rate_limited",retryAfterSeconds: limited.retryAfterSeconds },429);
    }
    const parsed = browserAnswerSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "invalid_answer" },400);
    const interactionPublicId = context.req.param("interactionId") ?? "";
    const browserPublicId = context.req.header("x-relo-browser") ?? "";
    const admitted = await admitBrowserAnswer(db,account.principalId,browserPublicId,interactionPublicId,parsed.data);
    if (!admitted.ok) {
      const status = admitted.error === "browser_not_linked" || admitted.error === "question_unreadable" ? 403
        : admitted.error === "not_found" ? 404 : admitted.error === "not_asked_copy" ? 409 : 400;
      return context.json({ error: admitted.error },status);
    }
    const input = parsed.data;
    const result = await respondToInteraction(db,{ kind: "browser",principalId: account.principalId,browserId: admitted.browserId },{
      eventId: internalId("ntf",input.notificationId)!,interactionId: internalId("int",interactionPublicId)!,kind: input.action,
      value: { ...(input.optionId ? { optionId: input.optionId } : {}),...input.signature },
      // Namespaced by browser: a browser's key can never collide with (or replay) a phone's answer.
      idempotencyKey: `browser:${browserPublicId}:${input.idempotencyKey}`,
    },{ apnsMode });
    if (result.kind === "rejected") {
      return context.json({ error: result.error,...(result.state ? { state: result.state } : {}) },
        result.error === "not_found" || result.error === "interaction_not_found" ? 404 : result.error === "invalid_action" ? 400
          : result.error === "forbidden" ? 403 : 409);
    }
    return context.json({ interactionId: publicId("int",result.interactionId),state: result.state,
      replayed: result.kind === "replayed",late: result.late === true,respondedAt: result.respondedAt },
    result.kind === "accepted" && !result.late ? 201 : 200);
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
