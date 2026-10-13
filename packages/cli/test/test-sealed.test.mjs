import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { b64u, generateKeyPair, keyId, prekeySigningInput, signBytes } from "../src/e2ee.mjs";
import { cardDependencies, fakeCards } from "./fake-cards.mjs";

const PHONE = "dev_00000000-0000-4000-8000-00000000000a";

function phoneKeys(deviceId) {
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  const createdAt = "2026-10-13T16:00:00.000Z";
  return { deviceId, name: "iPhone",
    identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
    prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, stale: false,
      signature: b64u(signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }))) } };
}

// An account that requires end-to-end encryption refuses readable card and question text, so the
// phone test must seal both like any other card; otherwise `relo doctor` could never reach ready.
test("relo test seals its card and question when the account's phone has keys", async () => {
  const folder = mkdtempSync(join(tmpdir(), "relo-test-sealed-"));
  const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_SEALED_CARD_DIR: join(folder, "cards") };
  const fake = fakeCards({ answer: "yes" });
  fake.client.listDevices = async () => ({ hasMore: false, cursor: null, devices: [{ deviceId: PHONE, liveActivityAuthorization: "authorized" }] });
  fake.client.listDeviceKeys = async () => ({ devices: [phoneKeys(PHONE)] });
  fake.client.publishClientKey = async () => ({});
  const deps = cardDependencies(fake.client, { env });
  try {
    await run(["test"], { stdout: () => {}, stderr: () => {} }, deps);
    const start = fake.calls.find((call) => call.op === "start");
    const ask = fake.calls.find((call) => call.op === "ask");
    assert.ok(start?.body?.sealed, "the test card is sealed");
    assert.ok(!JSON.stringify(start.body).includes("Tap Yes"), "no readable card text reaches the server");
    assert.ok(ask?.body?.sealed, "the test question is sealed");
    assert.equal(ask.body.prompt, undefined, "no readable question reaches the server");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
