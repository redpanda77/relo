import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyAnswer } from "../src/answer-verify.mjs";
import { answerSigningInput, b64u, generateKeyPair, keyId, signBytes } from "../src/e2ee.mjs";
import { ensureIdentity, saveKeyStore, trustKey } from "../src/keystore.mjs";

const apiUrl = "https://relo.example";
const deviceId = "dev_00000000-0000-4000-8000-00000000000a";

function signed(phone, { state = "approved", value = "approve", response = {}, signer = phone } = {}) {
  const signedAt = "2026-10-13T17:00:00.000Z";
  const interaction = { id: "int_1", eventId: "ntf_1", state, respondingDevice: { id: deviceId, name: "iPhone" } };
  const signature = signBytes(signer.privateKey, answerSigningInput({ interactionId: "int_1", notificationId: "ntf_1", deviceId, value, respondedAt: signedAt }));
  return { interaction: { ...interaction, response: { ...response, e2eeKeyId: keyId(signer.publicKey), e2eeSignedAt: signedAt, e2eeSignature: b64u(signature) } } };
}

async function setup(trust) {
  const folder = mkdtempSync(join(tmpdir(), "relo-answer-"));
  const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json") };
  const phone = generateKeyPair();
  if (trust) {
    const { store } = await ensureIdentity(env.RELO_KEY_STORE_PATH);
    store.trusted[trustKey(apiUrl, deviceId)] = { publicKey: b64u(phone.publicKey) };
    await saveKeyStore(env.RELO_KEY_STORE_PATH, store);
  }
  return { phone, dependencies: { configPath: () => join(folder, "config.json"), env }, client: { apiUrl },
    cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

const refused = (promise) => assert.rejects(promise, (error) => error.exitCode === 4 && error.details.state === "unverified");

test("without verified phones the answer passes through unchanged", async () => {
  const { phone, dependencies, client, cleanup } = await setup(false);
  try {
    const payload = { interaction: { id: "int_1", state: "approved" } };
    assert.equal(await verifyAnswer(payload, client, dependencies), payload);
    assert.ok(signed(phone));
  } finally { cleanup(); }
});

test("a trusted phone's signed approval, yes and reply are accepted", async () => {
  const { phone, dependencies, client, cleanup } = await setup(true);
  try {
    assert.equal((await verifyAnswer(signed(phone), client, dependencies)).verified, true);
    assert.equal((await verifyAnswer(signed(phone, { state: "yes", value: "yes" }), client, dependencies)).verified, true);
    const text = "Ship it";
    const reply = signed(phone, { state: "replied", value: `answer:${createHash("sha256").update(text).digest("hex")}`, response: { response: text } });
    assert.equal((await verifyAnswer(reply, client, dependencies)).verified, true);
  } finally { cleanup(); }
});

test("a forged, unsigned, re-targeted or foreign-phone approval is refused", async () => {
  const { phone, dependencies, client, cleanup } = await setup(true);
  try {
    const unsigned = { interaction: { id: "int_1", eventId: "ntf_1", state: "approved", respondingDevice: { id: deviceId }, response: { action: "approve" } } };
    await refused(verifyAnswer(unsigned, client, dependencies));
    await refused(verifyAnswer(signed(phone, { signer: generateKeyPair() }), client, dependencies));
    // The phone said "deny"; the server reports "approved".
    await refused(verifyAnswer(signed(phone, { value: "deny" }), client, dependencies));
    // A signature for another question replayed onto this one.
    const replayed = signed(phone);
    replayed.interaction.id = "int_2";
    await refused(verifyAnswer(replayed, client, dependencies));
    const otherPhone = signed(phone);
    otherPhone.interaction.respondingDevice.id = "dev_00000000-0000-4000-8000-00000000000b";
    await refused(verifyAnswer(otherPhone, client, dependencies));
    const editedReply = signed(phone, { state: "replied", value: `answer:${createHash("sha256").update("No").digest("hex")}`, response: { response: "Yes, deploy" } });
    await refused(verifyAnswer(editedReply, client, dependencies));
    // Negative answers never need a signature: refusing to act is always safe.
    const denied = { interaction: { id: "int_1", state: "denied" } };
    assert.equal(await verifyAnswer(denied, client, dependencies), denied);
  } finally { cleanup(); }
});
