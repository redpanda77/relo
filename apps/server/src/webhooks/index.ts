import type { Hono } from "hono";
import type { ApnsMode } from "../activities.js";
import type { Database } from "../db.js";
import type { NotificationContentCipher } from "../notification-content.js";
import type { TransportTokenEncryption } from "../token-encryption.js";
import { registerRequestPolicy } from "../request-policy.js";
import { registerWebhookAuth } from "./auth.js";
import { registerServiceCardRoutes } from "./cards.js";
import { registerServiceNoticeRoutes } from "./notices.js";

/**
 * The webhook service producer module (plan 10 M3, ADR 0008: one module per producer type): sign-in
 * (`auth.ts`), notices and events (`notices.ts`), cards (`cards.ts`), works (`works.ts`, mounted with the other
 * producers' work routes) and service management (`admin.ts`). Registered before `/api` authentication.
 */
export function registerWebhookRoutes(
  app: Hono,
  db: Database,
  apnsMode: ApnsMode = "disabled",
  contentCipher?: NotificationContentCipher,
  callbackEncryption?: () => Pick<TransportTokenEncryption,"encrypt">,
): void {
  registerWebhookAuth(app,db);
  registerRequestPolicy(app,db,"/hooks");
  registerServiceCardRoutes(app,db,apnsMode);
  registerServiceNoticeRoutes(app,db,apnsMode,contentCipher,callbackEncryption);
}
