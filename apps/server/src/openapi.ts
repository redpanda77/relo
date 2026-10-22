import {
  agentSessionObservedRequestSchema,harnessCredentialCreateRequestSchema,
  workDeliverRequestSchema,workHandoffRequestSchema,workFinishRequestSchema,workEndRequestSchema,workPauseRequestSchema,workResumeRequestSchema,workStartRequestSchema,workUpdateRequestSchema,
} from "@relo/notification-contracts";
import { z } from "zod";
import {
  activityEndSchema,
  activityHeartbeatSchema,
  activityResolveSchema,
  activityStartSchema,
  activityUpdateSchema,
  activityWaitSchema,
} from "./activity-commands/schemas.js";
import { deviceAuthorizationStartSchema,deviceAuthorizationTokenSchema } from "./device-authorization.js";
import { createInviteSchema,redeemInviteSchema } from "./computer-invites.js";
import { createInteractionSchema,notificationRequestSchema } from "./schemas.js";
import { serviceCreateSchema,serviceUpdateSchema,webhookSchema } from "./webhooks/schemas.js";
import { ciTokenCreateSchema } from "./api/credential-routes.js";
import { producerFinishSchema,producerPauseSchema,producerStartSchema,producerUpdateSchema } from "./works/script-routes.js";

/**
 * The HTTP API an integrating app calls with a CLI login's token (plus the session, harness and owner
 * routes the CLI itself uses), described as OpenAPI 3.1. Request
 * bodies come from the same zod schemas the routes parse, so the description cannot drift from what
 * the server accepts; `openapi.test.ts` fails when docs/api/openapi.json is out of date.
 * Refinements that JSON Schema cannot express (a question is one line of at most 120 characters on a
 * card, labels unique, and similar) are enforced by the server and named in each description.
 */
type Operation = {
  summary: string;
  /** Who calls it: a login token (the default), a service's secret in a header, or nobody yet (signing in). */
  auth?: "webhook" | "none";
  description?: string;
  body?: z.ZodType;
  query?: Record<string,{ description: string; schema: object }>;
  headers?: Record<string,{ description: string; required?: boolean }>;
  errors?: string[];
};

const PATH_PARAMETERS: Record<string,{ description?: string; pattern?: string }> = {
  interactionId: { pattern: "^int_" },
  activityId: { pattern: "^act_" },
  workId: { pattern: "^wrk_",description: "A work id; `current` names the session's open work and `newest` its newest paused work where a route says so." },
  producerKey: { description: "Base64url SHA-256 of `producer:` plus the producer key (43 characters); the CLI computes it.",pattern: "^[A-Za-z0-9_-]{43}$" },
  harnessCredentialId: { pattern: "^hck_" },
  serviceId: { pattern: "^svc_" },
  notificationId: { pattern: "^ntf_" },
  eventId: { pattern: "^ntf_",description: "The `eventId` the webhook post returned." },
  identifier: { description: "A card id (act_…) or the card's name." },
};
const pathParameter = (name: string) => {
  const { pattern,description } = PATH_PARAMETERS[name] ?? {};
  return { name,in: "path",required: true,...(description ? { description } : {}),schema: { type: "string",...(pattern ? { pattern } : {}) } };
};
const sessionHeaders = {
  "Relo-Session-Key": { description: "The agent session's key, set by the CLI from the harness (16-128 of A-Z a-z 0-9 _ -).",required: true },
  "Relo-Harness": { description: "The harness id, for example claude-code." },
};
const harnessNote = "Accepts only a harness credential (scope presence:write); every other route refuses it and this route refuses any other credential.";
const idempotencyHeader = {
  name: "Idempotency-Key",in: "header",required: false,schema: { type: "string",maxLength: 200 },
  description: "Repeat a request with the same key to get the first result instead of a second effect.",
};
const timeoutQuery = {
  timeoutSeconds: { description: "How long to hold the request open waiting (0-300, default 60).",
    schema: { type: "integer",minimum: 0,maximum: 300,default: 60 } },
};

