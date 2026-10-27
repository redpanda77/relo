import { describe, expect, it } from "vitest";
import { OwnerClientError } from "./errors.js";
import { OwnerHttp, normalizeOrigin } from "./http.js";
import { challengeFor, createPkce } from "./pkce.js";
import { buildAuthorizationUrl, exchangeCode, parseCallback } from "./signIn.js";
import { FakeServer, ORIGIN } from "./test-support/fakeServer.js";

const CODE = "relo_signin_" + "A".repeat(43);

describe("pkce", () => {
  it("makes an S256 challenge the server accepts (RFC 7636 vector)", async () => {
    expect(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const pkce = await createPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.state).toMatch(/^[A-Za-z0-9_-]{16,200}$/);
  });
});

describe("authorization URL", () => {
  it("names the device only when asked", async () => {
    const pkce = await createPkce();
    expect(new URL(buildAuthorizationUrl(ORIGIN, pkce, { device: "windows" })).searchParams.get("device")).toBe("windows");
  });

  it("carries challenge, S256, redirect and state, and no device parameter by default", async () => {
    const pkce = await createPkce();
    const url = new URL(buildAuthorizationUrl(ORIGIN, pkce));
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/mobile/sign-in`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      code_challenge: pkce.challenge, code_challenge_method: "S256", redirect_uri: "relo://auth/callback", state: pkce.state,
    });
  });

  it("normalizes a typed address", () => {
    expect(normalizeOrigin("relo.example.com/dashboard")).toBe("https://relo.example.com");
    expect(normalizeOrigin("http://192.168.1.5:8180")).toBe("http://192.168.1.5:8180");
    expect(normalizeOrigin("ftp://x")).toBeNull();
    expect(normalizeOrigin("https://user:pw@x.com")).toBeNull();
    expect(normalizeOrigin("  ")).toBeNull();
  });
});

describe("callback", () => {
  it("returns the code for the matching state", () => {
    expect(parseCallback(`relo://auth/callback?code=${CODE}&state=abc`, "abc")).toEqual({ type: "code", code: CODE });
  });

  it("rejects a state mismatch, even for a denial", () => {
    expect(() => parseCallback(`relo://auth/callback?code=${CODE}&state=evil`, "abc")).toThrow(expect.objectContaining({ kind: "state_mismatch" }));
    expect(() => parseCallback("relo://auth/callback?error=access_denied&state=evil", "abc")).toThrow(expect.objectContaining({ kind: "state_mismatch" }));
    expect(() => parseCallback(`relo://auth/callback?code=${CODE}`, "abc")).toThrow(OwnerClientError);
  });

  it("treats a denial as cancelled and rejects malformed callbacks", () => {
    expect(parseCallback("relo://auth/callback?error=access_denied&state=abc", "abc")).toEqual({ type: "cancelled" });
    for (const bad of ["https://auth/callback?state=abc", "relo://other/callback?state=abc", "relo://auth/other?state=abc",
      "relo://auth/callback?error=server_error&state=abc", "relo://auth/callback?code=nope&state=abc", "not a url"]) {
      expect(() => parseCallback(bad, "abc"), bad).toThrow(expect.objectContaining({ kind: expect.stringMatching(/callback_malformed/) }));
    }
  });
});

describe("code exchange", () => {
  it("redeems a code with its verifier", async () => {
    const server = new FakeServer();
    const pkce = await createPkce();
    server.codeChallenge = pkce.challenge;
    const session = await exchangeCode(new OwnerHttp(ORIGIN, server.fetch), { code: CODE, verifier: pkce.verifier, installationId: "inst-12345678" });
    expect(session.sessionToken).toBe(server.session);
    expect(server.seen[0]).toMatchObject({ method: "POST", path: "/api/mobile/sign-in/token", body: { code: CODE, codeVerifier: pkce.verifier, installationId: "inst-12345678" } });
    expect(server.seen[0]!.headers.Authorization).toBeUndefined();
  });

  it("maps a wrong verifier to invalid_grant", async () => {
    const server = new FakeServer();
    server.codeChallenge = (await createPkce()).challenge;
    const other = await createPkce();
    await expect(exchangeCode(new OwnerHttp(ORIGIN, server.fetch), { code: CODE, verifier: other.verifier, installationId: "inst-12345678" }))
      .rejects.toMatchObject({ kind: "invalid_grant" });
  });
});
