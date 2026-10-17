import { CREDENTIAL_KINDS,FACTS,scopesFor } from "@relo/notification-contracts";
import { describe,expect,test } from "vitest";
import { CREDENTIAL_KIND_TABLE } from "./kinds.js";
import { generateToken,machineDigest,newWebhookSecret,plainDigest,secretPrefix,tokenPrefix,webhookDigest } from "./hash.js";

describe("credential kinds table (plan 10 M1.2)", () => {
  test("has exactly one entry for every credential kind", () => {
    expect(Object.keys(CREDENTIAL_KIND_TABLE).sort()).toEqual([...CREDENTIAL_KINDS].sort());
  });

  test("scopes come from the scope registry, and login and ci-token share them", () => {
    for (const kind of CREDENTIAL_KINDS) expect(CREDENTIAL_KIND_TABLE[kind].scopes).toEqual(scopesFor(kind));
    expect(CREDENTIAL_KIND_TABLE["ci-token"].scopes).toEqual(CREDENTIAL_KIND_TABLE.login.scopes);
  });

  test("only ci-token has a fixed lifetime, from the facts", () => {
    expect(CREDENTIAL_KIND_TABLE["ci-token"].lifetime).toEqual({ defaultDays: FACTS.credentials.ciTokenDefaultDays,maxDays: FACTS.credentials.ciTokenMaxDays });
    for (const kind of CREDENTIAL_KINDS.filter((kind) => kind !== "ci-token")) expect(CREDENTIAL_KIND_TABLE[kind].lifetime).toBeNull();
  });

  test("logins and phones are not rotated; the rest are", () => {
    expect(CREDENTIAL_KINDS.filter((kind) => !CREDENTIAL_KIND_TABLE[kind].rotation.rotatable).sort()).toEqual(["device","login"]);
  });

  test("the table matches the tokens hash.ts makes and the digests it names", () => {
    const machine = generateToken();
    expect(machine.startsWith(CREDENTIAL_KIND_TABLE.login.token.lead)).toBe(true);
    expect(machine.length).toBe(CREDENTIAL_KIND_TABLE.login.token.lead.length + CREDENTIAL_KIND_TABLE.login.token.randomChars);
    expect(tokenPrefix(machine).length).toBe(CREDENTIAL_KIND_TABLE.login.token.shownChars);
    const hook = newWebhookSecret();
    expect(hook.length).toBe(CREDENTIAL_KIND_TABLE.service.token.lead.length + CREDENTIAL_KIND_TABLE.service.token.randomChars);
    expect(secretPrefix(hook).length).toBe(CREDENTIAL_KIND_TABLE.service.token.shownChars);
    const digests = { plain: plainDigest,machine: machineDigest,webhook: webhookDigest };
    for (const kind of CREDENTIAL_KINDS) expect(Object.keys(digests)).toContain(CREDENTIAL_KIND_TABLE[kind].digest);
  });
});
