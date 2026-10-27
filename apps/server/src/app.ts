import { answerSignatureSchema } from "./sealed-content.js";
import { respondToInteraction } from "./interactions/commands.js";
import { choiceOptionIdSchema } from "@relo/notification-contracts";
import { type InteractionChangeHub } from "./interaction-change-hub.js";
import type { CurrentChangeHub } from "./current-change-hub.js";
import { SubjectAdmissionError } from "./relevance/commands.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  
  
  registerActivityRoutes,
  type ApnsMode } from "./activities.js";
import type { AccountAuth,AppleSignInConfig } from "./account-auth.js";
import { authenticate } from "./auth.js";
import { registerIdempotentMachineRevokeRoute, registerMachineAuthRoutes, registerPublicDeviceAuthorizationRoutes } from "./device-authorization.js";
import type { Database } from "./db.js";
import { internalId } from "./ids.js";
import { registerMobileAccountRoutes } from "./mobile-auth.js";
import { registerMobileSignInRoutes } from "./mobile-sign-in.js";
import { registerAppleSignInRoutes } from "./apple-sign-in.js";
import { registerServiceApiRoutes } from "./webhooks/admin.js";
import { registerWebhookRoutes } from "./webhooks/index.js";
import { registerRequestPolicy } from "./request-policy.js";
import { registerComputerRoutes } from "./api/computer-routes.js";
import { registerCredentialRoutes } from "./api/credential-routes.js";
import { registerWebAuthRoutes } from "./web.js";
import { registerDashboardEventRoutes } from "./web/dashboard-events.js";
import { getOwnerAccount } from "./web/owner-account.js";

import {
  ApnsPayloadTooLargeError,
} from "./delivery-serialization.js";
import { createTransportTokenEncryption, type TransportTokenPurpose } from "./token-encryption.js";
import { registerDeliveryObservabilityRoutes } from "./delivery-observability.js";

import { registerContextResourceRoutes } from "./context-resources.js";
import { registerDoctorRoutes } from "./runtime-health.js";
import {
  createNotificationContentCipher } from "./notification-content.js";

import { registerDeviceRoutes } from "./api/device-routes.js";
import { registerComputerInviteRoutes,registerPublicComputerInviteRoutes } from "./api/computer-invite-routes.js";
import { bundledCli } from "./computer-invites.js";
import { registerAgentSessionRoutes } from "./api/agent-session-routes.js";
import { registerInboxRoutes } from "./api/inbox-routes.js";
import { registerNowRoutes } from "./api/now-routes.js";
import { registerNotificationRoutes } from "./api/interaction-routes.js";
import { registerWorkRoutes } from "./works/index.js";
import { registerScriptWorkRoutes } from "./works/script-routes.js";
import { registerServiceWorkRoutes } from "./webhooks/works.js";
import type { ApiRouteContext } from "./api/route-context.js";
import { publicErrorPage, publicErrorPageSecurityPolicy, wantsHtmlPage } from "./web/public-page.js";
export { inboxItemResource } from "./api/resources.js";

export const MAX_REQUEST_BODY_BYTES = 1_048_576;

export type AppDependencies = {
  interactionChanges?: InteractionChangeHub;
  currentChanges?: CurrentChangeHub;
  accountAuth: AccountAuth;
  bootstrapOwnerHandle: string;
  credentialDerivationSecret: string;
  appUrl: string;
  /** RELO_APPLE_SERVICES_ID and RELO_APPLE_BUNDLE_ID: Sign in with Apple on the web and in the iPhone app. */
  appleSignIn?: AppleSignInConfig | undefined;
  apnsMode: ApnsMode;
  /** RELO_LANDING_FILM_URL: the landing's launch film folder; unset, the landing has no film. */
  landingFilmUrl?: string | undefined;
  /** RELO_ONBOARDING_FILM_URL: the onboarding film folder, shown above Get started; unset, no film. */
  onboardingFilmUrl?: string | undefined;
};

export type AppOptions = AppDependencies | Partial<Pick<AppDependencies,"apnsMode" | "credentialDerivationSecret" | "interactionChanges" | "currentChanges">>;

