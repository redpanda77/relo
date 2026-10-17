import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { answerProblem, rememberQuestion, verifyAnswer } from "../src/crypto/answer-verify.mjs";
import { answerSigningInput, b64u, generateKeyPair, keyId, linkSigningInput, questionAnswerSigningInput, signBytes } from "../src/crypto/e2ee.mjs";
import { ensureIdentity, saveKeyStore, trustKey } from "../src/crypto/keystore.mjs";

// docs/ENCRYPTION-PROTOCOL.md, "Answering from a linked browser": a browser's signed answer counts
// outside strict mode only, while a phone this computer trusts has signed its link (14 days or less).
// A private server: strict mode is off unless a test turns it on (on a public address it defaults on).
const apiUrl = "https://relo.internal";
const phoneId = "dev_00000000-0000-4000-8000-00000000000a";
const strangerId = "dev_00000000-0000-4000-8000-0000000000bb";
const browserId = "brw_00000000-0000-4000-8000-0000000000cc";
const interactionId = "int_00000000-0000-4000-8000-000000000001";
const askedAt = "2026-10-13T17:00:00.000Z";
const signedAt = "2026-10-13T17:01:00.000Z";
const nowMs = Date.parse("2026-10-13T17:02:00.000Z");

const phone = generateKeyPair();
const stranger = generateKeyPair();
const browserKeys = generateKeyPair();

/** The browser as `GET /api/devices/keys` lists it, linked by `linker` at `linkedAt`. */
function listed({ linker = phone, linkerId = phoneId, linkedAt = "2026-10-10T09:00:00.000Z", identity = browserKeys } = {}) {
  return { deviceId: browserId, kind: "browser", name: "Chrome on macOS",
    identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey) },
    link: { deviceId: linkerId, signedAt: linkedAt, signature: b64u(signBytes(linker.privateKey, linkSigningInput({ browserId,
      identityKey: b64u(identity.publicKey), phoneDeviceId: linkerId, signedAt: linkedAt }))) } };
}

/** An answer as the Dashboard sends it: the phone's input with the browser's id, bound to the question it opened. */
function answered({ id = interactionId, state = "approved", value = "approve", question = "ntf:question-1", signer = browserKeys,
  at = signedAt, response = {} } = {}) {
  const fields = { interactionId: id, notificationId: "ntf_1", deviceId: browserId, value, respondedAt: at };
  return { interaction: { id, eventId: "ntf_1", state, respondingDevice: { id: browserId, name: "Chrome on macOS" },
    response: { ...response, e2eeKeyId: keyId(signer.publicKey), e2eeSignedAt: at,
      e2eeSignature: b64u(signBytes(signer.privateKey, answerSigningInput(fields))),
      ...(question ? { e2eeQuestion: question,
        e2eeQuestionSignature: b64u(signBytes(signer.privateKey, questionAnswerSigningInput({ ...fields, question }))) } : {}) } } };
}

const store = (strict = false) => ({ identity: {}, strict, trusted: {
  [trustKey(apiUrl, phoneId)]: { deviceId: phoneId, publicKey: b64u(phone.publicKey), level: "auto" },
  [trustKey(apiUrl, strangerId)]: { deviceId: strangerId, publicKey: b64u(stranger.publicKey), level: "pending" },
} });
const problem = (payload, { strict = false, devices = [listed()], expected = { interactionId } } = {}) =>
  answerProblem(payload.interaction, store(strict), apiUrl, expected, nowMs, { devices });

test("the browser's signed approval, yes and choice count while a trusted phone's link holds", () => {
  assert.equal(problem(answered({ question: null })), null);
  assert.equal(problem(answered(), { expected: { interactionId, questionContext: "ntf:question-1", askedAt } }), null);
  assert.equal(problem(answered({ state: "yes", value: "yes", question: null })), null);
  assert.equal(problem(answered({ state: "replied", value: "choose:ship", question: null, response: { optionId: "ship", label: "Ship" } })), null);
});

test("strict mode refuses a browser's answer, however well signed", () => {
  assert.match(problem(answered({ question: null }), { strict: true }), /strict mode does not accept/u);
});

