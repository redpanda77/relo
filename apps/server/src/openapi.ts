import {
  agentSessionObservedRequestSchema,harnessCredentialCreateRequestSchema,
  workFinishRequestSchema,workPauseRequestSchema,workResumeRequestSchema,workStartRequestSchema,workUpdateRequestSchema,
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
import { createInteractionSchema,notificationRequestSchema } from "./schemas.js";
import { producerFinishSchema,producerStartSchema,producerUpdateSchema } from "./works/script-routes.js";

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
      description: "An agent session's own surface: one open work per session. Starting again continues the open work; `new` parks it. "
        + "Text is `{ readable }` or `{ sealed: true }` with the sealed envelope. Scopes: activities:write." },
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
  "/api/producers/{producerKey}/works/{workId}/pause": { post: { summary: "Pause a work" } },
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
};

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
      description: "Questions, work, cards and notifications for an app signed in with `relo auth login`, plus the session, "
        + "harness-credential and owner routes the CLI and apps use. "
        + "See docs/INTEGRATING.md.",
    },
    security: [{ bearer: [] }],
    components: { securitySchemes: { bearer: { type: "http",scheme: "bearer" } } },
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
