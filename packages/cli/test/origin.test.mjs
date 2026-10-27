import "./hermetic-env.mjs";
// Plan 10 M7.5: the CLI's copy of the origin rule answers like the server's (the cases are the contracts test's).
import assert from "node:assert/strict";
import test from "node:test";
import { isPublicOrigin } from "../src/shared/origin.generated.mjs";
import { validatePublicHttpsUrl } from "../src/shared/urls.mjs";

const CASES = [
  ["https://relo.example.com", true], ["https://8.8.8.8", true], ["https://[2606:4700::1]", true],
  ["http://localhost:8180", false], ["http://relo.localhost", false], ["http://mac.local", false], ["http://nas.internal", false],
  ["http://127.0.0.1", false], ["http://10.0.0.5", false], ["http://172.20.1.1", false], ["http://192.168.1.9", false],
  ["http://169.254.1.1", false], ["http://100.101.102.103", false], ["http://192.0.2.10", false], ["http://203.0.113.4", false],
  ["http://[::1]", false], ["http://[fd00::1]", false], ["http://[fe80::1]", false], ["http://[2001:db8::1]", false],
  ["http://0.0.0.0", false], ["https://172.32.0.1", true], ["https://100.128.0.1", true], ["not a url", false],
];

test("the CLI's origin rule is the server's", () => {
  for (const [url, expected] of CASES) assert.equal(isPublicOrigin(url), expected, url);
});

test("public-only URLs refuse every private host", () => {
  assert.equal(validatePublicHttpsUrl("https://images.example.com/a.png", "image"), "https://images.example.com/a.png");
  for (const host of ["mac.local", "100.101.102.103", "[fd00::1]"]) assert.throws(() => validatePublicHttpsUrl(`https://${host}/a.png`, "image"), /public HTTPS URL/u);
});

test("strict mode defaults on for a public server and off on a private network; the owner's choice wins", async () => {
  const { strictFor, strictSource } = await import("../src/crypto/trust.mjs");
  assert.equal(strictFor({}, "https://relo.example.com"), true);
  assert.equal(strictFor({}, "http://relo.local:8180"), false);
  assert.equal(strictFor({}, "http://100.101.102.103:8180"), false);
  assert.equal(strictFor({ strict: false }, "https://relo.example.com"), false);
  assert.equal(strictFor({ strict: true }, "http://relo.local:8180"), true);
  assert.equal(strictSource({}), "address");
  assert.equal(strictSource({ strict: false }), "set");
});

test("a loopback server that is not local (an SSH tunnel) is unknown: strict by default, like a public one", async () => {
  const { strictFor, strictNoticeText } = await import("../src/crypto/trust.mjs");
  for (const url of ["http://127.0.0.1:8187", "http://localhost:8187", "http://[::1]:8187"]) assert.equal(strictFor({}, url), true, url);
  assert.equal(strictFor({ strict: false }, "http://127.0.0.1:8187"), false, "the owner's choice still wins");
  assert.match(strictNoticeText("http://127.0.0.1:8187"), /loopback address that is not this Mac's own Relo/u);
});
