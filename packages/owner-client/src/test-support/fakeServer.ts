import { readFileSync } from "node:fs";
import { challengeFor } from "../pkce.js";
import type { AnswerSignature, AnswerSignatureRequest, FetchLike, OwnerCrypto } from "../types.js";

export const ORIGIN = "https://relo.example.com";
export const NOTIFICATION = "ntf_00000000-0000-4000-8000-0000000000a1";
export const INTERACTION = "int_00000000-0000-4000-8000-0000000000b1";
export const DEVICE = "dev_00000000-0000-4000-8000-0000000000c1";

const fixture = JSON.parse(readFileSync(new URL("../../../contracts/fixtures/owner-state-v1.json", import.meta.url), "utf8"));

export function nowSummary(options: { question?: boolean; refreshAt?: string | null } = {}) {
  const summary = structuredClone(fixture.nowSummary);
  if (options.question) {
    summary.needsYou[0].notificationId = NOTIFICATION;
    summary.needsYou[0].question = { id: INTERACTION, standing: "pending", askedAt: summary.serverTime, openedAt: null };
  }
  summary.refreshAt = options.refreshAt ?? null;
  return summary;
}

const stamp = "2026-10-14T10:00:00.000Z";
export function notice(id: number, over: Record<string, unknown> = {}) {
  const n = String(id).padStart(12, "0");
  return {
    subjectId: `sub_00000000-0000-4000-8000-${n}`, notificationId: `ntf_00000000-0000-4000-8000-${n}`, kind: "notice",
    version: { generation: 1, revision: 1 }, title: `Notice ${id}`, summary: "First line\nsecond", source: "build",
    createdAt: stamp, updatedAt: stamp, occurredAt: null, acceptedAt: stamp, readAt: null, currentUntil: null, freshUntil: null,
    deliverUntil: stamp, freshness: "fresh", interaction: null, activity: null, resources: null, ...over,
  };
}

export function fakeCrypto(): OwnerCrypto & { calls: string[]; signed: AnswerSignatureRequest[]; open: (tree: unknown) => unknown } {
  const calls: string[] = [];
  const signed: AnswerSignatureRequest[] = [];
  const b64 = (length: number) => Buffer.alloc(length, 7).toString("base64url");
  return {
    calls, signed,
    open: (tree) => tree,
    async ensureKeys() { calls.push("ensure"); },
    async publishablePrekey(deviceId, { rotate }) {
      calls.push(`prekey:${deviceId}:${rotate ? "rotate" : "keep"}`);
      return { identityKey: b64(65), prekey: { prekeyId: "pk1", publicKey: b64(65), createdAt: stamp, signature: b64(64) } };
    },
    async openTree(tree) { calls.push("open"); return this.open(tree); },
    async signAnswer(request): Promise<AnswerSignature> {
      signed.push(request);
      return { keyId: "k_AAAAAAAAAAAAAAAAAAAAAA", signature: b64(64), ...(request.question ? { questionSignature: b64(64) } : {}) };
    },
  };
}

export interface Seen { method: string; path: string; headers: Record<string, string>; body: any; query: URLSearchParams }

/** An in-process Relo server: the handlers the client talks to, with only the checks that matter to the client. */
export class FakeServer {
  seen: Seen[] = [];
  session = "sess-token-0123456789";
  sessionId = "ses_1";
  deviceToken = "relo_device_token_1";
  codeChallenge: string | null = null;
  registrations = new Map<string, { body: string; token: string }>();
  deviceRevoked = false;
  nowBody: unknown = nowSummary();
  nowStatus = 200;
  nowEtag: string | null = null;
  keysStatus = 200;
  devicesList: unknown[] = [];
  policy: { mode: string; required: boolean } = { mode: "auto", required: false };
  policyStatus = 200;
  current: unknown = { items: [], retired: [], total: 0, cursor: null, hasMore: false, counts: { actionable: 0, currentUnread: 0 }, nextExpiryAt: null, serverTime: stamp };
  detail: any = null;
  interactionStatus = 201;
  dismissStatus = 200;
  interactionBody: unknown = null;
  eventsStatus = 200;
  eventConnections = 0;
  private streams: ReadableStreamDefaultController<Uint8Array>[] = [];

  get fetch(): FetchLike { return (input, init) => this.handle(input, init); }

  count(method: string, path: string): number { return this.seen.filter((s) => s.method === method && s.path === path).length; }

  /** The code the browser would end with, for a PKCE challenge. */
  issueCode(challenge: string): string {
    this.codeChallenge = challenge;
    return "relo_signin_" + "A".repeat(43);
  }

