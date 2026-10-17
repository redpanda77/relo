import type { Context,Hono,Next } from "hono";
import { matchedRoutes } from "hono/route";
import { FACTS } from "@relo/notification-contracts";
import type { Database } from "./db.js";
import { consumeRateLimit,type RateLimitScope } from "./rate-limit.js";

/**
 * The request policy (plan 10 M4): which writes count, in which family, against which limits. One table keyed
 * by the route as Hono registered it (`METHOD /pattern`), applied by one middleware on `/api/*` (after bearer
 * sign-in) and `/hooks/*` (after the webhook sign-in). A family is a bucket of its own, so a burst of card
 * updates cannot use up the writes `relo ask` needs. The numbers are facts (packages/contracts/src/facts.ts).
 * request-policy.test.ts fails on a write route that is neither in the table nor in OUTSIDE_POLICY.
 */
type Limits = { account: number; login?: number; device?: number; service?: number; harness?: number };

const R = FACTS.requests;
export const FAMILIES = {
  "authenticated-mutations": { account: R.accountPerMinute,login: R.loginPerMinute,device: R.devicePerMinute,service: R.servicePerMinute },
  "decision-responses": { account: R.accountPerMinute,login: R.loginPerMinute,device: R.devicePerMinute,service: R.servicePerMinute },
  "work-writes": { account: R.accountWorkPerMinute,login: R.workPerMinute,service: R.servicePerMinute },
  "upkeep": { account: R.accountUpkeepPerMinute,login: R.upkeepPerMinute,device: R.upkeepPerMinute },
  "agent-session-observed": { account: R.accountSnapshotsPerMinute,harness: R.snapshotsPerMinute },
} as const satisfies Record<string,Limits>;
export type Family = keyof typeof FAMILIES;

/** An answer on a notification counts as a decision response: its own bucket, so answering never waits on sends. */
const DECIDING = new Set(["approve","deny","yes","no","answer","choose"]);
const answerFamily = async (context: Context): Promise<Family> => {
  const body = await context.req.json().catch(() => null) as { kind?: unknown } | null;
  return typeof body?.kind === "string" && DECIDING.has(body.kind) ? "decision-responses" : "authenticated-mutations";
};

type Entry = Family | ((context: Context) => Promise<Family>);
const each = (family: Family, routes: string[]) => Object.fromEntries(routes.map((route) => [route,family]));

export const REQUEST_POLICY: Record<string,Entry> = {
  ...each("authenticated-mutations",[
    "POST /api/notifications","POST /api/notifications/:notificationId/withdraw",
    "POST /api/interactions","POST /api/interactions/:interactionId/cancel",
    "POST /api/live-activities","POST /api/live-activities/resolve","PATCH /api/live-activities/:activityId",
    "POST /api/live-activities/:activityId/heartbeat","POST /api/live-activities/:activityId/wait","POST /api/live-activities/:activityId/end",
    "POST /api/services","PATCH /api/services/:serviceId","POST /api/services/:serviceId/rotate","DELETE /api/services/:serviceId",
    "POST /hooks","POST /hooks/events/:eventId/withdraw","POST /hooks/events/:eventId/cancel",
    "POST /hooks/live-activities","POST /hooks/live-activities/resolve","PATCH /hooks/live-activities/:identifier",
    "POST /hooks/live-activities/:identifier/end",
  ]),
  "POST /api/notifications/:notificationId/interactions": answerFamily,
  ...each("work-writes",[
    "POST /api/session/works","PATCH /api/session/works/:workId","POST /api/session/works/:workId/pause",
    "POST /api/session/works/:workId/resume","POST /api/session/works/:workId/finish","POST /api/session/works/:workId/deliver","POST /api/session/works/:workId/handoff","POST /api/works/:workId/finish","POST /api/works/:workId/end",
    "POST /api/producers/:producerKey/works","PATCH /api/producers/:producerKey/works/:workId",
    "POST /api/producers/:producerKey/works/:workId/pause","POST /api/producers/:producerKey/works/:workId/resume",
    "POST /api/producers/:producerKey/works/:workId/finish","POST /api/producers/:producerKey/works/:workId/heartbeat",
    "POST /hooks/works","PATCH /hooks/works/:workId","POST /hooks/works/:workId/pause","POST /hooks/works/:workId/resume",
    "POST /hooks/works/:workId/finish","POST /hooks/works/:workId/heartbeat",
  ]),
  ...each("upkeep",[
    "POST /api/harness-credentials","DELETE /api/harness-credentials/:harnessCredentialId","POST /api/harness-credentials/:harnessCredentialId/rotate",
    "POST /api/credentials","DELETE /api/credentials/:credentialId","POST /api/credentials/:credentialId/rotate",
    "PUT /api/devices/:deviceId","DELETE /api/devices/:deviceId","PUT /api/devices/self/keys",
    "PUT /api/devices/self/live-activities/:activityId/token","POST /api/devices/self/live-activities/:activityId/dismissed",
    "POST /api/devices/self/approvals","POST /api/devices/self/approvals/:deviceId/decline",
    "POST /api/devices/self/links","POST /api/devices/self/link-requests/:browserId/decline","DELETE /api/devices/self/links/:browserId",
    "POST /api/devices/self/sign-ins/:userCode/approve","POST /api/devices/self/sign-ins/:userCode/deny",
    "POST /api/devices/self/computer-approvals","POST /api/devices/self/computers/:clientId/revoke","POST /api/devices/self/computer-invites","PUT /api/devices/self/computer-invites/:inviteId/activity","POST /api/clients/computer-invites",
    "POST /api/devices/self/questions/:interactionId/dismiss",
    "PUT /api/clients/self/keys","PUT /api/computers/self","PUT /api/computers/self/report","PUT /api/end-to-end/policy","POST /api/deliveries/:deliveryId/reconcile",
    "POST /api/inbox/read-items","POST /api/presentation-assets","DELETE /api/presentation-assets/:assetId",
  ]),
  "POST /api/agent-sessions/observed": "agent-session-observed",
};

