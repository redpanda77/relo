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

/**
 * The HTTP API an integrating app calls with a CLI login's token, described as OpenAPI 3.1. Request
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
  errors?: string[];
};

const idParameter = (name: string,prefix: string) => ({
  name,in: "path",required: true,schema: { type: "string",pattern: `^${prefix}_` },
});
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
      for (const match of path.matchAll(/\{(\w+)\}/g)) {
        parameters.push(idParameter(match[1]!,match[1] === "interactionId" ? "int" : "act"));
      }
      for (const [name,query] of Object.entries(operation.query ?? {})) parameters.push({ name,in: "query",required: false,...query });
      if (method !== "get") parameters.push(idempotencyHeader);
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
      description: "Questions, cards and notifications for an app signed in with `relo auth login`. "
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
