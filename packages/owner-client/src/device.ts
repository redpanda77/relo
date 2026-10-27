import { z } from "zod";
import { OwnerClientError } from "./errors.js";
import { errorCode, readJson, type OwnerHttp } from "./http.js";
import { sha256Hex } from "./pkce.js";
import { OWNER_CAPABILITIES, type DeviceInfo } from "./types.js";

export interface RegistrationIds { stableDeviceId: string; installationId: string }

/**
 * The strict body of POST /api/devices/register (schemas.ts:63-79 registerDeviceSchema, narrowed by
 * mobile-auth.ts:17-24 which is .strict()). No apnsToken: an overview device is never a delivery target.
 */
export function registrationBody(ids: RegistrationIds, info: DeviceInfo) {
  return {
    stableDeviceId: ids.stableDeviceId,
    installationId: ids.installationId,
    name: info.name.trim().slice(0, 120) || "Windows PC",
    bundleIdentifier: info.bundleIdentifier,
    appVersion: info.appVersion,
    appBuild: info.appBuild,
    osVersion: info.osVersion,
    ...(info.model ? { model: info.model.slice(0, 120) } : {}),
    apnsEnvironment: "production" as const,
    notificationAuthorization: "denied" as const, // No push token: notices come over the events stream, as on the Mac.
    liveActivityAuthorization: "denied" as const,
    capabilities: [...OWNER_CAPABILITIES],
  };
}

const registrationResponseSchema = z.object({
  account: z.object({ accountId: z.string(), name: z.string(), email: z.string(), imageUrl: z.string().nullable() }),
  device: z.object({
    deviceId: z.string().regex(/^dev_/), installationId: z.string(),
    registrationState: z.string(), credentialVersion: z.number().int(),
  }),
  credential: z.object({ accessToken: z.string().min(1), issuedAt: z.string(), expiresAt: z.string().nullable() }),
});
export type Registration = z.infer<typeof registrationResponseSchema>;

/**
 * Same body + same session + same key replays to the same credential (mobile-auth.ts:115-128), so a retry after a
 * lost response is safe. The key carries a digest of the body: a changed body under an old key is a 409 (line 117).
 */
export async function registrationKey(ids: RegistrationIds, sessionId: string, body: unknown): Promise<string> {
  const digest = (await sha256Hex(JSON.stringify(body, Object.keys(body as object).sort()))).slice(0, 16);
  return `win-register:${ids.installationId}:${sessionId}:${digest}`;
}

/**
 * POST /api/devices/register, `Authorization: Bearer <account session token>` (better-auth bearer plugin,
 * account-auth.ts:65; read by getAccountSession in mobile-auth.ts:86), `Idempotency-Key` (mobile-auth.ts:101).
 * A 409 (replay of a revoked or re-issued credential, mobile-auth.ts:121) is retried once under a new key.
 */
export async function registerDevice(http: OwnerHttp, input: {
  sessionToken: string; sessionId: string; ids: RegistrationIds; info: DeviceInfo;
}): Promise<Registration> {
  const body = registrationBody(input.ids, input.info);
  const key = await registrationKey(input.ids, input.sessionId, body);
  for (const attempt of [key, `${key}:again`]) {
    const response = await http.request("/api/devices/register", {
      method: "POST", bearer: input.sessionToken, headers: { "Idempotency-Key": attempt }, body,
    });
    if (response.status === 200) {
      const parsed = registrationResponseSchema.safeParse(await readJson(response));
      if (!parsed.success) throw new OwnerClientError("invalid_response", 200);
      return parsed.data;
    }
    const code = await errorCode(response);
    if (response.status === 409 && attempt === key) continue;
    if (response.status === 401) throw new OwnerClientError("unauthorized", 401, code);
    if (response.status === 403) throw new OwnerClientError("account_disabled", 403, code);
    if (response.status === 400) throw new OwnerClientError("invalid_request", 400, code);
    if (response.status === 409) throw new OwnerClientError("conflict", 409, code);
    if (response.status === 429) throw new OwnerClientError("rate_limited", 429, code);
    throw new OwnerClientError("unavailable", response.status, code);
  }
  throw new OwnerClientError("conflict", 409);
}