const operations: Record<string,Record<string,Operation>> = {
  "/api/notifications": {
    post: { summary: "Send a notification",body: notificationRequestSchema,
      description: "A one-off alert. Never a question and never progress: use a Live Activity for those." },
  },
  "/api/interactions": {
    post: { summary: "Ask a question",body: createInteractionSchema,
      description: "Approval, yes/no or a choice of 2-4 options; no typed answers. On a card (presentation=live_activity) "
        + "the prompt is one line of at most 120 characters and the explanation goes in `detail` (markdown, up to 4,000). "
        + "expiresInSeconds is capped by the server admin (7 days by default). With `callback`, Relo POSTs the answer "
        + "signed with Relo-Signature: t=UNIX,v1=HMAC-SHA256(token, \"UNIX.BODY\") and a stable Relo-Delivery-Id.",
      errors: ["question_wait_too_long","choice_unsupported","card_limit_reached"] },
  },
  "/api/interactions/answers": {
    get: { summary: "Stream answers",
      description: "Every settled question this credential asked, oldest first. Each answer carries a cursor; pass the last "
        + "one as `after` to resume without gaps or repeats. Without `after` or `since` the stream starts now.",
      query: {
        after: { description: "A cursor from an earlier answer.",schema: { type: "string" } },
        since: { description: "An ISO time to start from instead of a cursor.",schema: { type: "string",format: "date-time" } },
        ...timeoutQuery,
      } },
  },
  "/api/interactions/{interactionId}": {
    get: { summary: "Read a question" },
  },
  "/api/interactions/{interactionId}/wait": {
    get: { summary: "Wait for an answer",query: timeoutQuery,
      description: "Returns when the question settles or the timeout passes (state still pending)." },
  },
  "/api/interactions/{interactionId}/cancel": {
    post: { summary: "Withdraw a question" },
  },
  "/api/live-activities": {
    post: { summary: "Start (or join) a card",body: activityStartSchema,
      description: "The same idempotency key and name join the card already running instead of starting another.",
      errors: ["card_limit_reached"] },
  },
  "/api/live-activities/resolve": {
    post: { summary: "Find the running card for a key",body: activityResolveSchema },
  },
  "/api/live-activities/{activityId}": {
    get: { summary: "Read a card" },
    patch: { summary: "Update a card",body: activityUpdateSchema },
  },
  "/api/live-activities/{activityId}/heartbeat": {
    post: { summary: "Keep a quiet card from going stale",body: activityHeartbeatSchema },
  },
  "/api/live-activities/{activityId}/wait": {
    post: { summary: "Ask a question on a card",body: activityWaitSchema,
      description: "The question is one line of at most 120 characters; the explanation goes in `detail`. A wait longer "
        + "than the card can live continues as a question in Relo after the card ends.",
      errors: ["question_wait_too_long","choice_unsupported"] },
  },
  "/api/live-activities/{activityId}/end": {
    post: { summary: "End a card",body: activityEndSchema },
  },
  "/api/devices": {
    get: { summary: "List the account's phones" },
  },
  "/api/session/works": {
    post: { summary: "Start (or continue) the session's work",body: workStartRequestSchema,headers: sessionHeaders,
      description: "An agent session's own surface: one open work per session. Starting again continues the open work; `new` parks it; `from` (a handoff handle) takes over the work another session of this computer handed off "
        + "(`handoff_invalid`, `handoff_finished`). Text is `{ readable }` or `{ sealed: true }` with the sealed envelope. Scopes: activities:write." },
    get: { summary: "Read the session's open and parked work",headers: sessionHeaders },
  },
  "/api/session/works/{workId}": {
    get: { summary: "Read one of the session's works",headers: sessionHeaders },
    patch: { summary: "Update the work",body: workUpdateRequestSchema,headers: sessionHeaders,
      description: "Plan changes keep stable step ids; a stale `baseVersion` is refused." },
  },
  "/api/session/works/{workId}/pause": {
    post: { summary: "Pause the work",body: workPauseRequestSchema,headers: sessionHeaders },
  },
  "/api/session/works/{workId}/resume": {
    post: { summary: "Resume a paused or parked work",body: workResumeRequestSchema,headers: sessionHeaders },
  },
  "/api/session/works/{workId}/finish": {
    post: { summary: "Finish the work with an outcome",body: workFinishRequestSchema,headers: sessionHeaders,
      description: "Every finish declares an outcome; open steps become skipped." },
  },
  "/api/session/works/{workId}/deliver": {
    post: { summary: "Deliver the open round with an outcome",body: workDeliverRequestSchema,headers: sessionHeaders,
      description: "Closes the open round and ends its card as a final card; the work stays open and waits for the owner. "
        + "`start --round` opens the next round. Refused when no round is open (`no_open_round`).",
      errors: ["not_open","no_open_round","work_finished"] },
  },
  "/api/session/works/{workId}/handoff": {
    post: { summary: "Hand the open work to a fresh session of this computer",body: workHandoffRequestSchema,headers: sessionHeaders,
      description: "Keeps the work, its round and its card open; the status becomes the note. Returns a single-use handle once (24 hours; "
        + "only its hash is stored). A fresh session on the same account and computer takes over with `start` and `from`. No notification.",
      errors: ["not_open","round_closed","work_finished"] },
  },
  "/api/producers/{producerKey}/works": {
    post: { summary: "Start (or continue) a script's work",body: producerStartSchema,
      description: "For scripts and apps with no agent harness. Requires Idempotency-Key. One open work per producer key; `new` parks it. "
        + "Scope: activities:write. A request that names a session is refused (`wrong_surface`).",
      errors: ["idempotency_key_required","idempotency_conflict","invalid_producer_key"] },
    get: { summary: "List the producer's works",query: { state: { description: "open (default), paused or all.",schema: { type: "string",enum: ["open","paused","all"] } } } },
  },
  "/api/producers/{producerKey}/works/{workId}": {
    get: { summary: "Read a work" },
    patch: { summary: "Update a work",body: producerUpdateSchema },
  },
  "/api/producers/{producerKey}/works/{workId}/pause": { post: { summary: "Pause a work, with an optional declared reason",body: producerPauseSchema } },
  "/api/producers/{producerKey}/works/{workId}/resume": { post: { summary: "Resume a work" } },
  "/api/producers/{producerKey}/works/{workId}/finish": {
    post: { summary: "Finish a work with an outcome",body: producerFinishSchema },
  },
  "/api/producers/{producerKey}/works/{workId}/heartbeat": {
    post: { summary: "Renew the work's lease",
      description: "Body `{ \"leaseSeconds\": 60..3600 }`. Declares nothing else; after the lease lapses the normal freshness rules apply." },
  },
  "/api/works": {
    get: { summary: "List works (owner)",query: {
      state: { description: "`live` lists only works that are open now.",schema: { type: "string",enum: ["live"] } },
      limit: { description: "1-200, default 50.",schema: { type: "integer",minimum: 1,maximum: 200,default: 50 } },
    },description: "The owner's cross-session read; a caller that names a session is refused (`owner_only`). Scope: activities:read." },
  },
  "/api/works/{workId}": {
    get: { summary: "Read a work (owner)" },
  },
  "/api/now": {
    get: { summary: "The owner's derived state",query: {
      since: { description: "The owner's last look, clamped to the last 8 hours.",schema: { type: "string",format: "date-time" } },
    },description: "Every item carries its derived owner state, visibility and urgency, and `refreshAt`. Clients display it and keep no policy of their own. Scope: inbox:read." },
  },
  "/api/agent-sessions": {
    get: { summary: "List sessions (owner)",query: {
      phase: { description: "Comma-separated: working, waiting, idle, ended. Counts cover every phase.",schema: { type: "string" } },
    },description: "Scope: activities:read." },
  },
  "/api/agent-sessions/observed": {
    post: { summary: "Report a session's phase",body: agentSessionObservedRequestSchema,
      description: `One snapshot of the CLI's local session state machine, sent on a phase change and as a heartbeat (at most every 5 minutes) while working. A snapshot applies only when its \`seq\` is higher than the stored one. No prompt, tool name or transcript ever travels. ${harnessNote}`,
      errors: ["harness_credential_required"] },
  },
  "/api/harness-credentials": {
    post: { summary: "Mint a harness credential",body: harnessCredentialCreateRequestSchema,
      description: "The token is shown once. Scope: services:write.",errors: ["credential_limit_reached"] },
    get: { summary: "List harness credentials",description: "Scope: services:read." },
  },
  "/api/harness-credentials/{harnessCredentialId}": {
    delete: { summary: "Revoke a harness credential",description: "Scope: services:write." },
  },
  "/api/harness-credentials/{harnessCredentialId}/rotate": {
    post: { summary: "Rotate a harness credential",description: "A new token for the same credential, shown once; the old token stops working at once. A revoked credential cannot be rotated. Scope: services:write." },
  },
  "/api/notifications/{notificationId}/withdraw": {
    post: { summary: "Withdraw a notification",description: "Removes a delivered notification from the phones. Scope: notifications:send." },
  },
  "/api/live-activities/{activityId}/diagnosis": {
    get: { summary: "Explain why a card is or is not on the phone",description: "The delivery boundary a card stopped at. Scope: devices:read." },
  },
  "/api/doctor": {
    get: { summary: "Readiness of this login",description: "What `relo doctor` reads: the server, the login, the phones and the end-to-end state." },
  },
  "/api/clients/self": {
    get: { summary: "This login",description: "The credential's client name, scopes and expiry." },
    delete: { summary: "Sign this login out",description: "Revokes the credential the request carries." },
  },
  "/api/works/{workId}/finish": {
    post: { summary: "End a hanging work (owner)",body: workFinishRequestSchema,
      description: "The owner's administration: ends a paused work, or an open one quiet for 20 minutes, of any session or script. "
        + "A moving work answers `work_running`; a caller that names a session is refused (`owner_only`). Scope: activities:write.",
      errors: ["work_running","owner_only","work_finished"] },
  },
  "/api/works/{workId}/end": {
    post: { summary: "End a work (owner, phone)",body: workEndRequestSchema,
      description: "The owner ends a work that is quiet, left open, delivered or paused; it moves to History. The body is `{}`: a delivered "
        + "work finishes with its last round's outcome, anything else is dropped as \"Ended by you\" (a sealed work's outcome stays "
        + "sealed). No notification: the owner did it. A moving work answers `work_running`; an unknown or foreign id answers "
        + "`not_found`. The phone credential only (scope interactions:respond); the Dashboard has its own session route.",
      errors: ["work_running","work_finished","not_found","owner_only"] },
  },
  "/api/services": {
    get: { summary: "List webhook services",description: "Without their secrets. Scope: services:read." },
    post: { summary: "Create a webhook service",body: serviceCreateSchema,
      description: "Returns the `endpoint` (`<origin>/hooks`) and the `secret` (`hook_…`), shown once. The service sends with the "
        + "secret in `Authorization: Bearer hook_…`, never in the URL. Scope: services:write." },
  },
  "/api/services/{serviceId}": {
    patch: { summary: "Edit a webhook service",body: serviceUpdateSchema,description: "Scope: services:write." },
    delete: { summary: "Delete a webhook service",description: "Its secret stops working at once. Scope: services:write." },
  },
  "/api/services/{serviceId}/rotate": {
    post: { summary: "Rotate a service's secret",description: "Returns the new `endpoint` and `secret`; the old secret stops working at once. Scope: services:write." },
  },
  "/api/credentials": {
    get: { summary: "List CI tokens",description: "The account's CI tokens that still work, without their secrets. Scope: services:read." },
    post: { summary: "Create a CI token",body: ciTokenCreateSchema,
      description: "A login for a pipeline or container, made without a browser sign-in: it holds at most its maker's scopes, "
        + "always expires, and is returned once as `token`. A CI token cannot make another. Scope: services:write.",
      errors: ["name_taken","limit_reached","scope_not_held","expiry_too_long","ci_token_cannot_mint"] },
  },
  "/api/credentials/{credentialId}": {
    delete: { summary: "Revoke a CI token",description: "It stops working at once. Scope: services:write." },
  },
  "/api/credentials/{credentialId}/rotate": {
    post: { summary: "Rotate a CI token",description: "A new token for the same CI token (same id, name, scopes and expiry), returned once as `token`; the old token stops working at once. "
      + "A revoked or expired token cannot be rotated. A CI token may rotate only itself. Sign-in logins and phones are not rotated: sign in or register again. Scope: services:write.",
      errors: ["ci_token_cannot_rotate_another"] },
  },
  "/api/device-authorizations/start": {
    post: { summary: "Start signing in a client",auth: "none",body: deviceAuthorizationStartSchema,
      description: "The device authorization flow any client uses (relo auth login does): returns a `deviceCode` to poll with, "
        + "a `userCode` and the URL where the owner approves it in the signed-in Dashboard.",errors: ["rate_limited"] },
  },
  "/api/computer-invites/redeem": {
    post: { summary: "Join with a one-time code",auth: "none",body: redeemInviteSchema,
      description: "Add a computer: redeems a code a trusted device made (it works once, for 30 minutes) for the computer's own "
        + "login, with no browser; returns the access token, its credential and how the owner wants the computer set up "
        + "(`setup: { level, approvals, agents, macApp }`). A code made with `macApp`, redeemed with `macAppChallenge`, also returns "
        + "`macAppSignInCode`: the Mac app exchanges it at /api/mobile/sign-in/token with its verifier. `relo auth join` and the install script call it.",errors: ["invalid_code","rate_limited"] },
  },
  "/api/clients/computer-invites": {
    post: { summary: "Make a one-time code to add a computer",body: createInviteSchema,
      description: "A signed-in computer's own login (not a CI token) makes a code for another computer, and the command that "
        + "installs and signs it in. Returns `{ inviteId, code, command, expiresAt, level, approvals, agents, macApp }`; `inviteId` (cin_…) "
        + "names the code for the Connect a computer wizard. `relo auth invite`. Scope: services:write.",errors: ["principal_credential_required"] },
  },
  "/api/device-authorizations/token": {
    post: { summary: "Poll for the approved credential",auth: "none",body: deviceAuthorizationTokenSchema,
      description: "Answers `authorization_pending` (poll again after `intervalSeconds`), `slow_down`, `access_denied` or "
        + "`expired_token`, or once approved the access token and its credential (shown once).",
      errors: ["authorization_pending","slow_down","access_denied","expired_token"] },
  },
  "/hooks": {
    post: { summary: "Send a notification or a question as a service",auth: "webhook",body: webhookSchema,
      description: "A service's alert, or a question when `response` is set (approval, yes/no or a choice; with `callback`, "
        + "Relo POSTs the signed answer). Every post names `context.project` and `context.threadName`.",
      errors: ["unknown_webhook","secret_in_url","work_identity_required"] },
  },
  "/hooks/events/{eventId}": {
    get: { summary: "Read a posted event and its answer",auth: "webhook" },
  },
  "/hooks/events/{eventId}/withdraw": {
    post: { summary: "Withdraw a posted notification",auth: "webhook" },
  },
  "/hooks/events/{eventId}/cancel": {
    post: { summary: "Withdraw a posted question",auth: "webhook" },
  },
  "/hooks/live-activities": {
    post: { summary: "Start (or join) a card as a service",auth: "webhook",body: activityStartSchema,errors: ["card_limit_reached"] },
  },
  "/hooks/live-activities/resolve": {
    post: { summary: "Find the service's running card for a key",auth: "webhook",body: activityResolveSchema },
  },
  "/hooks/live-activities/{identifier}": {
    get: { summary: "Read a service's card",auth: "webhook" },
    patch: { summary: "Update a service's card",auth: "webhook",body: activityUpdateSchema },
  },
  "/hooks/live-activities/{identifier}/end": {
    post: { summary: "End a service's card",auth: "webhook",body: activityEndSchema },
  },
  "/hooks/works": {
    post: { summary: "Start (or continue) a service's work",auth: "webhook",body: producerStartSchema,
      description: "Like a script's work, keyed by the `producerKey` in the body; Idempotency-Key required. A service cannot seal, "
        + "so its text is readable by the server.",errors: ["idempotency_key_required","invalid_producer_key"] },
    get: { summary: "List the service's works",auth: "webhook",
      query: { state: { description: "open (default), paused or all.",schema: { type: "string",enum: ["open","paused","all"] } },
        producerKey: { description: "Only this producer's works.",schema: { type: "string" } } } },
  },
  "/hooks/works/{workId}": {
    get: { summary: "Read a service's work",auth: "webhook" },
    patch: { summary: "Update a service's work",auth: "webhook",body: producerUpdateSchema },
  },
  "/hooks/works/{workId}/pause": { post: { summary: "Pause a service's work",auth: "webhook",body: producerPauseSchema } },
  "/hooks/works/{workId}/resume": { post: { summary: "Resume a service's work",auth: "webhook" } },
  "/hooks/works/{workId}/finish": { post: { summary: "Finish a service's work",auth: "webhook",body: producerFinishSchema } },
  "/hooks/works/{workId}/heartbeat": { post: { summary: "Renew a service's work lease",auth: "webhook" } },
};