/**
 * Write routes the table does not count, each with why: they run before bearer sign-in, so they have their own
 * throttle or no caller identity to count against.
 */
export const OUTSIDE_POLICY: Array<{ match: string; reason: string }> = [
  { match: "/api/dashboard/",reason: "Dashboard routes run on the owner's browser session; the answer route counts decision responses itself" },
  { match: "/api/auth/",reason: "sign-in and sign-up are throttled per client and per account (auth-throttle.ts)" },
  { match: "/api/account/",reason: "browser-session account actions, owner only" },
  { match: "/api/device-authorizations/",reason: "CLI sign-in is throttled per client address (device-authorization.ts)" },
  { match: "/api/computer-invites/",reason: "a one-time code's redemption, throttled per client address (computer-invite-routes.ts)" },
  { match: "/api/mobile/",reason: "phone sign-in, throttled with the account sign-in" },
  { match: "POST /api/devices/register",reason: "phone registration runs on the phone's account session, idempotent per key" },
  { match: "DELETE /api/clients/self",reason: "signing out (DELETE) revokes the caller's own login; nothing to protect by counting" },
  { match: "/api/live-activity-responses/",reason: "Lock Screen answers carry a one-time device-bound credential, checked before any write" },
];

/** Whether a route is outside the policy: `match` is a whole route (`METHOD /path`) or a path prefix ending in /. */
export function outsidePolicy(route: string): boolean {
  return OUTSIDE_POLICY.some(({ match }) => match.includes(" ") ? match === route : route.split(" ")[1]!.startsWith(match));
}

/** The policy entry for a registered route, if any. */
export function policyFor(route: string): Entry | undefined {
  return REQUEST_POLICY[route];
}

const scopeOf = (context: Context): Array<{ scope: RateLimitScope; id: string; limit: (limits: Limits) => number | undefined }> => {
  const service = context.get("webhookService");
  if (service) return [
    { scope: "account",id: service.principal_id,limit: (limits) => limits.account },
    { scope: "service",id: service.id,limit: (limits) => limits.service },
  ];
  const auth = context.get("auth");
  if (!auth) return [];
  const credential = auth.credentialKind === "harness" && auth.harnessCredentialId
    ? { scope: "client" as const,id: auth.harnessCredentialId,limit: (limits: Limits) => limits.harness }
    : auth.credentialId ? { scope: "client" as const,id: auth.credentialId,limit: (limits: Limits) => limits.login }
      : auth.deviceId ? { scope: "device" as const,id: auth.deviceId,limit: (limits: Limits) => limits.device } : undefined;
  return [{ scope: "account",id: auth.principalId,limit: (limits) => limits.account },...(credential ? [credential] : [])];
};

/** The one rate-limit middleware: counts a write against its route's family, answering 429 with when to retry. */
export function requestPolicy(db: Database) {
  return async (context: Context,next: Next) => {
    if (!["POST","PUT","PATCH","DELETE"].includes(context.req.method)) return next();
    const handler = matchedRoutes(context).filter((route) => route.method !== "ALL").at(-1);
    const entry = handler ? policyFor(`${handler.method} ${handler.path}`) : undefined;
    if (!entry) return next();
    const family = typeof entry === "function" ? await entry(context) : entry;
    const limits: Limits = FAMILIES[family];
    for (const { scope,id,limit } of scopeOf(context)) {
      const allowed = limit(limits);
      if (allowed === undefined) continue;
      const consumed = await consumeRateLimit(db,{ scope,id,family,limit: allowed });
      if (!consumed.allowed) {
        context.header("retry-after",String(consumed.retryAfterSeconds));
        return context.json({ error: "rate_limited",scope,retryAfterSeconds: consumed.retryAfterSeconds },429);
      }
    }
    return next();
  };
}

export function registerRequestPolicy(app: Hono,db: Database,prefix: "/api/*" | "/hooks"): void {
  // Hono's "/hooks/*" also matches "/hooks" itself, so one registration covers the webhook API.
  app.use(prefix === "/hooks" ? "/hooks/*" : prefix,requestPolicy(db));
}
