import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerStore } from "./store.js";
import { DEVICE, fakeCrypto, FakeServer, INTERACTION, NOTIFICATION, notice, nowSummary, ORIGIN, questionDetail } from "./test-support/fakeServer.js";
import { memoryStore, type DeviceInfo } from "./types.js";

const realImmediate = setImmediate;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => realImmediate(r)); };
let current: FakeServer | null = null;
/** Time passes in 10 s steps; the server keeps its stream alive as the real one does every 15 s. */
const advance = async (ms: number) => {
  for (let left = ms; left > 0; left -= 10_000) {
    await vi.advanceTimersByTimeAsync(Math.min(left, 10_000));
    current?.push(": keepalive\n\n");
    await settle();
  }
};

const info: DeviceInfo = { name: "PC", bundleIdentifier: "app.relo.windows", appVersion: "0.1.0", appBuild: "1", osVersion: "10.0.26200" };
const CODE = "relo_signin_" + "A".repeat(43);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-14T10:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

function setup(server = new FakeServer()) {
  current = server;
  const secrets = memoryStore();
  const prefs = memoryStore();
  const crypto = fakeCrypto();
  let n = 0;
  const make = () => new OwnerStore({
    fetch: server.fetch, secrets, prefs, crypto, device: info, random: () => 0,
    randomUuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
  return { server, secrets, prefs, crypto, store: make(), make };
}

async function signIn(ctx: ReturnType<typeof setup>) {
  await ctx.store.start();
  expect(await ctx.store.setServerOrigin(ORIGIN)).toBe(true);
  const url = new URL((await ctx.store.beginSignIn())!);
  ctx.server.codeChallenge = url.searchParams.get("code_challenge");
  const state = url.searchParams.get("state")!;
  await ctx.store.completeSignIn(`relo://auth/callback?code=${CODE}&state=${state}`);
  await settle();
  return state;
}

describe("sign-in", () => {
  it("signs in, registers, publishes keys, reads Now and listens for changes", async () => {
    const ctx = setup();
    expect(ctx.store.getState().connection).toBe("starting");
    await ctx.store.start();
    expect(ctx.store.getState().connection).toBe("signedOut");
    await signIn(ctx);
    const state = ctx.store.getState();
    expect(state.connection).toBe("live");
    expect(state.accountEmail).toBe("ada@example.com");
    expect(state.summary?.needsYou).toHaveLength(1);
    expect(ctx.server.count("POST", "/api/devices/register")).toBe(1);
    expect(ctx.server.count("PUT", "/api/devices/self/keys")).toBe(1);
    expect(ctx.crypto.calls).toContain(`prekey:${DEVICE}:keep`);
    expect(ctx.server.eventConnections).toBe(1);
    const nowCall = ctx.server.seen.find((s) => s.path === "/api/now")!;
    expect(nowCall.headers.Authorization).toBe(`Bearer ${ctx.server.deviceToken}`);
    expect(await ctx.secrets.get("relo.owner.device")).toContain(ctx.server.deviceToken);
    ctx.store.stop();
  });

  it("rejects a callback whose state does not match and keeps the attempt open", async () => {
    const ctx = setup();
    await ctx.store.start();
    await ctx.store.setServerOrigin(ORIGIN);
    const url = new URL((await ctx.store.beginSignIn())!);
    ctx.server.codeChallenge = url.searchParams.get("code_challenge");
    await expect(ctx.store.completeSignIn(`relo://auth/callback?code=${CODE}&state=forged`)).rejects.toMatchObject({ kind: "state_mismatch" });
    expect(ctx.store.getState().connection).toBe("signingIn");
    expect(ctx.server.count("POST", "/api/mobile/sign-in/token")).toBe(0);
    await ctx.store.completeSignIn(`relo://auth/callback?code=${CODE}&state=${url.searchParams.get("state")}`);
    await settle();
    expect(ctx.store.getState().connection).toBe("live");
    ctx.store.stop();
  });

  it("completes a callback after the page reloaded: the attempt was stored, not only held in memory", async () => {
    const ctx = setup();
    await ctx.store.start();
    await ctx.store.setServerOrigin(ORIGIN);
    const url = new URL((await ctx.store.beginSignIn({ device: "windows" }))!);
    expect(url.searchParams.get("device")).toBe("windows");
    ctx.server.codeChallenge = url.searchParams.get("code_challenge");
    ctx.store.stop();
    const reloaded = ctx.make();
    await reloaded.start();
    await reloaded.completeSignIn(`relo://auth/callback?code=${CODE}&state=${url.searchParams.get("state")}`);
    await settle();
    expect(reloaded.getState().connection).toBe("live");
    expect(await ctx.secrets.get("relo.owner.signin")).toBeNull();
    reloaded.stop();
  });

  it("reuses the same page for the attempt in progress and forgets a cancelled one", async () => {
    const ctx = setup();
    await ctx.store.start();
    await ctx.store.setServerOrigin(ORIGIN);
    const first = (await ctx.store.beginSignIn())!;
    expect(ctx.store.pendingSignInUrl()).toBe(first);
    ctx.store.cancelSignIn();
    await settle();
    expect(ctx.store.pendingSignInUrl()).toBeNull();
    expect(await ctx.secrets.get("relo.owner.signin")).toBeNull();
  });

  it("signs in with a code handed over by the installer, no browser", async () => {
    const ctx = setup();
    await ctx.store.start();
    const pkce = await (await import("./pkce.js")).createPkce();
    ctx.server.codeChallenge = pkce.challenge;
    await ctx.store.signInWithCode({ code: CODE, verifier: pkce.verifier, origin: ORIGIN });
    await settle();
    expect(ctx.store.getState()).toMatchObject({ connection: "live", accountEmail: "ada@example.com" });
    ctx.store.stop();
  });

  it("logs a failed sign-in", async () => {
    const ctx = setup();
    const log = vi.fn();
    const store = new OwnerStore({ fetch: ctx.server.fetch, secrets: memoryStore(), crypto: ctx.crypto, device: info, log });
    await store.start();
    await store.setServerOrigin(ORIGIN);
    const url = new URL((await store.beginSignIn())!);
    await store.completeSignIn(`relo://auth/callback?code=${CODE}&state=${url.searchParams.get("state")}`);
    expect(log).toHaveBeenCalledWith("sign-in failed", expect.anything());
  });

  it("returns to where it was when the owner cancels", async () => {
    const ctx = setup();
    await ctx.store.start();
    await ctx.store.setServerOrigin(ORIGIN);
    const url = new URL((await ctx.store.beginSignIn())!);
    await ctx.store.completeSignIn(`relo://auth/callback?error=access_denied&state=${url.searchParams.get("state")}`);
    expect(ctx.store.getState().connection).toBe("signedOut");
  });

  it("reports a refused code and stays signed out", async () => {
    const ctx = setup();
    await ctx.store.start();
    await ctx.store.setServerOrigin(ORIGIN);
    const url = new URL((await ctx.store.beginSignIn())!);
    await ctx.store.completeSignIn(`relo://auth/callback?code=${CODE}&state=${url.searchParams.get("state")}`);
    expect(ctx.store.getState()).toMatchObject({ connection: "signedOut", problem: expect.stringContaining("expired") });
  });

  it("needs a server address first", async () => {
    const ctx = setup();
    await ctx.store.start();
    expect(await ctx.store.beginSignIn()).toBeNull();
    expect(ctx.store.getState().problem).toContain("address");
  });

  it("resumes from the stored credential after a restart without signing in again", async () => {
    const ctx = setup();
    await signIn(ctx);
    ctx.store.stop();
    const again = ctx.make();
    await again.start();
    await settle();
    expect(again.getState().connection).toBe("live");
    expect(ctx.server.count("POST", "/api/devices/register")).toBe(1);
    again.stop();
  });
});

describe("local sign-in by code", () => {
  const LOCAL = "http://127.0.0.1:8187";
  const VERIFIER = "v".repeat(43);

  async function local(ctx: ReturnType<typeof setup>) {
    await ctx.store.start();
    ctx.server.codeChallenge = await (await import("./pkce.js")).challengeFor(VERIFIER);
    await ctx.store.signInLocal(LOCAL, CODE, VERIFIER);
    await settle();
  }

  it("signs in without a browser, registers, and publishes no keys", async () => {
    const ctx = setup();
    await local(ctx);
    expect(ctx.store.getState()).toMatchObject({ connection: "live", serverOrigin: LOCAL, problem: null });
    expect(ctx.server.count("POST", "/api/devices/register")).toBe(1);
    expect(ctx.server.count("PUT", "/api/devices/self/keys")).toBe(0);
    ctx.store.stop();
  });

  it("stays local after a restart: still no keys", async () => {
    const ctx = setup();
    await local(ctx);
    ctx.store.stop();
    const again = ctx.make();
    await again.start();
    await settle();
    expect(again.getState().connection).toBe("live");
    expect(ctx.server.count("PUT", "/api/devices/self/keys")).toBe(0);
    again.stop();
  });

  it("refuses an origin that is not this PC's, and a malformed code", async () => {
    const ctx = setup();
    await ctx.store.start();
    await ctx.store.signInLocal("https://relo.example.com", CODE, VERIFIER);
    expect(ctx.store.getState().connection).toBe("signedOut");
    expect(ctx.store.getState().problem).toContain("address");
    await ctx.store.signInLocal(LOCAL, "relo_signin_short", VERIFIER);
    expect(ctx.store.getState().connection).toBe("signedOut");
    expect(ctx.server.count("POST", "/api/mobile/sign-in/token")).toBe(0);
  });

  it("a wrong verifier ends signed out with the server's words", async () => {
    const ctx = setup();
    await ctx.store.start();
    ctx.server.codeChallenge = await (await import("./pkce.js")).challengeFor(VERIFIER);
    await ctx.store.signInLocal(LOCAL, CODE, "w".repeat(43));
    expect(ctx.store.getState().connection).toBe("signedOut");
    expect(ctx.store.getState().problem).toBeTruthy();
  });
});

describe("401 handling", () => {
  it("a refused Now ends in needsSignIn and stops reading", async () => {
    const ctx = setup();
    await signIn(ctx);
    ctx.server.deviceRevoked = true;
    await advance(60_000);
    expect(ctx.store.getState()).toMatchObject({ connection: "needsSignIn", problem: expect.stringContaining("Sign in again") });
    const reads = ctx.server.count("GET", "/api/now");
    await advance(300_000);
    expect(ctx.server.count("GET", "/api/now")).toBe(reads);
  });

  it("a refused event stream ends in needsSignIn too", async () => {
    const ctx = setup();
    ctx.server.eventsStatus = 401;
    await signIn(ctx);
    expect(ctx.store.getState().connection).toBe("needsSignIn");
  });

  it("an unreachable server is offline, not signed out, and recovers", async () => {
    const ctx = setup();
    await signIn(ctx);
    ctx.server.nowStatus = 503;
    await advance(60_000);
    expect(ctx.store.getState().connection).toBe("offline");
    ctx.server.nowStatus = 200;
    await advance(60_000);
    expect(ctx.store.getState().connection).toBe("live");
    ctx.store.stop();
  });

  it("an answer that gets 401 also needs a sign-in", async () => {
    const ctx = setup();
    ctx.server.nowBody = nowSummary({ question: true });
    ctx.server.detail = questionDetail();
    await signIn(ctx);
    ctx.server.deviceRevoked = true;
    await ctx.store.answer(NOTIFICATION, "choose", { optionId: "yes" });
    expect(ctx.store.getState().connection).toBe("needsSignIn");
  });
});

describe("reading Now", () => {
  it("refetches at the server's refreshAt (its own clock), else every 60 s", async () => {
    const ctx = setup();
    ctx.server.nowBody = nowSummary({ refreshAt: "2026-10-14T10:00:20.000Z" }); // serverTime 10:00:00 -> wait 21 s
    await signIn(ctx);
    expect(ctx.server.count("GET", "/api/now")).toBe(1);
    await advance(20_500);
    expect(ctx.server.count("GET", "/api/now")).toBe(1);
    await advance(1_000);
    expect(ctx.server.count("GET", "/api/now")).toBe(2);
    ctx.server.nowBody = nowSummary(); // no refreshAt: the 60 s tick
    for (let i = 0; i < 30 && ctx.server.count("GET", "/api/now") < 3; i++) await advance(1_000); // 3rd read, at the 2nd's refreshAt
    const afterThird = ctx.server.count("GET", "/api/now");
    expect(afterThird).toBe(3);
    await advance(59_000);
    expect(ctx.server.count("GET", "/api/now")).toBe(afterThird);
    await advance(2_000);
    expect(ctx.server.count("GET", "/api/now")).toBe(afterThird + 1);
    ctx.store.stop();
  });

  it("a change hint becomes one read after 750 ms, however many hints arrive", async () => {
    const ctx = setup();
    await signIn(ctx);
    const before = ctx.server.count("GET", "/api/now");
    ctx.server.hint(); ctx.server.hint(); ctx.server.hint();
    await advance(700);
    expect(ctx.server.count("GET", "/api/now")).toBe(before);
    await advance(100);
    expect(ctx.server.count("GET", "/api/now")).toBe(before + 1);
    ctx.store.stop();
  });

  it("after the stream drops it reads Now again and reconnects", async () => {
    const ctx = setup();
    await signIn(ctx);
    const before = ctx.server.count("GET", "/api/now");
    ctx.server.dropStreams();
    await advance(1_000);
    expect(ctx.server.eventConnections).toBe(2);
    expect(ctx.server.count("GET", "/api/now")).toBeGreaterThan(before);
    ctx.store.stop();
  });

  it("sends If-None-Match once the server offers an ETag, and keeps the summary on 304", async () => {
    const ctx = setup();
    ctx.server.nowEtag = '"v1"';
    await signIn(ctx);
    const summary = ctx.store.getState().summary;
    await advance(60_000);
    const last = ctx.server.seen.filter((s) => s.path === "/api/now").at(-1)!;
    expect(last.headers["If-None-Match"]).toBe('"v1"');
    expect(ctx.store.getState().summary).toBe(summary);
    expect(ctx.store.getState().connection).toBe("live");
    ctx.store.stop();
  });

  it("refuses a Now that is not the contract", async () => {
    const ctx = setup();
    ctx.server.nowBody = { serverTime: "x" };
    await signIn(ctx);
    expect(ctx.store.getState()).toMatchObject({ connection: "offline", summary: null });
    ctx.store.stop();
  });

  it("opens sealed text through the injected crypto before showing it", async () => {
    const ctx = setup();
    ctx.crypto.open = (tree) => { const t = structuredClone(tree) as any; t.needsYou[0].title = "Opened title"; return t; };
    await signIn(ctx);
    expect(ctx.store.getState().summary?.needsYou[0]?.title).toBe("Opened title");
    ctx.store.stop();
  });
});

describe("encryption keys", () => {
  it("rotates the prekey every 10 hours and retries a failed publish after a minute", async () => {
    const ctx = setup();
    await signIn(ctx);
    expect(ctx.server.count("PUT", "/api/devices/self/keys")).toBe(1);
    await advance(9 * 3600_000);
    expect(ctx.server.count("PUT", "/api/devices/self/keys")).toBe(1);
    ctx.server.keysStatus = 500;
    await advance(2 * 3600_000);
    const failed = ctx.server.count("PUT", "/api/devices/self/keys");
    expect(failed).toBeGreaterThan(1);
    expect(ctx.store.getState().problem).toContain("keys");
    ctx.server.keysStatus = 200;
    await advance(120_000);
    expect(ctx.crypto.calls.filter((c) => c.endsWith(":rotate")).length).toBeGreaterThanOrEqual(2);
    await advance(3_600_000);
    const published = ctx.server.count("PUT", "/api/devices/self/keys");
    await advance(3_600_000);
    expect(ctx.server.count("PUT", "/api/devices/self/keys")).toBe(published); // not again for 10 h
    ctx.store.stop();
  });
});

describe("notices", () => {
  const stamp = "2026-10-14T09:59:30.000Z";

  it("shows and announces a fresh notice when no phone gets the push, and only once", async () => {
    const ctx = setup();
    ctx.server.current = { ...(ctx.server.current as object), items: [notice(1, { createdAt: stamp }), notice(2, { createdAt: "2026-10-14T08:00:00.000Z" })], total: 2,
      serverTime: "2026-10-14T10:00:00.000Z" };
    await signIn(ctx);
    const state = ctx.store.getState();
    expect(state.phoneReceivesPushes).toBe(false);
    expect(state.notices.map((n) => n.title)).toEqual(["Notice 1", "Notice 2"]);
    expect(state.noticeArrivals.serial).toBe(1);
    expect(state.noticeArrivals.notices.map((n) => n.title)).toEqual(["Notice 1"]);
    await advance(60_000);
    expect(ctx.store.getState().noticeArrivals.serial).toBe(1);
    expect(await ctx.prefs.get("relo.owner.seenNotices")).toContain("sub_00000000-0000-4000-8000-000000000001");
    ctx.store.stop();
  });

  it("stays quiet when an iPhone receives pushes", async () => {
    const ctx = setup();
    ctx.server.devicesList = [{ trusted: true }];
    ctx.server.current = { ...(ctx.server.current as object), items: [notice(1)], total: 1 };
    await signIn(ctx);
    expect(ctx.store.getState()).toMatchObject({ phoneReceivesPushes: true, notices: [] });
    expect(ctx.server.count("GET", "/api/inbox/current")).toBe(0);
    ctx.store.stop();
  });
});

describe("answers", () => {
  it("answers a choice, signed and bound to the sealed question", async () => {
    const ctx = setup();
    ctx.server.nowBody = nowSummary({ question: true });
    ctx.server.detail = questionDetail({}, { alert: null, content: { kind: "question", context: "ntf:abc123" } });
    await signIn(ctx);
    expect(ctx.store.getState().questions[NOTIFICATION]).toMatchObject({ prompt: "Ship it?", kind: "choice", sealedContext: "ntf:abc123" });
    await ctx.store.answer(NOTIFICATION, "choose", { optionId: "yes" });
    expect(ctx.store.getState().answers[NOTIFICATION]).toEqual({ phase: "accepted" });
    const post = ctx.server.seen.find((s) => s.method === "POST" && s.path.endsWith("/interactions"))!;
    expect(post.headers.Authorization).toBe(`Bearer ${ctx.server.deviceToken}`);
    expect(post.body).toMatchObject({
      kind: "choose", expectedInteractionId: INTERACTION,
      idempotencyKey: expect.stringMatching(/^win:00000000-0000-4000-8000-\d+:ntf_.*:choose:yes$/),
      value: { optionId: "yes", e2eeKeyId: "k_AAAAAAAAAAAAAAAAAAAAAA", e2eeQuestion: "ntf:abc123",
        e2eeSignedAt: "2026-10-14T10:00:00.000Z", e2eeSignature: expect.any(String), e2eeQuestionSignature: expect.any(String) },
    });
    expect(ctx.crypto.signed[0]).toEqual({
      interactionId: INTERACTION, notificationId: NOTIFICATION, deviceId: DEVICE, value: "choose:yes",
      respondedAt: "2026-10-14T10:00:00.000Z", question: "ntf:abc123",
    });
    ctx.store.stop();
  });

  it("does not bind an answer to a placeholder prompt, and signs a typed reply by digest", async () => {
    const ctx = setup();
    ctx.server.nowBody = nowSummary({ question: true });
    ctx.server.detail = questionDetail({ kind: "text", prompt: "Encrypted question", options: undefined }, { alert: null, content: { kind: "question", context: "ntf:abc" } });
    await signIn(ctx);
    await ctx.store.answer(NOTIFICATION, "answer", { response: "hello" });
    const request = ctx.crypto.signed[0]!;
    expect(request.question).toBeUndefined();
    expect(request.value).toBe("answer:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    ctx.store.stop();
  });

  it("refuses an answer the question does not take, or after it expired, without calling the server", async () => {
    const ctx = setup();
    ctx.server.nowBody = nowSummary({ question: true });
    ctx.server.detail = questionDetail();
    await signIn(ctx);
    await ctx.store.answer(NOTIFICATION, "approve");
    expect(ctx.store.getState().answers[NOTIFICATION]).toMatchObject({ phase: "failed" });
    await ctx.store.answer(NOTIFICATION, "choose", { optionId: "nope" });
    expect(ctx.server.count("POST", `/api/notifications/${NOTIFICATION}/interactions`)).toBe(0);
    ctx.server.detail = questionDetail({ expiresAt: "2026-10-14T09:00:00.000Z" });
    await ctx.store.answer(NOTIFICATION, "choose", { optionId: "yes" });
    expect(ctx.server.count("POST", `/api/notifications/${NOTIFICATION}/interactions`)).toBe(0);
    ctx.store.stop();
  });

  it("says why the server refused", async () => {
    const ctx = setup();
    ctx.server.nowBody = nowSummary({ question: true });
    ctx.server.detail = questionDetail();
    await signIn(ctx);
    ctx.server.interactionStatus = 409;
    ctx.server.interactionBody = { error: "not_asked_copy" };
    await ctx.store.answer(NOTIFICATION, "choose", { optionId: "yes" });
    expect(ctx.store.getState().answers[NOTIFICATION]).toEqual({ phase: "failed", message: expect.stringContaining("copy") });
    ctx.store.stop();
  });

  it("treats an answered question as gone", async () => {
    const ctx = setup();
    ctx.server.nowBody = nowSummary({ question: true });
    ctx.server.detail = questionDetail({ state: "responded" });
    await signIn(ctx);
    expect(ctx.store.getState().questions).toEqual({});
    await ctx.store.answer(NOTIFICATION, "choose", { optionId: "yes" });
    expect(ctx.store.getState().answers[NOTIFICATION]).toEqual({ phase: "failed", message: "Already answered or expired" });
    ctx.store.stop();
  });
});

describe("dismissing a missed question", () => {
  it("posts the dismissal with the device bearer, then reads Now again", async () => {
    const ctx = setup();
    ctx.server.nowBody = nowSummary({ question: true });
    ctx.server.detail = questionDetail();
    await signIn(ctx);
    const nowBefore = ctx.server.count("GET", "/api/now");
    await ctx.store.dismissMissed(INTERACTION);
    const post = ctx.server.seen.find((s) => s.method === "POST" && s.path === `/api/devices/self/questions/${INTERACTION}/dismiss`)!;
    expect(post.headers.Authorization).toBe(`Bearer ${ctx.server.deviceToken}`);
    expect(ctx.server.count("GET", "/api/now")).toBeGreaterThan(nowBefore);
    ctx.store.stop();
  });

  it("does not call the server for an id that is not an interaction, and survives a refusal", async () => {
    const ctx = setup();
    ctx.server.nowBody = nowSummary({ question: true });
    ctx.server.detail = questionDetail();
    await signIn(ctx);
    await ctx.store.dismissMissed("../../x");
    expect(ctx.server.seen.some((s) => s.path.includes("dismiss"))).toBe(false);
    ctx.server.dismissStatus = 500;
    await ctx.store.dismissMissed(INTERACTION);
    expect(ctx.store.getState().connection).toBe("live");
    ctx.store.stop();
  });
});

describe("sign-out", () => {
  it("revokes the device, ends the session and forgets the credential", async () => {
    const ctx = setup();
    await signIn(ctx);
    await ctx.store.signOut();
    expect(ctx.server.count("DELETE", `/api/devices/${DEVICE}`)).toBe(1);
    expect(ctx.server.count("POST", "/api/auth/sign-out")).toBe(1);
    expect(await ctx.secrets.get("relo.owner.device")).toBeNull();
    expect(await ctx.secrets.get("relo.owner.session")).toBeNull();
    expect(ctx.store.getState()).toMatchObject({ connection: "signedOut", summary: null, serverOrigin: ORIGIN });
    const reads = ctx.server.count("GET", "/api/now");
    await advance(120_000);
    expect(ctx.server.count("GET", "/api/now")).toBe(reads);
  });
});
