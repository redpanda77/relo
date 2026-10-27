import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptionDetail, encryptionNote, encryptionTitle, ENCRYPTION_NO_PHONE_NOTE } from "./policy.js";
import { OwnerStore } from "./store.js";
import { fakeCrypto, FakeServer, nowSummary, ORIGIN } from "./test-support/fakeServer.js";
import { memoryStore, type DeviceInfo } from "./types.js";

const realImmediate = setImmediate;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => realImmediate(r)); };
const info: DeviceInfo = { name: "PC", bundleIdentifier: "app.relo.windows", appVersion: "0.1.0", appBuild: "1", osVersion: "10.0.26200" };
const CODE = "relo_signin_" + "A".repeat(43);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-14T10:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

async function signedIn(server = new FakeServer()) {
  let n = 0;
  const store = new OwnerStore({
    fetch: server.fetch, secrets: memoryStore(), prefs: memoryStore(), crypto: fakeCrypto(), device: info, random: () => 0,
    randomUuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
  await store.start();
  await store.setServerOrigin(ORIGIN);
  const url = new URL((await store.beginSignIn())!);
  server.codeChallenge = url.searchParams.get("code_challenge");
  await store.completeSignIn(`relo://auth/callback?code=${CODE}&state=${url.searchParams.get("state")}`);
  await settle();
  return { server, store };
}

describe("the encryption words", () => {
  it("are the Mac's, with PC where it said Mac", () => {
    expect(encryptionTitle("on")).toBe("Always");
    expect(encryptionTitle("off")).toBe("Off");
    expect(encryptionTitle("auto")).toBe("Automatic");
    expect(encryptionDetail("auto")).toBe("Automatic: on once an iPhone is trusted");
    expect(encryptionDetail("on")).toBe("Always: every card is sealed for your trusted devices");
    expect(encryptionDetail("off")).toBe("Off: cards are stored readable on the server");
    expect(ENCRYPTION_NO_PHONE_NOTE).toBe("Cards will open only on this PC until you add an iPhone.");
  });

  it("warn about Always only when no iPhone is trusted", () => {
    expect(encryptionNote({ mode: "on", required: true }, false)).toBe(ENCRYPTION_NO_PHONE_NOTE);
    expect(encryptionNote({ mode: "on", required: true }, true)).toBeNull();
    expect(encryptionNote({ mode: "auto", required: false }, false)).toBeNull();
    expect(encryptionNote(null, false)).toBeNull();
  });
});

describe("the account's encryption policy on the server", () => {
  it("is read from GET /api/end-to-end/policy with the device credential, with whether an iPhone is trusted", async () => {
    const server = new FakeServer();
    server.devicesList = [{ trusted: true, isCurrent: false }, { trusted: true, isCurrent: true }];
    const { store } = await signedIn(server);
    expect(store.getState().encryption).toBeNull();
    await store.refreshEncryption();
    expect(store.getState().encryption).toEqual({ mode: "auto", required: false });
    expect(store.getState().phoneTrusted).toBe(true);
    const read = server.seen.find((s) => s.method === "GET" && s.path === "/api/end-to-end/policy")!;
    expect(read.headers.Authorization).toBe(`Bearer ${server.deviceToken}`);
  });

  it("is changed with PUT { required: true } for Always and { required: null } for Automatic, never an Off", async () => {
    const server = new FakeServer();
    const { store } = await signedIn(server);
    expect(await store.setEncryption(true)).toBeNull();
    expect(store.getState().encryption).toEqual({ mode: "on", required: true });
    expect(await store.setEncryption(false)).toBeNull();
    expect(store.getState().encryption).toEqual({ mode: "auto", required: false });
    const puts = server.seen.filter((s) => s.method === "PUT" && s.path === "/api/end-to-end/policy").map((s) => s.body);
    expect(puts).toEqual([{ required: true }, { required: null }]);
  });

  it("says what went wrong when the server refuses, and keeps the last policy", async () => {
    const server = new FakeServer();
    const { store } = await signedIn(server);
    await store.refreshEncryption();
    server.policyStatus = 500;
    expect(await store.setEncryption(true)).toBe("Relo could not change that. Try again.");
    expect(store.getState().encryption).toEqual({ mode: "auto", required: false });
  });

  it("asks to sign in first without a credential", async () => {
    const store = new OwnerStore({ fetch: new FakeServer().fetch, secrets: memoryStore(), crypto: fakeCrypto(), device: info });
    await store.start();
    expect(await store.setEncryption(true)).toBe("Sign in first.");
  });

  it("forgets everything about it at sign-out", async () => {
    const { store } = await signedIn();
    await store.refreshEncryption();
    await store.signOut();
    expect(store.getState().encryption).toBeNull();
    expect(store.getState().phoneTrusted).toBe(false);
  });

  it("links to the Dashboard and its security page on the credential's server", async () => {
    const { store } = await signedIn();
    expect(store.dashboardUrl()).toBe(`${ORIGIN}/dashboard`);
    expect(store.securityUrl()).toBe(`${ORIGIN}/dashboard/account#security`);
  });
});

describe("a Now read a moment ago", () => {
  it("is drawn while connecting, replaced by the server's answer, and never over a live one", async () => {
    const server = new FakeServer();
    const secrets = memoryStore();
    const prefs = memoryStore();
    let n = 0;
    const make = (fetch: FakeServer["fetch"]) => new OwnerStore({
      fetch, secrets, prefs, crypto: fakeCrypto(), device: info, random: () => 0,
      randomUuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    });
    const first = make(server.fetch);
    await first.start();
    await first.setServerOrigin(ORIGIN);
    const url = new URL((await first.beginSignIn())!);
    server.codeChallenge = url.searchParams.get("code_challenge");
    await first.completeSignIn(`relo://auth/callback?code=${CODE}&state=${url.searchParams.get("state")}`);
    await settle();
    expect(first.seedCached(nowSummary())).toBe(false); // live: nothing is replaced
    first.stop();

    // The next launch: the credential is stored, the server has not answered yet.
    const second = make((input, init) => (new URL(input).pathname === "/api/now" ? new Promise<Response>(() => {}) : server.fetch(input, init)));
    await second.start();
    expect(second.getState().connection).toBe("connecting");
    expect(second.seedCached(nowSummary())).toBe(true);
    expect(second.getState().summary).not.toBeNull();
    expect(second.getState().showingCached).toBe(true);
    expect(second.seedCached(nowSummary())).toBe(false); // already has one
    second.stop();

    // The server answers: the cached Now goes.
    const third = make(server.fetch);
    await third.start();
    third.seedCached(nowSummary());
    await settle();
    expect(third.getState().showingCached).toBe(false);
    third.stop();
  });

  it("is not drawn without a stored credential", async () => {
    const store = new OwnerStore({ fetch: new FakeServer().fetch, secrets: memoryStore(), crypto: fakeCrypto(), device: info });
    await store.start();
    expect(store.seedCached(nowSummary())).toBe(false);
  });
});

describe("what a failure says", () => {
  it("is the Mac's words with PC when the server signs this PC out", async () => {
    const server = new FakeServer();
    const { store } = await signedIn(server);
    server.deviceRevoked = true;
    store.refreshNow();
    await settle();
    expect(store.getState().connection).toBe("needsSignIn");
    expect(store.getState().problem).toBe("The server signed this PC out. Sign in again.");
  });

  it("forgets the chosen server on request", async () => {
    const store = new OwnerStore({ fetch: new FakeServer().fetch, secrets: memoryStore(), prefs: memoryStore(), crypto: fakeCrypto(), device: info });
    await store.start();
    await store.setServerOrigin(ORIGIN);
    expect(store.getState().serverOrigin).toBe(ORIGIN);
    await store.forgetServerOrigin();
    expect(store.getState().serverOrigin).toBeNull();
  });
});
