import { ApiError, NetworkError } from "./errors.mjs";

function retryAfterSeconds(response) {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1_000));
}

export const MAX_AUTO_RETRY_SECONDS = 10;
/** The pause before the one automatic retry of an idempotent request after a network error. */
export const NETWORK_RETRY_MS = 750;

/** A server older than the sessions API answers 404 on its routes: say so instead of "No such item". */
function sessionsUnsupported(error) {
  if (!(error instanceof ApiError) || error.status !== 404) throw error;
  throw new ApiError("This Relo server doesn't report sessions yet.", {
    status: 404, code: "SESSIONS_UNSUPPORTED", details: { hint: "Update the server to 0.10.0 or later." },
  });
}

export class ReloApiClient {
  constructor({ apiUrl, token, fetchImpl = globalThis.fetch, version = "0.9.0",
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) }) {
    this.sleep = sleep;
    this.apiUrl = String(apiUrl).replace(/\/$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.version = version;
  }

  async request(
    method,
    path,
    { body, idempotencyKey, query, authenticated = true, timeoutMs = 30_000, retried = false, sessionKey } = {},
  ) {
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = {
      accept: "application/json",
      "user-agent": `reloctl/${this.version}`,
    };
    if (authenticated) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    // Asked in an agent session: the server attaches the question to the session's open work.
    if (sessionKey) headers["relo-session-key"] = sessionKey;

    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // A read, or a write carrying an idempotency key, is safe to send again: one retry after a short
      // pause absorbs a transient edge blip (DOGFOOD #7). A timeout is not retried (it already waited).
      const idempotent = method === "GET" || Boolean(idempotencyKey);
      if (idempotent && !retried && error?.name !== "TimeoutError") {
        await this.sleep(NETWORK_RETRY_MS);
        return this.request(method, path, { body, idempotencyKey, query, authenticated, timeoutMs, retried: true, sessionKey });
      }
      throw new NetworkError(error instanceof Error ? error.message : "Unable to reach Relo API",
        { transient: true, retried: idempotent && retried, ...(idempotencyKey ? { idempotencyKey } : {}) });
    }

    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const apiError = payload?.error;
      const retryAfter = retryAfterSeconds(response)
        ?? (Number.isFinite(payload?.retryAfterSeconds) && payload.retryAfterSeconds >= 0 ? Math.ceil(payload.retryAfterSeconds) : undefined);
      // A write carries an idempotency key, so one retry after a short 429 wait cannot duplicate it.
      if (response.status === 429 && !retried && idempotencyKey && retryAfter !== undefined && retryAfter <= MAX_AUTO_RETRY_SECONDS) {
        await this.sleep(retryAfter * 1_000);
        return this.request(method, path, { body, idempotencyKey, query, authenticated, timeoutMs, retried: true, sessionKey });
      }
      throw new ApiError(
        typeof apiError?.message === "string"
          ? apiError.message
          // {"error":"code","message":"…"}: the server's sentence, not just its code.
          : typeof apiError === "string" && typeof payload?.message === "string"
            ? payload.message
          : typeof apiError === "string"
            ? apiError
            : `Relo API returned HTTP ${response.status}`,
        {
          status: response.status,
          code:
            typeof apiError?.code === "string"
              ? apiError.code
              : typeof apiError === "string"
                ? apiError.toUpperCase()
                : "API_ERROR",
          details: {
            ...(apiError?.details ?? {}),
            ...(Number.isFinite(payload?.intervalSeconds)
              ? { intervalSeconds: payload.intervalSeconds }
              : {}),
            ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
          },
        },
      );
    }
    return payload ?? {};
  }

  startDeviceAuthorization(body) {
    return this.request("POST", "/api/device-authorizations/start", {
      body,
      authenticated: false,
    });
  }

  pollDeviceAuthorization(deviceCode) {
    return this.request("POST", "/api/device-authorizations/token", {
      body: { deviceCode },
      authenticated: false,
    });
  }

  authStatus() {
    return this.request("GET", "/api/clients/self");
  }

  revokeAuth() {
    return this.request("DELETE", "/api/clients/self");
  }

  sendNotification(body, idempotencyKey, sessionKey) {
    // In an agent session the server folds the notice into the session's open work (no buzz of its own).
    return this.request("POST", "/api/notifications", { body, idempotencyKey, ...(sessionKey ? { sessionKey } : {}) });
  }

  withdrawNotification(id, idempotencyKey) {
    return this.request("POST", `/api/notifications/${encodeURIComponent(id)}/withdraw`, {
      body: {},
      idempotencyKey,
    });
  }

  createInteraction(body, idempotencyKey, sessionKey) {
    return this.request("POST", "/api/interactions", { body, idempotencyKey, ...(sessionKey ? { sessionKey } : {}) });
  }

  getInteraction(id) {
    return this.request("GET", `/api/interactions/${encodeURIComponent(id)}`);
  }

  /** Settled questions this login asked, after a cursor (or since a time), waiting up to timeoutSeconds. */
  listAnswers({ after, since, timeoutSeconds }) {
    return this.request("GET", "/api/interactions/answers", {
      query: { ...(after ? { after } : {}), ...(since ? { since } : {}), timeoutSeconds },
      timeoutMs: (timeoutSeconds + 5) * 1_000,
    });
  }

  waitForInteraction(id, timeoutSeconds) {
    return this.request("GET", `/api/interactions/${encodeURIComponent(id)}/wait`, {
      query: { timeoutSeconds },
      timeoutMs: (timeoutSeconds + 5) * 1_000,
    });
  }

  cancelInteraction(id) {
    return this.request("POST", `/api/interactions/${encodeURIComponent(id)}/cancel`, {
      body: {},
    });
  }

  startActivity(body, idempotencyKey) {
    return this.request("POST", "/api/live-activities", { body, idempotencyKey });
  }

  resolveActivity(resolver) {
    const body = resolver?.origin !== undefined || resolver?.lifecycle !== undefined || resolver?.current === true
      ? resolver
      : { origin: resolver };
    return this.request("POST", "/api/live-activities/resolve", { body });
  }

  createActivityWait(id, body, idempotencyKey) {
    return this.request("POST", `/api/live-activities/${encodeURIComponent(id)}/wait`, {
      body,
      idempotencyKey,
    });
  }

  updateActivity(id, body, idempotencyKey) {
    return this.request("PATCH", `/api/live-activities/${encodeURIComponent(id)}`, {
      body,
      idempotencyKey,
    });
  }

  heartbeatActivity(id, body) {
    return this.request("POST", `/api/live-activities/${encodeURIComponent(id)}/heartbeat`, {
      body,
    });
  }

  endActivity(id, body, idempotencyKey) {
    return this.request("POST", `/api/live-activities/${encodeURIComponent(id)}/end`, {
      body,
      idempotencyKey,
    });
  }

  getActivity(id) {
    return this.request("GET", `/api/live-activities/${encodeURIComponent(id)}`);
  }

  diagnoseActivity(id) {
    return this.request("GET", `/api/live-activities/${encodeURIComponent(id)}/diagnosis`);
  }

  listActivities(limit) {
    return this.request("GET", "/api/live-activities", {
      ...(limit === undefined ? {} : { query: { limit } }),
    });
  }

  reconcileDelivery(id, action) {
    return this.request("POST", `/api/deliveries/${encodeURIComponent(id)}/reconcile`, {
      body: { action },
    });
  }

  getEvidenceTimeline({ notificationId, limit, cursor } = {}) {
    return this.request("GET", "/api/evidence/timeline", {
      query: { notificationId, limit, cursor },
    });
  }

  getEvidenceMetrics() {
    return this.request("GET", "/api/evidence/metrics");
  }

  listDevices({ limit, cursor } = {}) {
    return this.request("GET", "/api/devices", {
      ...(limit === undefined && cursor === undefined ? {} : { query: { limit, cursor } }),
    });
  }

  listDeviceKeys() {
    return this.request("GET", "/api/devices/keys");
  }

  endToEndPolicy() {
    return this.request("GET", "/api/end-to-end/policy");
  }

  setEndToEndPolicy(required) {
    return this.request("PUT", "/api/end-to-end/policy", { body: { required } });
  }

  publishClientKey(body) {
    return this.request("PUT", "/api/clients/self/keys", { body });
  }

  listServices() {
    return this.request("GET", "/api/services");
  }

  createService(body) {
    return this.request("POST", "/api/services", { body });
  }

  revokeService(id) {
    return this.request("DELETE", `/api/services/${encodeURIComponent(id)}`);
  }

  /** Mints this computer's harness credential (observed snapshots only) with the CLI credential. */
  createHarnessCredential(body) {
    return this.request("POST", "/api/harness-credentials", { body });
  }

  revokeHarnessCredential(id) {
    return this.request("DELETE", `/api/harness-credentials/${encodeURIComponent(id)}`);
  }

  /** `phases` (e.g. ["working","waiting"]) lists only those; a server before phases ignores the filter. */
  listAgentSessions({ phases } = {}) {
    return this.request("GET", "/api/agent-sessions", phases?.length ? { query: { phase: phases.join(",") } } : {})
      .catch(sessionsUnsupported);
  }

  ready() {
    return this.request("GET", "/health/ready", { authenticated: false });
  }

  doctor() {
    return this.request("GET", "/api/doctor");
  }
}