/**
 * Routes that are deliberately not part of the published API, by path prefix or exact route, with the reason.
 * openapi.test.ts fails when a registered /api or /hooks route is neither described nor listed here.
 */
export const INTERNAL_ROUTES: ReadonlyArray<{ match: string; why: string }> = [
  { match: "/api/dashboard/",why: "the Dashboard's own data and settings (a signed-in browser)" },
  { match: "/api/auth/",why: "sign-in for the Dashboard and the iPhone app (Better Auth)" },
  { match: "/api/mobile/",why: "the iPhone app's sign-in exchange" },
  { match: "/api/inbox/",why: "the iPhone app's inbox and sync" },
  { match: "/api/devices/",why: "a phone's own registration, keys and links (the iPhone app)" },
  { match: "/api/live-activity-responses/",why: "answers from a Live Activity's buttons (the iPhone app)" },
  { match: "/api/notifications/{notificationId}/interactions",why: "answers from the phone (the iPhone app)" },
  { match: "/api/account/",why: "the account's own settings (Dashboard and iPhone app)" },
  { match: "/api/resources/",why: "the Dashboard's project and conversation views" },
  { match: "/api/deliveries",why: "delivery evidence for the owner's debugging tools" },
  { match: "/api/evidence/",why: "delivery evidence for the owner's debugging tools" },
  { match: "/api/presentation-assets",why: "card artwork managed from the Dashboard" },
  { match: "/api/end-to-end/policy",why: "the encryption policy, changed from the Dashboard (the CLI only tightens it)" },
  { match: "/api/clients/keys",why: "end-to-end key publishing between the CLI and the phones" },
  { match: "/api/clients/self/keys",why: "end-to-end key publishing between the CLI and the phones" },
  { match: "/api/computers/self",why: "the CLI's own computer: its name and icon from relo setup, and its setup report for the Dashboard" },
  { match: "/api/device-authorizations/requests/",why: "the Dashboard's page where the owner approves a sign-in code" },
  { match: "/api/live-activities (GET)",why: "the owner's card list for the CLI's relo activity list" },
];