test("no current link, a lapsed link, a link by a phone this computer does not trust: not an answer", () => {
  assert.equal(problem(answered({ question: null }), { devices: [] }), "answered in a browser that is no longer linked");
  assert.equal(problem(answered({ question: null }), { devices: [{ ...listed(), link: null }] }),
    "answered in a browser without a current link from a phone this computer trusts (links last 14 days)");
  // Signed 15 days ago: the phone stopped re-signing it (unlinked), so it no longer counts.
  assert.match(problem(answered({ question: null }), { devices: [listed({ linkedAt: "2026-09-28T17:00:00.000Z" })] }), /links last 14 days/u);
  // Linked by a pending phone, or the link forged by the server over another key.
  assert.match(problem(answered({ question: null }), { devices: [listed({ linker: stranger, linkerId: strangerId })] }), /links last 14 days/u);
  assert.match(problem(answered({ question: null }), { devices: [{ ...listed(), link: { ...listed().link, signature: b64u(Buffer.alloc(64, 1)) } }] }),
    /links last 14 days/u);
  // The server swaps the browser's key for its own: the phone never signed that key.
  const forger = generateKeyPair();
  assert.match(problem(answered({ question: null, signer: forger }), { devices: [{ ...listed(), identityKey: listed({ identity: forger }).identityKey }] }),
    /links last 14 days/u);
});

test("the browser's answer is bound like a phone's: this question, after it was asked, by the browser's own key", () => {
  const expected = { interactionId, questionContext: "ntf:question-1", askedAt };
  assert.equal(problem(answered({ id: "int_00000000-0000-4000-8000-0000000000ff" }), { expected }), "the answer is for another question");
  assert.equal(problem(answered({ question: "ntf:benign" }), { expected }), "the browser answered a different question");
  assert.equal(problem(answered({ question: null }), { expected }), "the browser answered a different question");
  assert.equal(problem(answered({ at: "2026-10-12T09:00:00.000Z" }), { expected }), "the answer was not signed for this question");
  assert.equal(problem(answered({ signer: generateKeyPair() }), { expected }), "signed by a different key");
  assert.equal(problem(answered({ value: "deny" }), { expected }), "the signature does not match");
});

test("an answer signed for another phone's copy of the question does not count for the copy this computer waits on", () => {
  // A card question has one copy per phone; the server makes the browser answer the copy this CLI
  // follows. Relaying a sibling copy's signature under this copy's id is still refused.
  const sibling = answered({ id: "int_00000000-0000-4000-8000-0000000000ee", question: null });
  const relabeled = { interaction: { ...sibling.interaction, id: interactionId } };
  assert.equal(problem(relabeled), "the signature does not match");
  assert.equal(problem(sibling), "the answer is for another question");
});

async function setup() {
  const folder = mkdtempSync(join(tmpdir(), "relo-browser-answer-"));
  const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_STATE_DIR: join(folder, "state") };
  const { store: created } = await ensureIdentity(env.RELO_KEY_STORE_PATH);
  created.trusted = store().trusted;
  await saveKeyStore(env.RELO_KEY_STORE_PATH, created);
  const strict = async () => saveKeyStore(env.RELO_KEY_STORE_PATH, { ...created, strict: true });
  let listings = 0;
  const client = (devices) => ({ apiUrl, listDeviceKeys: async () => { listings += 1; return { devices }; } });
  return { env, strict, client, listings: () => listings, dependencies: { configPath: () => join(folder, "config.json"), env, now: () => nowMs },
    cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

const refused = (promise, reason) => assert.rejects(promise,
  (error) => error.exitCode === 8 && error.details.state === "unverified" && reason.test(error.details.reason));

test("relo ask acts on a browser's approval only with the link checked now, and says it came from the browser", async () => {
  const h = await setup();
  try {
    await rememberQuestion({ env: h.env }, { interactionId, questionContext: "ntf:question-1", askedAt });
    const accepted = await verifyAnswer(answered(), h.client([listed()]), h.dependencies, { interactionId });
    assert.equal(accepted.verified, true);
    assert.deepEqual(accepted.answeredIn, { browser: browserId, name: "Chrome on macOS" });
    assert.equal(h.listings(), 1);
    // Unlinked meanwhile (the server stopped listing it): silence, never consent. Exit 8, state unverified.
    await refused(verifyAnswer(answered({ question: null }), h.client([]), h.dependencies, { interactionId }), /no longer linked/u);
    // A listing that fails reads as no link.
    await refused(verifyAnswer(answered({ question: null }), { apiUrl, listDeviceKeys: async () => { throw new Error("offline"); } },
      h.dependencies, { interactionId }), /no longer linked/u);
    // Negative answers need no signature and stay negative.
    const denied = { interaction: { id: interactionId, state: "denied", respondingDevice: { id: browserId } } };
    assert.equal(await verifyAnswer(denied, h.client([]), h.dependencies, { interactionId }), denied);
    // Strict mode: refused without even asking the server.
    await h.strict();
    const before = h.listings();
    await refused(verifyAnswer(answered({ question: null }), h.client([listed()]), h.dependencies, { interactionId }), /strict mode/u);
    assert.equal(h.listings(), before);
  } finally { h.cleanup(); }
});