  push(text: string): void {
    for (const s of this.streams) { try { s.enqueue(new TextEncoder().encode(text)); } catch { /* the client closed it */ } }
  }
  hint(ids: string[] = []): void { this.push(`event: current\ndata: ${JSON.stringify({ subjectIds: ids, invalidateCounts: true })}\n\n`); }
  dropStreams(): void { for (const s of this.streams.splice(0)) { try { s.close(); } catch { /* closed */ } } }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  private async handle(input: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    const record = { method, path: url.pathname, headers, body, query: url.searchParams };
    this.seen.push(record);
    const bearer = headers.Authorization?.replace(/^Bearer /, "");
    const deviceOk = bearer === this.deviceToken && !this.deviceRevoked;

    if (method === "POST" && url.pathname === "/api/mobile/sign-in/token") {
      if (!this.codeChallenge || body.code !== "relo_signin_" + "A".repeat(43) || await challengeFor(body.codeVerifier) !== this.codeChallenge) {
        return this.json(400, { error: "invalid_grant" });
      }
      return this.json(200, { sessionToken: this.session, session: { id: this.sessionId, expiresAt: stamp }, user: { id: "u1", name: "Ada", email: "ada@example.com" } });
    }
    if (method === "POST" && url.pathname === "/api/devices/register") {
      if (bearer !== this.session) return this.json(401, { error: "reauthentication_required" });
      const key = headers["Idempotency-Key"];
      if (!key) return this.json(400, { error: "invalid" });
      const text = JSON.stringify(body, Object.keys(body).sort());
      const known = this.registrations.get(key);
      if (known && known.body !== text) return this.json(409, { error: "idempotency_conflict" });
      const token = known?.token ?? (this.registrations.size === 0 ? this.deviceToken : `${this.deviceToken}_${this.registrations.size}`);
      if (!known) this.registrations.set(key, { body: text, token });
      this.deviceToken = token;
      this.deviceRevoked = false;
      return this.json(200, {
        account: { accountId: "acc_1", name: "Ada", email: "ada@example.com", imageUrl: null },
        device: { deviceId: DEVICE, installationId: body.installationId, registrationState: "active", credentialVersion: 1 },
        credential: { accessToken: token, issuedAt: stamp, expiresAt: null },
      });
    }
    if (method === "DELETE" && url.pathname === `/api/devices/${DEVICE}`) { this.deviceRevoked = true; return new Response(null, { status: 204 }); }
    if (method === "POST" && url.pathname === "/api/auth/sign-out") return this.json(200, { success: true });
    if (!deviceOk) return this.json(401, { error: "unauthorized" });

    if (method === "PUT" && url.pathname === "/api/devices/self/keys") {
      return this.keysStatus === 200 ? this.json(200, { keyId: "k_x", identityChanged: false }) : this.json(this.keysStatus, { error: "x" });
    }
    if (method === "PUT" && url.pathname === `/api/devices/${DEVICE}`) return this.json(200, { status: "ok" });
    if (method === "GET" && url.pathname === "/api/now") {
      if (this.nowStatus !== 200) return this.json(this.nowStatus, { error: "x" });
      if (this.nowEtag && headers["If-None-Match"] === this.nowEtag) return new Response(null, { status: 304 });
      return this.json(200, this.nowBody, this.nowEtag ? { etag: this.nowEtag } : {});
    }
    if (url.pathname === "/api/end-to-end/policy") {
      if (this.policyStatus !== 200) return this.json(this.policyStatus, { error: "x" });
      if (method === "PUT") {
        if (!body || Object.keys(body).length !== 1 || !(body.required === true || body.required === null)) return this.json(400, { error: "invalid_request" });
        this.policy = body.required === true ? { mode: "on", required: true } : { mode: "auto", required: false };
      }
      return this.json(200, this.policy);
    }
    if (method === "GET" && url.pathname === "/api/devices/self/devices") return this.json(200, { devices: this.devicesList });
    if (method === "GET" && url.pathname === "/api/inbox/current") return this.json(200, this.current);
    if (method === "GET" && url.pathname === "/api/inbox/events") {
      this.eventConnections += 1;
      if (this.eventsStatus !== 200) return this.json(this.eventsStatus, { error: "x" });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => { controller = c; this.streams.push(c); },
      });
      init.signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* closed */ } }, { once: true });
      controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (method === "GET" && url.pathname === `/api/inbox/${NOTIFICATION}`) {
      return this.detail ? this.json(200, this.detail) : this.json(404, { error: "not_found" });
    }
    if (method === "POST" && url.pathname === `/api/devices/self/questions/${INTERACTION}/dismiss`) {
      return this.dismissStatus === 200 ? this.json(200, { dismissed: true }) : this.json(this.dismissStatus, { error: "x" });
    }
    if (method === "POST" && url.pathname === `/api/notifications/${NOTIFICATION}/interactions`) {
      if (this.interactionStatus >= 400) return this.json(this.interactionStatus, this.interactionBody ?? { error: "x" });
      return this.json(this.interactionStatus, { interactionId: "int_ev1", replayed: false, decision: { id: INTERACTION, state: "responded", respondedAt: stamp } });
    }
    return this.json(404, { error: "not_found" });
  }
}

export function questionDetail(over: Record<string, unknown> = {}, sealed: unknown = null) {
  return {
    item: {
      id: NOTIFICATION,
      interaction: { id: INTERACTION, kind: "choice", prompt: "Ship it?", state: "pending", expiresAt: "2099-01-01T00:00:00.000Z",
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], ...over },
      sealed,
    },
    evidence: {},
  };
}
