import { z } from "zod";
import { OwnerClientError } from "./errors.js";
import { errorCode, readJson, type OwnerHttp } from "./http.js";
import type { Pkce } from "./pkce.js";

/** apps/server/src/mobile-sign-in.ts:19 (mobileSignInRedirectUri). */
export const REDIRECT_URI = "relo://auth/callback";

/** Which app asks (mobile-sign-in.ts `device`): the approval page names it. Omitted, the page says iPhone. */
export type SignInDevice = "windows";

/**
 * `<origin>/mobile/sign-in` with the S256 challenge, redirect and state (mobile-sign-in.ts request schema).
 * A server older than the one that knows `device=windows` answers 400 "invalid page": the host retries without it.
 */
export function buildAuthorizationUrl(origin: string, pkce: Pkce, options: { signUp?: boolean; device?: SignInDevice } = {}): string {
  const url = new URL("/mobile/sign-in", origin);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("state", pkce.state);
  if (options.device) url.searchParams.set("device", options.device);
  if (options.signUp) url.searchParams.set("mode", "sign-up");
  return url.toString();
}

export type CallbackOutcome = { type: "code"; code: string } | { type: "cancelled" };

/** Accepts only `relo://auth/callback` carrying the state this attempt sent (mobile-sign-in.ts:154-160 builds it). */
export function parseCallback(callbackUrl: string, expectedState: string): CallbackOutcome {
  let url: URL;
  try { url = new URL(callbackUrl); } catch { throw new OwnerClientError("callback_malformed"); }
  if (url.protocol !== "relo:" || url.hostname !== "auth" || url.pathname !== "/callback") {
    throw new OwnerClientError("callback_malformed");
  }
  if (url.searchParams.get("state") !== expectedState) throw new OwnerClientError("state_mismatch");
  const error = url.searchParams.get("error");
  if (error) {
    if (error === "access_denied") return { type: "cancelled" };
    throw new OwnerClientError("callback_malformed");
  }
  const code = url.searchParams.get("code");
  if (!code || !/^relo_signin_[A-Za-z0-9_-]{43}$/.test(code)) throw new OwnerClientError("callback_malformed");
  return { type: "code", code };
}

const tokenResponseSchema = z.object({
  sessionToken: z.string().min(1),
  session: z.object({ id: z.string(), expiresAt: z.string() }),
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
});
export type SignInSession = z.infer<typeof tokenResponseSchema>;

/** POST /api/mobile/sign-in/token (mobile-sign-in.ts:187-201); no auth header, the code and verifier are the proof. */
export async function exchangeCode(http: OwnerHttp, input: { code: string; verifier: string; installationId: string }): Promise<SignInSession> {
  const response = await http.request("/api/mobile/sign-in/token", {
    method: "POST",
    body: { code: input.code, codeVerifier: input.verifier, installationId: input.installationId },
  });
  if (response.status === 200) {
    const parsed = tokenResponseSchema.safeParse(await readJson(response));
    if (!parsed.success) throw new OwnerClientError("invalid_response", 200);
    return parsed.data;
  }
  const code = await errorCode(response);
  if (response.status === 400) throw new OwnerClientError(code === "invalid_grant" ? "invalid_grant" : "invalid_request", 400, code);
  if (response.status === 403) throw new OwnerClientError("account_disabled", 403, code);
  throw new OwnerClientError("unavailable", response.status, code);
}
