import { z } from "zod";

/**
 * Browser sign-in for the Relo apps, when the account still waits for the server admin's approval: the browser is sent
 * back to the app with a one-time pending ticket (`relo://auth/callback?pending=<ticket>&state=<state>`), and the app polls
 * POST /api/mobile/sign-in/pending with it and its PKCE verifier until the account is approved.
 */
export const mobileSignInPendingTicketSchema = z.string().regex(/^relo_pending_[A-Za-z0-9_-]{43}$/);
export const mobileSignInPendingRequestSchema = z.object({
  ticket: mobileSignInPendingTicketSchema,
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  installationId: z.string().trim().min(8).max(200),
}).strict();
export type MobileSignInPendingRequest = z.infer<typeof mobileSignInPendingRequestSchema>;

/** 202 while the account waits, 410 when the request was declined or the ticket expired. */
export const mobileSignInPendingStatusSchema = z.object({
  status: z.enum(["pending", "declined", "expired"]),
}).strict();
export type MobileSignInPendingStatus = z.infer<typeof mobileSignInPendingStatusSchema>;