const refusals = ["unauthorized","account_disabled","credential_revoked","login_expired"];

function bodySchema(schema: z.ZodType): object {
  const { $schema: _,...json } = z.toJSONSchema(schema,{ io: "input",unrepresentable: "any" }) as Record<string,unknown>;
  return json;
}

export function buildOpenApi(version: string): object {
  const paths: Record<string,Record<string,object>> = {};
  for (const [path,methods] of Object.entries(operations)) {
    paths[path] = {};
    for (const [method,operation] of Object.entries(methods)) {
      const parameters: object[] = [];
      for (const match of path.matchAll(/\{(\w+)\}/g)) parameters.push(pathParameter(match[1]!));
      for (const [name,header] of Object.entries(operation.headers ?? {})) {
        parameters.push({ name,in: "header",required: header.required ?? false,description: header.description,schema: { type: "string" } });
      }
      for (const [name,query] of Object.entries(operation.query ?? {})) parameters.push({ name,in: "query",required: false,...query });
      if (method !== "get" && method !== "delete") parameters.push(idempotencyHeader);
      paths[path][method] = {
        summary: operation.summary,
        ...(operation.auth === "webhook" ? { security: [{ webhookSecret: [] }] } : operation.auth === "none" ? { security: [] } : {}),
        ...(operation.description ? { description: operation.description } : {}),
        ...(parameters.length ? { parameters } : {}),
        ...(operation.body ? { requestBody: { required: true,content: { "application/json": { schema: bodySchema(operation.body) } } } } : {}),
        responses: {
          "200": { description: "Success (201 when something was created)." },
          "400": { description: "The request was refused",content: { "application/json": { schema: errorSchema(operation.errors ?? []) } } },
          "401": { description: "The credential was refused; `error` says why",content: { "application/json": { schema: errorSchema(refusals) } } },
        },
      };
    }
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Relo integration API",
      version,
      description: "Questions, work, cards and notifications for an app signed in with `relo auth login`; the session, "
        + "harness-credential and owner routes the CLI uses; webhook services (`/hooks…`, a service secret in a header); and "
        + "the device authorization flow any client signs in with. Every other route is private to the Dashboard and the "
        + "iPhone app (INTERNAL_ROUTES in apps/server/src/openapi.ts). See docs/INTEGRATING.md.",
    },
    security: [{ bearer: [] }],
    components: { securitySchemes: {
      bearer: { type: "http",scheme: "bearer",description: "A login token from `relo auth login` (or the device authorization routes)." },
      webhookSecret: { type: "http",scheme: "bearer",description: "A service's secret, `hook_…`, in `Authorization: Bearer`. "
        + "`X-Relo-Webhook-Secret: hook_…` also works. Never in the URL: a path with a secret is refused (`secret_in_url`)." },
    } },
    paths,
  };
}

function errorSchema(codes: string[]): object {
  return {
    type: "object",
    required: ["error"],
    properties: {
      error: codes.length ? { type: "string",description: `Including: ${codes.join(", ")}` } : { type: "string" },
      message: { type: "string" },
    },
  };
}
