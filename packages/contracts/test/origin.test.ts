import assert from "node:assert/strict";
import test from "node:test";
import { isPrivateHost, isPublicOrigin } from "../src/origin.js";

/** The fixture table both sides run: keep it identical to packages/cli/test/origin.test.mjs. */
const ORIGIN_CASES: Array<[string, boolean]> = [
  ["https://relo.example.com", true], ["https://8.8.8.8", true], ["https://[2606:4700::1]", true],
  ["http://localhost:8180", false], ["http://relo.localhost", false], ["http://mac.local", false], ["http://nas.internal", false],
  ["http://127.0.0.1", false], ["http://10.0.0.5", false], ["http://172.20.1.1", false], ["http://192.168.1.9", false],
  ["http://169.254.1.1", false], ["http://100.101.102.103", false], ["http://192.0.2.10", false], ["http://203.0.113.4", false],
  ["http://[::1]", false], ["http://[fd00::1]", false], ["http://[fe80::1]", false], ["http://[2001:db8::1]", false],
  ["http://0.0.0.0", false], ["https://172.32.0.1", true], ["https://100.128.0.1", true], ["not a url", false],
];

test("one rule says which origins are public", () => {
  for (const [url, expected] of ORIGIN_CASES) assert.equal(isPublicOrigin(url), expected, url);
  assert.equal(isPrivateHost("LOCALHOST."), true);
});
