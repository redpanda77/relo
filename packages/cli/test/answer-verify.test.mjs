import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rememberQuestion, verifyAnswer } from "../src/answer-verify.mjs";
import { answerSigningInput, b64u, generateKeyPair, keyId, questionAnswerSigningInput, signBytes } from "../src/e2ee.mjs";
import { ensureIdentity, saveKeyStore, trustKey } from "../src/keystore.mjs";

const apiUrl = "https://relo.example";
const deviceId = "dev_00000000-0000-4000-8000-00000000000a";
const interactionId = "int_00000000-0000-4000-8000-000000000001";
const askedAt = "2026-10-13T17:00:00.000Z";
const signedAt = "2026-10-13T17:01:00.000Z";
const now = () => Date.parse("2026-10-13T17:02:00.000Z");

/** An answer as the phone sends it: the legacy signature plus one bound to the question's context. */
function signed(phone, { id = interactionId, state = "approved", value = "approve", question = "ntf:question-1",
  response = {}, signer = phone, at = signedAt } = {}) {
  const fields = { interactionId: id, notificationId: "ntf_1", deviceId, value, respondedAt: at };
  return { interaction: { id, eventId: "ntf_1", state, respondingDevice: { id: deviceId, name: "iPhone" },
    response: { ...response, e2eeKeyId: keyId(signer.publicKey), e2eeSignedAt: at,
      e2eeSignature: b64u(signBytes(signer.privateKey, answerSigningInput(fields))),
      ...(question ? { e2eeQuestion: question,
        e2eeQuestionSignature: b64u(signBytes(signer.privateKey, questionAnswerSigningInput({ ...fields, question }))) } : {}) } } };
}

async function setup({ trust = true, level = "auto" } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "relo-answer-"));
  const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_SEALED_CARD_DIR: join(folder, "state", "cards") };
  const phone = generateKeyPair();
  if (trust) {
    const { store } = await ensureIdentity(env.RELO_KEY_STORE_PATH);
    store.trusted[trustKey(apiUrl, deviceId)] = { deviceId, publicKey: b64u(phone.publicKey), level };
    await saveKeyStore(env.RELO_KEY_STORE_PATH, store);
  }
  return { phone, env, dependencies: { configPath: () => join(folder, "config.json"), env, now }, client: { apiUrl },
    cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

const refused = (promise, reason) => assert.rejects(promise,
  (error) => error.exitCode === 8 && error.details.state === "unverified" && (!reason || error.details.reason === reason));

test("without a trusted phone the answer passes through unchanged", async () => {
  const { dependencies, client, cleanup } = await setup({ trust: false });
  try {
    const payload = { interaction: { id: interactionId, state: "approved" } };
    assert.equal(await verifyAnswer(payload, client, dependencies, { interactionId }), payload);
  } finally { cleanup(); }
});

test("an approval bound to the sealed question this CLI asked is accepted, also after a resume", async () => {
  const { phone, env, dependencies, client, cleanup } = await setup();
  try {
    await rememberQuestion(env, { interactionId, questionContext: "ntf:question-1", askedAt });
    const accepted = await verifyAnswer(signed(phone), client, dependencies, { interactionId });
    assert.equal(accepted.verified, true);
    // An unsealed question (the phone had no keys) is checked with the plain signature.
    const plain = await verifyAnswer(signed(phone, { question: null }), client, dependencies, { interactionId });
    assert.equal(plain.verified, true);
  } finally { cleanup(); }
});

test("the review's attacks are refused: replays, re-targeted approvals, stale and pending-phone answers", async () => {
  const { phone, env, dependencies, client, cleanup } = await setup();
  try {
    await rememberQuestion(env, { interactionId, questionContext: "ntf:question-1", askedAt });
    const expected = { interactionId };
    // H1: yesterday's signed approval for another interaction, returned for this wait.
    await refused(verifyAnswer(signed(phone, { id: "int_00000000-0000-4000-8000-0000000000ff" }), client, dependencies, expected),
      "the answer is for another question");
    // H4: the phone approved a different (benign) question's envelope.
    await refused(verifyAnswer(signed(phone, { question: "ntf:benign" }), client, dependencies, expected),
      "the phone approved a different question");
    // A signature from before this question existed.
    await refused(verifyAnswer(signed(phone, { at: "2026-10-12T09:00:00.000Z" }), client, dependencies, expected),
      "the answer was not signed for this question");
    // A sealed question answered without the binding signature.
    await refused(verifyAnswer(signed(phone, { question: null }), client, dependencies, expected),
      "the phone approved a different question");
    await refused(verifyAnswer(signed(phone, { signer: generateKeyPair() }), client, dependencies, expected), "signed by a different key");
    await refused(verifyAnswer(signed(phone, { value: "deny" }), client, dependencies, expected), "the signature does not match");
    const unsigned = { interaction: { id: interactionId, eventId: "ntf_1", state: "approved", respondingDevice: { id: deviceId } } };
    await refused(verifyAnswer(unsigned, client, dependencies, expected), "the answer is not signed");
    // L3: "completed" counts as a positive answer and needs a signature too.
    await refused(verifyAnswer({ interaction: { ...unsigned.interaction, state: "completed" } }, client, dependencies, expected));
    const text = "Ship it";
    const reply = signed(phone, { state: "replied", value: `answer:${createHash("sha256").update(text).digest("hex")}`,
      response: { response: "Edited by the server" } });
    await refused(verifyAnswer(reply, client, dependencies, expected), "the signature does not match");
    const denied = { interaction: { id: interactionId, state: "denied" } };
    assert.equal(await verifyAnswer(denied, client, dependencies, expected), denied, "refusing to act is always safe");
  } finally { cleanup(); }
});

test("H2: an answer from a pending (server-added) phone is refused, and verification never trusts on the way", async () => {
  const { phone, dependencies, client, cleanup } = await setup({ level: "pending" });
  try {
    await refused(verifyAnswer(signed(phone, { question: null }), client, dependencies, { interactionId }));
  } finally { cleanup(); }
});

test("a signed choice covers the option: the picked one passes, a swapped one is refused", async () => {
  const { phone, dependencies, client, cleanup } = await setup(true);
  try {
    const picked = signed(phone, { state: "replied", value: "choose:eu", response: { optionId: "eu", label: "EU" } });
    assert.equal((await verifyAnswer(picked, client, dependencies)).verified, true);
    const swapped = signed(phone, { state: "replied", value: "choose:eu", response: { optionId: "us", label: "US" } });
    await refused(verifyAnswer(swapped, client, dependencies));
  } finally { cleanup(); }
});