export function createApp(
  db: Database,
  dependencies?: AppOptions,
): Hono {
  const app = new Hono();
  const apnsMode = dependencies?.apnsMode ?? "disabled";
  const integratedDependencies = dependencies && "accountAuth" in dependencies ? dependencies : null;

  // Every route answers whoever can reach the server; nothing legitimate sends more than this.
  app.use("*", bodyLimit({ maxSize: MAX_REQUEST_BODY_BYTES,
    onError: (context) => context.json({ error: "payload_too_large" }, 413) }));
  if (integratedDependencies?.appUrl.startsWith("https://")) {
    app.use("*", async (context, next) => {
      await next();
      try {
        if (!context.res.headers.has("strict-transport-security")) {
          context.res.headers.set("strict-transport-security", "max-age=31536000");
        }
      } catch {
        // A proxied Response can carry immutable headers; it is not a page a browser pins.
      }
    });
  }
  const tokenEncryption = dependencies?.credentialDerivationSecret
    ? createTransportTokenEncryption(dependencies.credentialDerivationSecret)
    : null;
  const notificationContentCipher = dependencies?.credentialDerivationSecret
    ? createNotificationContentCipher(dependencies.credentialDerivationSecret)
    : apnsMode === "disabled"
      ? createNotificationContentCipher("relo-test-notification-content-secret-v1")
      : null;
  const encryptedTransportToken = (token: string | null, purpose: TransportTokenPurpose): string | null => {
    if (token === null) return null;
    if (!tokenEncryption) throw new Error("Transport token encryption is not configured");
    return tokenEncryption.encrypt(token, purpose);
  };
  // Test servers run without a configured secret; production always derives the key.
  const callbackTokenEncryption = tokenEncryption
    ?? (apnsMode === "disabled" ? createTransportTokenEncryption("relo-test-callback-token-secret-v1") : null);
  const callbackEncryption = () => {
    if (!callbackTokenEncryption) throw new Error("Callback token encryption is not configured");
    return callbackTokenEncryption;
  };

  registerWebhookRoutes(app, db, apnsMode, notificationContentCipher ?? undefined, callbackEncryption);

  if (integratedDependencies) {
    // Before the web routes: their /api/auth/* catch-all would answer Apple's routes first.
    registerAppleSignInRoutes(app, db, {
      accountAuth: integratedDependencies.accountAuth, appUrl: integratedDependencies.appUrl,
      apple: integratedDependencies.appleSignIn, bootstrapOwnerHandle: integratedDependencies.bootstrapOwnerHandle,
      apnsMode, contentCipher: notificationContentCipher,
    });
    registerWebAuthRoutes(app, db, integratedDependencies);
    registerDashboardEventRoutes(app, { hub: integratedDependencies.currentChanges, appOrigin: new URL(integratedDependencies.appUrl).origin,
      getAccount: headers => getOwnerAccount(db, integratedDependencies.accountAuth, headers) });
    registerMobileAccountRoutes(app, db, integratedDependencies.accountAuth, integratedDependencies.credentialDerivationSecret);
    registerPublicDeviceAuthorizationRoutes(app, db, integratedDependencies.accountAuth, integratedDependencies.appUrl);
    registerPublicComputerInviteRoutes(app, db, integratedDependencies.appUrl);
    registerMobileSignInRoutes(app, db, integratedDependencies.accountAuth, integratedDependencies.appUrl);
    registerIdempotentMachineRevokeRoute(app, db);
  }

  app.get("/health/live", (context) => context.json({ status: "ok" }));

  const ready = async (context: any) => {
    await db.query("SELECT 1");
    // Local mode (plan 16): Relo for Mac compares the version its server runs with its own bundle after an update.
    return context.json(process.env.RELO_LOCAL_MODE === "1"
      ? { status: "ok",release: process.env.RELO_RELEASE_IDENTITY ?? null,instance: process.env.RELO_LOCAL_INSTANCE ?? null } : { status: "ok" });
  };
  app.get("/health/ready", ready);
  app.get("/health/browser-candidate-attestation", async (context) => {
    if (process.env.RELO_BROWSER_ISOLATED_CANDIDATE_API !== "1" || apnsMode !== "disabled") {
      return context.json({ error: "not_found" },404);
    }
    try {
      const result = await db.query<{ database_name: string }>(
        "SELECT current_database() AS database_name",
      );
      return result.rows[0]?.database_name === "relo_browser"
        ? context.json({ isolatedCandidate: true })
        : context.json({ error: "not_found" },404);
    } catch {
      return context.json({ error: "not_found" },404);
    }
  });

  app.onError((error, context) => {
    if (error instanceof SubjectAdmissionError) return context.json({ error: error.code },
      error.code === "not_found" ? 404 : error.code === "invalid_relevance" ? 400 : 409);
    if (error instanceof z.ZodError) return context.json({ error: "invalid_request", issues: error.issues }, 400);
    if (error instanceof ApnsPayloadTooLargeError) {
      return context.json({ error: error.code, maximumBytes: 4_096, actualBytes: error.size },400);
    }
    console.error("request failed", { message: error instanceof Error ? error.message : "unknown" });
    if (wantsHtmlPage(context.req.path, context.req.header("accept"))) {
      context.header("content-security-policy", publicErrorPageSecurityPolicy);
      context.header("cache-control", "no-store");
      return context.html(publicErrorPage(500), 500);
    }
    return context.json({ error: "internal_error" }, 500);
  });

  app.notFound((context) => {
    if (!wantsHtmlPage(context.req.path, context.req.header("accept"))) return context.text("404 Not Found", 404);
    context.header("content-security-policy", publicErrorPageSecurityPolicy);
    return context.html(publicErrorPage(404), 404);
  });

  app.post("/api/live-activity-responses/:interactionId", async (context) => {
    if (!integratedDependencies) return context.json({ error: "not_found" }, 404);
    const interactionId = internalId("int",context.req.param("interactionId") ?? "");
    const input = z.object({
      notificationId: z.string(), deviceId: z.string(),
      action: z.enum(["approve","deny","yes","no","choose"]),
      optionId: choiceOptionIdSchema.optional(),
      credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      idempotencyKey: z.string().trim().min(1).max(200),
      signature: answerSignatureSchema.optional(),
    }).strict().refine((value) => (value.action === "choose") === (value.optionId !== undefined),
      "A choice is answered with exactly one optionId").parse(await context.req.json());
    const notificationEventId = internalId("ntf",input.notificationId);
    const deviceId = internalId("dev",input.deviceId);
    if (!interactionId || !notificationEventId || !deviceId) return context.json({ error: "not_found" }, 404);
    const result = await respondToInteraction(db,{ kind: "live_activity",deviceId,credential: input.credential },{
      eventId: notificationEventId,interactionId,kind: input.action,
      value: { action: input.action,...(input.optionId ? { optionId: input.optionId } : {}),...input.signature },idempotencyKey: input.idempotencyKey,
    },{ apnsMode,credentialDerivationSecret: integratedDependencies.credentialDerivationSecret });
    if (result.kind === "rejected") return context.json({ error: result.error,...(result.state ? { state: result.state } : {}) },
      result.error === "invalid_credential" ? 401 : result.error === "invalid_action" ? 400
        : result.error === "not_found" || result.error === "interaction_not_found" ? 404 : result.error === "forbidden" ? 403 : 409);
    return context.json({ state: result.state,replayed: result.kind === "replayed",respondedAt: result.respondedAt });
  });

  // The newest CLI this server hands out rides on every API reply (x-relo-cli-latest), read per reply (the deploy can publish a
  // new CLI without a new image): a CLI behind it updates itself (or tells its agent how) without asking the server more.
  app.use("/api/*", async (context,next) => {
    await next();
    const latestCli = bundledCli()?.version;
    if (latestCli) context.header("x-relo-cli-latest",latestCli);
  });

  app.use("/api/*", authenticate(db));

  registerRequestPolicy(app,db,"/api/*");

  registerServiceApiRoutes(app,db,integratedDependencies?.appUrl);
  registerDeliveryObservabilityRoutes(app,db,apnsMode);
  registerContextResourceRoutes(app,db);
  registerDoctorRoutes(app,db,apnsMode,integratedDependencies?.appUrl);

  registerMachineAuthRoutes(app, db);

  const routeContext: ApiRouteContext = {
    db,apnsMode,dependencies,integratedDependencies,notificationContentCipher,encryptedTransportToken,callbackEncryption,
  };
  registerDeviceRoutes(app,routeContext);
  registerComputerInviteRoutes(app,routeContext);
  registerNotificationRoutes(app,routeContext);
  registerInboxRoutes(app,routeContext);
  registerNowRoutes(app,routeContext);
  registerAgentSessionRoutes(app,routeContext);
  registerCredentialRoutes(app,routeContext);
  registerComputerRoutes(app,routeContext);
  registerWorkRoutes(app,routeContext);
  registerScriptWorkRoutes(app,routeContext); registerServiceWorkRoutes(app,routeContext);

  registerActivityRoutes(app, db, dependencies?.apnsMode ?? "disabled", { contentCipher: notificationContentCipher,
    callbackEncryption });

  return app;
}