/** PUT /api/devices/:deviceId (device-routes.ts, heartbeatSchema schemas.ts:81); the answer is {status:"ok"}. */
export async function heartbeat(http: OwnerHttp, credential: { deviceId: string; accessToken: string }, info: DeviceInfo): Promise<void> {
  const response = await http.request(`/api/devices/${credential.deviceId}`, {
    method: "PUT", bearer: credential.accessToken,
    body: { appVersion: info.appVersion, appBuild: info.appBuild, osVersion: info.osVersion, ...(info.model ? { model: info.model } : {}) },
  });
  if (response.status === 200) return;
  if (response.status === 401 || response.status === 403) throw new OwnerClientError("unauthorized", response.status);
  throw new OwnerClientError("unavailable", response.status);
}

/** DELETE /api/devices/:deviceId; 401/404 mean it is already gone, which is what revoking wants. */
export async function revokeDevice(http: OwnerHttp, credential: { deviceId: string; accessToken: string }): Promise<void> {
  const response = await http.request(`/api/devices/${credential.deviceId}`, { method: "DELETE", bearer: credential.accessToken });
  if ([200, 204, 401, 404].includes(response.status)) return;
  throw new OwnerClientError("unavailable", response.status);
}

/** POST /api/auth/sign-out with the account session (body `{}`: the auth endpoint rejects an empty one). */
export async function signOutAccount(http: OwnerHttp, sessionToken: string): Promise<void> {
  const response = await http.request("/api/auth/sign-out", { method: "POST", bearer: sessionToken, body: {} });
  if ([200, 204, 401, 404].includes(response.status)) return;
  throw new OwnerClientError("unavailable", response.status);
}

const devicesSchema = z.object({
  devices: z.array(z.object({
    trusted: z.boolean().optional(), isCurrent: z.boolean().optional(),
    ownerOverview: z.boolean().optional(), isSimulator: z.boolean().optional(),
  }).passthrough()),
});

/**
 * GET /api/devices/self/devices (device-routes.ts:98): whether another trusted, non-overview, non-simulator device
 * (an iPhone) exists. Then it gets the push and this device stays quiet about notices (MacNotices.shows).
 */
export async function phoneReceivesPushes(http: OwnerHttp, accessToken: string): Promise<boolean> {
  return (await deviceStanding(http, accessToken)).phone;
}

/** The same read, with whether a trusted device approved this device (`thisTrusted`; null when the server does not say). */
export async function deviceStanding(http: OwnerHttp, accessToken: string): Promise<{ phone: boolean; thisTrusted: boolean | null }> {
  const response = await http.request("/api/devices/self/devices", { bearer: accessToken });
  if (response.status === 401 || response.status === 403) throw new OwnerClientError("unauthorized", response.status);
  if (response.status !== 200) throw new OwnerClientError("unavailable", response.status);
  const parsed = devicesSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new OwnerClientError("invalid_response", 200);
  const devices = parsed.data.devices;
  const current = devices.find((d) => d.isCurrent === true);
  return {
    phone: devices.some((d) => d.trusted === true && d.isCurrent !== true && d.ownerOverview !== true && d.isSimulator !== true),
    thisTrusted: typeof current?.trusted === "boolean" ? current.trusted : null,
  };
}

const computerInviteSchema = z.object({ code: z.string().regex(/^rci_[A-Za-z0-9_-]{32}$/), expiresAt: z.string() }).passthrough();
export interface ComputerInvite { code: string; expiresAt: string }

/**
 * POST /api/devices/self/computer-invites (computer-invite-routes.ts): a one-time code for a computer to join this
 * account, made by this signed-in device. It works once, for 30 minutes; `relo auth join CODE` redeems it. The code is a
 * bearer secret: callers hand it straight to the join and never log it. Defaults only (no agents, no desktop app).
 */
export async function createComputerInvite(http: OwnerHttp, credential: { accessToken: string }): Promise<ComputerInvite> {
  const response = await http.request("/api/devices/self/computer-invites", { method: "POST", bearer: credential.accessToken, body: {} });
  if (response.status === 401 || response.status === 403) throw new OwnerClientError("unauthorized", response.status);
  if (response.status === 429) throw new OwnerClientError("rate_limited", response.status);
  if (response.status !== 201 && response.status !== 200) throw new OwnerClientError("unavailable", response.status);
  const parsed = computerInviteSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new OwnerClientError("invalid_response", response.status);
  return { code: parsed.data.code, expiresAt: parsed.data.expiresAt };
}
