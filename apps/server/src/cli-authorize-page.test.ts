import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cliAuthorizationScript } from "./device-authorization.js";

const vectors = JSON.parse(readFileSync(new URL("../../../packages/contracts/fixtures/signin-number-v1.json", import.meta.url), "utf8")) as
  { userCode: string; identityKey: string; number: string }[];

// The page's own helpers, lifted out of the served script so the page and the fixture cannot drift.
function helpers() {
  const pick = (name: string) => {
    const match = new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`).exec(cliAuthorizationScript);
    if (!match) throw new Error(`${name} is not in the page script`);
    return match[0];
  };
  return new Function("crypto", "TextEncoder", `${pick("signinNumber")}\n${pick("numberChoices")}\nreturn { signinNumber, numberChoices };`)(
    globalThis.crypto, TextEncoder,
  ) as { signinNumber(code: string, key: string): Promise<string>; numberChoices(real: string): string[] };
}

describe("the CLI authorization page's sign-in number", () => {
  it("is valid JavaScript", () => {
    expect(() => new Function(cliAuthorizationScript)).not.toThrow();
  });

  it("matches the shared vectors", async () => {
    const { signinNumber } = helpers();
    for (const vector of vectors) expect(await signinNumber(vector.userCode, vector.identityKey)).toBe(vector.number);
  });

  it("offers the real number and two distinct decoys", () => {
    const { numberChoices } = helpers();
    for (const real of ["00", "07", "46", "99"]) {
      for (let i = 0; i < 100; i += 1) {
        const choices = numberChoices(real);
        expect(choices).toHaveLength(3);
        expect(new Set(choices).size).toBe(3);
        expect(choices).toContain(real);
        expect(choices.every((value) => /^\d\d$/.test(value))).toBe(true);
      }
    }
  });
});
