import { z } from "zod";
import { OwnerClientError } from "./errors.js";
import { errorCode, readJson, type OwnerHttp } from "./http.js";
import type { OwnerCrypto } from "./types.js";

/** The prekey is replaced every 10 h (docs/ENCRYPTION-PROTOCOL.md, "Keys"). */
export const PREKEY_ROTATION_MS = 10 * 3600 * 1000;
/** A failed publish is tried again after this long. */
export const KEYS_RETRY_MS = 60_000;

const publishedSchema = z.object({ keyId: z.string(), identityChanged: z.boolean() });

/**
 * PUT /api/devices/self/keys with the device bearer (device-routes.ts:216; body = publishDeviceKeysSchema,
 * device-keys.ts:28: {identityKey, prekey:{prekeyId, publicKey, createdAt, signature}}, strict).
 */
export async function publishKeys(http: OwnerHttp, credential: { deviceId: string; accessToken: string }, crypto: OwnerCrypto, rotate: boolean) {
  await crypto.ensureKeys();
  const keys = await crypto.publishablePrekey(credential.deviceId, { rotate });
  const response = await http.request("/api/devices/self/keys", { method: "PUT", bearer: credential.accessToken, body: keys });
  if (response.status === 200) {
    const parsed = publishedSchema.safeParse(await readJson(response));
    if (!parsed.success) throw new OwnerClientError("invalid_response", 200);
    return parsed.data;
  }
  const code = await errorCode(response);
  if (response.status === 401 || response.status === 403) throw new OwnerClientError("unauthorized", response.status, code);
  if (response.status === 400) throw new OwnerClientError("invalid_request", 400, code);
  if (response.status === 409) throw new OwnerClientError("conflict", 409, code);
  throw new OwnerClientError("unavailable", response.status, code);
}

/** When to publish: never yet, or the rotation interval passed (rotating), or a failed attempt is due again. */
export class KeySchedule {
  private publishedAt: number | null = null;
  private attemptedAt: number | null = null;

  constructor(private readonly now: () => number) {}

  /** `rotate` when a published prekey exists and is old; otherwise the first publish keeps the current prekey. */
  due(): { due: false } | { due: true; rotate: boolean } {
    const now = this.now();
    if (this.publishedAt === null) {
      return this.attemptedAt === null || now - this.attemptedAt >= KEYS_RETRY_MS ? { due: true, rotate: false } : { due: false };
    }
    return now - this.publishedAt >= PREKEY_ROTATION_MS ? { due: true, rotate: true } : { due: false };
  }

  attempted(): void { this.attemptedAt = this.now(); }
  succeeded(): void { this.publishedAt = this.now(); }
  /** After a failed rotation the next try is a retry, not a new interval. */
  failedRotation(): void { this.publishedAt = this.publishedAt === null ? null : this.now() - PREKEY_ROTATION_MS + KEYS_RETRY_MS; }
  reset(): void { this.publishedAt = null; this.attemptedAt = null; }
  force(): void { this.publishedAt = null; this.attemptedAt = null; }
}
