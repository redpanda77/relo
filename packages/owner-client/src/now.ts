import { currentInboxResponseSchema, nowSummarySchema, type CurrentInboxResponse, type NowSummary } from "@relo/notification-contracts";
import { OwnerClientError } from "./errors.js";
import { failFor, readText, type OwnerHttp } from "./http.js";
import type { OwnerCrypto } from "./types.js";

const NOW_MAX_CHARS = 2_097_152;

/** Raw JSON, strict-validated; a server that sends another shape is incompatible, not partly shown. */
async function parse<T>(response: Response, max: number, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, crypto: OwnerCrypto): Promise<T> {
  let raw: unknown;
  try { raw = JSON.parse(await readText(response, max)); } catch (error) {
    throw error instanceof OwnerClientError ? error : new OwnerClientError("invalid_response", response.status);
  }
  if (!schema.safeParse(raw).success) throw new OwnerClientError("invalid_response", response.status);
  // Sealed text is opened by the injected crypto; the opened tree must still be the same contract.
  const opened = schema.safeParse(await crypto.openTree(raw));
  if (!opened.success) throw new OwnerClientError("invalid_response", response.status);
  return opened.data;
}

export interface NowResult { summary: NowSummary; etag: string | null; unchanged: false }
export interface NowUnchanged { unchanged: true }

/**
 * GET /api/now?since=<ISO> with the device bearer (now-routes.ts:21; response nowSummarySchema, owner-state.ts:459).
 * The server sends `Cache-Control: no-store` and no ETag today (now-routes.ts:25); if it ever adds one, `etag` is sent
 * back as If-None-Match and a 304 reports `unchanged`.
 */
export async function fetchNow(http: OwnerHttp, accessToken: string, crypto: OwnerCrypto,
  options: { since?: string; etag?: string | null } = {}): Promise<NowResult | NowUnchanged> {
  const response = await http.request("/api/now", {
    bearer: accessToken,
    ...(options.since ? { query: { since: options.since } } : {}),
    ...(options.etag ? { headers: { "If-None-Match": options.etag } } : {}),
  });
  if (response.status === 304 && options.etag) return { unchanged: true };
  if (response.status !== 200) throw failFor(response);
  const summary = await parse(response, NOW_MAX_CHARS, nowSummarySchema, crypto);
  return { summary, etag: response.headers.get("etag"), unchanged: false };
}

/**
 * GET /api/inbox/current?limit=50 (inbox-routes.ts:22; response currentInboxResponseSchema, current-inbox.ts:37).
 * Where plain notices live when Now holds only cards and questions.
 */
export async function fetchCurrentPage(http: OwnerHttp, accessToken: string, crypto: OwnerCrypto): Promise<CurrentInboxResponse> {
  const response = await http.request("/api/inbox/current", { bearer: accessToken, query: { limit: "50" } });
  if (response.status !== 200) throw failFor(response);
  return parse(response, 1_048_576, currentInboxResponseSchema, crypto);
}

/** Seconds to wait before the next read: the server's `refreshAt` (on its own clock) when sooner than the 60 s safety tick. */
export function nextWaitSeconds(summary: Pick<NowSummary, "serverTime" | "refreshAt"> | null): number {
  if (!summary?.refreshAt) return 60;
  const wait = (Date.parse(summary.refreshAt) - Date.parse(summary.serverTime)) / 1000 + 1;
  return wait > 0 && wait < 60 ? wait : 60;
}
