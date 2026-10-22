import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initKey, publicKey, signBytes, verifyBytes } from "./sparkle-key.mjs";

test("a generated key is a 32-byte seed file that signs and verifies, and is never overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "sparkle-key-"));
  const file = join(dir, "sparkle", "ed25519.key");
  const pub = initKey(file);
  assert.equal(Buffer.from(readFileSync(file, "utf8").trim(), "base64").length, 32);
  assert.equal(Buffer.from(pub, "base64").length, 32);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "sparkle")).mode & 0o777, 0o700);
  assert.equal(publicKey(file), pub);
  const bytes = Buffer.from("relo-mac.zip bytes");
  const signature = signBytes(file, bytes);
  assert.ok(verifyBytes(pub, bytes, signature));
  assert.ok(!verifyBytes(pub, Buffer.from("other"), signature));
  assert.throws(() => initKey(file), /not overwriting/u);
});
