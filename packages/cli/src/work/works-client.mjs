// Typed calls for /api/session/works (plan 04 §0.4). Identity travels as headers set from the typed caller,
// never from a flag. Uses the configured client's URL, token and fetch.
import { randomUUID } from "node:crypto";
import { ApiError, EXIT, NetworkError } from "../errors.mjs";
import { WorkRefusal } from "./refusal.mjs";

export function newIdempotencyKey() {
  return `relo-cli:${randomUUID()}`;
}

// Server refusal codes (contracts/works.ts WORK_REFUSAL_CODES) in the three-line shape. `status` stays on the
// error so callers can still branch on 404/409.
const NEXT = {
  not_found: "relo state --sync",
  not_open: 'relo work resume  |  relo work start --goal "…"',
  work_finished: 'relo work start --new --goal "…"',
  version_conflict: "relo state --sync",
  outcome_required: 'relo work finish --outcome "…"',
  text_refused: "the same command with plainer words",
  plan_too_long: 'relo work update --plan "<fewer, larger steps>"',
  plan_ids_invalid: "relo state --sync",
  step_not_found: "relo state --sync",
  labels_sealed: "relo work update --step s3",
  idempotency_key_required: "the same command again",
  idempotency_conflict: "the same command again",
  end_to_end_required: "relo keys status   (open Relo on the iPhone, then retry)",
  session_key_required: "relo doctor",
  owner_only: "relo state",
  plan_invalid: "relo state --sync",
  invalid_request: "relo help",
};

export function serverRefusal(payload, status, method, path) {
  const raw = typeof payload?.error === "string" ? payload.error : payload?.error?.code;
  const message = payload?.message ?? payload?.error?.message ?? `Relo API returned HTTP ${status}`;
  if (raw && Object.hasOwn(NEXT, raw)) {
    const refusal = new WorkRefusal(raw.toUpperCase(), {
      // Readable text reaches the server only when this computer has no phone to seal for.
      what: raw === "end_to_end_required" ? "this account requires end-to-end encryption and this computer has no trusted phone with a current key to seal for"
        : String(message).replace(/\.$/u, ""),
      state: raw === "not_found" ? "no such work in this session" : "nothing changed on the server",
      next: NEXT[raw],
      exitCode: status >= 500 ? EXIT.API : EXIT.USAGE,
      details: { status, view: payload?.work ?? payload?.state },
    });
    refusal.status = status;
    return refusal;
  }
  return new ApiError(message, { status, code: String(raw ?? "API_ERROR").toUpperCase(), details: { view: payload?.work, method, path } });
}

/** Where each declared write goes. `id` may be "current" (the session's open work) when it is not known yet. */
export const WORK_ROUTES = {
  start: () => ({ method: "POST", path: "/api/session/works" }),
  update: (id) => ({ method: "PATCH", path: `/api/session/works/${encodeURIComponent(id)}` }),
  pause: (id) => ({ method: "POST", path: `/api/session/works/${encodeURIComponent(id)}/pause` }),
  resume: (id) => ({ method: "POST", path: `/api/session/works/${encodeURIComponent(id)}/resume` }),
  finish: (id) => ({ method: "POST", path: `/api/session/works/${encodeURIComponent(id)}/finish` }),
};

export function worksClient(client, { sessionKey, harness }) {
  async function call(method, path, { body, idempotencyKey, timeoutMs = 30_000 } = {}) {
    if (typeof client?.request !== "function" || client.apiUrl === undefined) {
      // Dry runs and test stubs: a client without a URL refuses every call.
      if (typeof client?.sessionRequest === "function") return client.sessionRequest(method, path, { body, idempotencyKey, sessionKey, harness });
      throw new WorkRefusal("DRY_RUN", { what: "no request is made in a dry run", state: "nothing was sent", next: "the same command without --dry-run" });
    }
    const headers = { accept: "application/json", authorization: `Bearer ${client.token}`, "user-agent": `reloctl/${client.version}`, "relo-session-key": sessionKey, "relo-harness": harness };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let response;
    try {
      response = await client.fetchImpl(new URL(`${client.apiUrl}${path}`), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new NetworkError(error instanceof Error ? error.message : "Unable to reach Relo API");
    }
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      if (response.status === 404 && path === "/api/session/works" && method === "POST" && !payload?.error) {
        throw new WorkRefusal("SERVER_TOO_OLD", { what: "this Relo server is older than relo work (server 0.18.0 or newer is needed)", state: "nothing was sent", next: "relo doctor", exitCode: 1 });
      }
      throw serverRefusal(payload, response.status, method, path);
    }
    return payload;
  }
  return {
    list: () => call("GET", "/api/session/works"),
    get: (id) => call("GET", `/api/session/works/${encodeURIComponent(id)}`),
    current: () => call("GET", "/api/session/works/current"),
    /** One declared write; the caller keeps the key so a retry or a queued replay sends the same one. */
    send: ({ method, path }, body, idempotencyKey, options = {}) => call(method, path, { body, idempotencyKey, ...options }),
  };
}

/** Normalizes GET /api/session/works: {open, parked} or {works:[…]}. */
export function splitWorks(payload) {
  if (!payload) return { open: null, parked: [] };
  if (Array.isArray(payload.works)) {
    const open = payload.works.find((w) => w.lifecycle === "open") ?? payload.works.find((w) => w.lifecycle === "paused" && !w.parked) ?? null;
    return { open, parked: payload.works.filter((w) => w !== open && w.lifecycle !== "finished") };
  }
  return { open: payload.open ?? payload.work ?? null, parked: payload.parked ?? [] };
}
