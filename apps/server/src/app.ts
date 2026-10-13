import { answerSignatureSchema } from "./sealed-content.js";
import { respondToInteraction } from "./interactions/commands.js";
import { type InteractionChangeHub } from "./interaction-change-hub.js";
import type { CurrentChangeHub } from "./current-change-hub.js";
import { SubjectAdmissionError } from "./relevance/commands.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  
  
  registerActivityRoutes,
  type ApnsMode } from "./activities.js";
import type { AccountAuth } from "./account-auth.js";
import { authenticate } from "./auth.js";
import { registerIdempotentMachineRevokeRoute, registerMachineAuthRoutes, registerPublicDeviceAuthorizationRoutes } from "./device-authorization.js";
import type { Database } from "./db.js";
import { internalId } from "./ids.js";
import { registerMobileAccountRoutes } from "./mobile-auth.js";
import { registerMobileSignInRoutes } from "./mobile-sign-in.js";
import { consumeRateLimit } from "./rate-limit.js";
import { registerServiceApiRoutes, registerWebhookRoutes } from "./services.js";
import { registerWebAuthRoutes } from "./web.js";

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
import { registerAgentSessionRoutes } from "./api/agent-session-routes.js";
import { registerInboxRoutes } from "./api/inbox-routes.js";
import { registerNotificationRoutes } from "./api/interaction-routes.js";
import type { ApiRouteContext } from "./api/route-context.js";
export { inboxItemResource } from "./api/resources.js";

export const MAX_REQUEST_BODY_BYTES = 1_048_576;

export type AppDependencies = {
  interactionChanges?: InteractionChangeHub;
  currentChanges?: CurrentChangeHub;
  accountAuth: AccountAuth;
  bootstrapOwnerHandle: string;
  credentialDerivationSecret: string;
  appUrl: string;
  apnsMode: ApnsMode;
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
    registerWebAuthRoutes(app, db, integratedDependencies);
    registerMobileAccountRoutes(app, db, integratedDependencies.accountAuth, integratedDependencies.credentialDerivationSecret);
    registerPublicDeviceAuthorizationRoutes(app, db, integratedDependencies.accountAuth, integratedDependencies.appUrl);
    registerMobileSignInRoutes(app, db, integratedDependencies.accountAuth, integratedDependencies.appUrl);
    registerIdempotentMachineRevokeRoute(app, db);
  }

  app.get("/health/live", (context) => context.json({ status: "ok" }));

  const ready = async (context: any) => {
    await db.query("SELECT 1");
    return context.json({ status: "ok" });
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
    return context.json({ error: "internal_error" }, 500);
  });

  app.post("/api/live-activity-responses/:interactionId", async (context) => {
    if (!integratedDependencies) return context.json({ error: "not_found" }, 404);
    const interactionId = internalId("int",context.req.param("interactionId") ?? "");
    const input = z.object({
      notificationId: z.string(), deviceId: z.string(),
      action: z.enum(["approve","deny","yes","no"]),
      credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      idempotencyKey: z.string().trim().min(1).max(200),
      signature: answerSignatureSchema.optional(),
    }).strict().parse(await context.req.json());
    const notificationEventId = internalId("ntf",input.notificationId);
    const deviceId = internalId("dev",input.deviceId);
    if (!interactionId || !notificationEventId || !deviceId) return context.json({ error: "not_found" }, 404);
    const result = await respondToInteraction(db,{ kind: "live_activity",deviceId,credential: input.credential },{
      eventId: notificationEventId,interactionId,kind: input.action,value: { action: input.action,...input.signature },idempotencyKey: input.idempotencyKey,
    },{ apnsMode,credentialDerivationSecret: integratedDependencies.credentialDerivationSecret });
    if (result.kind === "rejected") return context.json({ error: result.error,...(result.state ? { state: result.state } : {}) },
      result.error === "invalid_credential" ? 401 : result.error === "invalid_action" ? 400
        : result.error === "not_found" || result.error === "interaction_not_found" ? 404 : result.error === "forbidden" ? 403 : 409);
    return context.json({ state: result.state,replayed: result.kind === "replayed",respondedAt: result.respondedAt });
  });

  app.use("/api/*", authenticate(db));

  app.use("/api/*", async (context,next) => {
    if (!["POST","PUT","PATCH","DELETE"].includes(context.req.method)) return next();
    const path = new URL(context.req.url).pathname;
    if (!/^\/api\/(?:notifications|interactions|live-activities|services)(?:\/|$)/.test(path)) {
      return next();
    }
    const auth = context.get("auth");
    let family = "authenticated-mutations";
    if (/^\/api\/notifications\/[^/]+\/interactions$/.test(path)) {
      const body = await context.req.json().catch(() => null);
      if (["approve","deny","yes","no","answer"].includes(body?.kind)) family = "decision-responses";
    }
    const account = await consumeRateLimit(db,{
      scope: "account", id: auth.principalId, family, limit: 300,
    });
    if (!account.allowed) {
      context.header("retry-after",String(account.retryAfterSeconds));
      return context.json({ error: "rate_limited", scope: "account", retryAfterSeconds: account.retryAfterSeconds },429);
    }
    const scopedId = auth.credentialId ?? auth.deviceId;
    if (scopedId) {
      const scope = auth.credentialId ? "client" as const : "device" as const;
      const credential = await consumeRateLimit(db,{
        scope, id: scopedId, family, limit: scope === "client" ? 60 : 120,
      });
      if (!credential.allowed) {
        context.header("retry-after",String(credential.retryAfterSeconds));
        return context.json({ error: "rate_limited", scope, retryAfterSeconds: credential.retryAfterSeconds },429);
      }
    }
    return next();
  });

  registerServiceApiRoutes(app,db,integratedDependencies?.appUrl);
  registerDeliveryObservabilityRoutes(app,db,apnsMode);
  registerContextResourceRoutes(app,db);
  registerDoctorRoutes(app,db,apnsMode);

  registerMachineAuthRoutes(app, db);

  const routeContext: ApiRouteContext = {
    db,apnsMode,dependencies,integratedDependencies,notificationContentCipher,encryptedTransportToken,callbackEncryption,
  };
  registerDeviceRoutes(app,routeContext);
  registerNotificationRoutes(app,routeContext);
  registerInboxRoutes(app,routeContext);
  registerAgentSessionRoutes(app,routeContext);

  registerActivityRoutes(app, db, dependencies?.apnsMode ?? "disabled", { contentCipher: notificationContentCipher,
    callbackEncryption });

  return app;
}
