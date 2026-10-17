import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { CurrentChangeHub } from "../current-change-hub.js";
import type { OwnerAccount } from "./owner-account.js";

export type DashboardEventsDependencies = {
  /** The signed-in owner for these request headers (better-auth cookie session), or null. */
  getAccount(headers: Headers): Promise<OwnerAccount | null>;
  hub: CurrentChangeHub | undefined;
  appOrigin: string;
};

export type DashboardEventsTiming = { keepaliveMs: number; writeTimeoutMs: number };

/** The only frame this stream ever carries besides keepalives: "something of yours changed, read again". */
export const DASHBOARD_CHANGED_FRAME = "event: changed\ndata: {}\n\n";

/**
 * GET /api/dashboard/events: the signed-in Dashboard's live update channel (ADR 0008: the server
 * delivers, clients display). It reuses the current-state change hub that feeds /api/inbox/events
 * and sends hints only: no ids, no state, no counts. The Dashboard answers a hint by reading
 * /dashboard?only=now again, so Now follows a write within about a second. Scoped to the
 * session's principal; the per-credential stream limit counts per browser session.
 */
export function registerDashboardEventRoutes(app: Hono, dependencies: DashboardEventsDependencies,
  timing: DashboardEventsTiming = { keepaliveMs: 15_000, writeTimeoutMs: 30_000 }): void {
  app.get("/api/dashboard/events", context => dashboardEventStream(context, dependencies, timing));
}

async function dashboardEventStream(context: Context, { getAccount, hub, appOrigin }: DashboardEventsDependencies,
  timing: DashboardEventsTiming): Promise<Response> {
  const headers = context.req.raw.headers;
  const noStore = (response: Response) => { response.headers.set("Cache-Control", "no-store"); return response; };
  const origin = context.req.header("origin");
  if (origin !== undefined && origin !== appOrigin) return noStore(context.json({ error: "forbidden" }, 403));
  const account = await getAccount(headers);
  if (!account) return noStore(context.json({ error: "unauthorized" }, 401));
  if (!hub) return noStore(context.json({ error: "current_stream_unavailable" }, 503));
  const subscription = hub.subscribe(account.principalId, `browser-session:${account.session.id}`);
  if (!subscription) return noStore(context.json({ error: "too_many_streams" }, 429));
  const sessionExpiry = new Date(account.session.expiresAt).getTime();
  context.header("X-Accel-Buffering", "no");
  const response = streamSSE(context, async stream => {
    const abort = new AbortController();
    const stop = () => { abort.abort(); subscription.close(); stream.abort(); };
    stream.onAbort(() => { abort.abort(); subscription.close(); });
    context.req.raw.signal.addEventListener("abort", stop, { once: true });
    if (context.req.raw.signal.aborted) stop();
    const write = async (value: string) => {
      const timer = setTimeout(stop, timing.writeTimeoutMs);
      try { await stream.write(value); } finally { clearTimeout(timer); }
    };
    try {
      while (!abort.signal.aborted) {
        const untilExpiry = Number.isFinite(sessionExpiry) ? Math.max(0, sessionExpiry - Date.now()) : timing.keepaliveMs;
        const wake = await subscription.wait(Math.min(timing.keepaliveMs, untilExpiry), abort.signal);
        if (wake === "aborted" || abort.signal.aborted) break;
        if (Number.isFinite(sessionExpiry) && sessionExpiry <= Date.now()) break;
        // A signed-out, revoked or disabled session closes here; the browser reconnects and gets a 401.
        const current = await getAccount(headers);
        if (!current || current.principalId !== account.principalId || current.session.id !== account.session.id) break;
        if (abort.signal.aborted) break;
        if (wake === "timeout") { await write(": keepalive\n\n"); continue; }
        subscription.take();
        await write(DASHBOARD_CHANGED_FRAME);
      }
    } catch {
      // Nothing about the failure goes on the wire; closing makes the client reconnect and read again.
      stream.abort();
    } finally {
      context.req.raw.signal.removeEventListener("abort", stop);
      subscription.close();
    }
  });
  return noStore(response);
}
