import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { answerProblem, rememberQuestion, verifyAnswer } from "../src/crypto/answer-verify.mjs";
import { answerSigningInput, b64u, generateKeyPair, keyId, linkSigningInput, questionAnswerSigningInput, signBytes } from "../src/crypto/e2ee.mjs";
import { ensureIdentity, saveKeyStore, trustKey } from "../src/crypto/keystore.mjs";

// docs/ENCRYPTION-PROTOCOL.md, "Answers on another copy": a question folded onto a card has one copy
// per phone, and a long one continues as a notification. This computer follows one copy; another
// phone answers its own copy (or the card's Lock Screen buttons answer a long question). The server
// names that copy (`answeredCopy`); the answer counts only bound to the context this computer sealed.
const apiUrl = "https://relo.example";
const firstPhoneId = "dev_00000000-0000-4000-8000-00000000000a";
const secondPhoneId = "dev_00000000-0000-4000-8000-00000000000b";
const pendingPhoneId = "dev_00000000-0000-4000-8000-00000000000c";
const browserId = "brw_00000000-0000-4000-8000-0000000000cc";
const waited = { id: "int_00000000-0000-4000-8000-000000000001", eventId: "ntf_00000000-0000-4000-8000-000000000001" };
const otherCopy = { id: "int_00000000-0000-4000-8000-000000000002", eventId: "ntf_00000000-0000-4000-8000-000000000002" };
const context = "ntf:2f0c1e9a4b7d3c5e8f1a2b3c4d5e6f70";
const askedAt = "2026-10-13T17:00:00.000Z";
const signedAt = "2026-10-13T17:01:00.000Z";
const nowMs = Date.parse("2026-10-13T17:02:00.000Z");

const firstPhone = generateKeyPair();
const secondPhone = generateKeyPair();
const pendingPhone = generateKeyPair();

const trusted = {
  [trustKey(apiUrl, firstPhoneId)]: { deviceId: firstPhoneId, publicKey: b64u(firstPhone.publicKey), level: "auto" },
  [trustKey(apiUrl, secondPhoneId)]: { deviceId: secondPhoneId, publicKey: b64u(secondPhone.publicKey), level: "auto" },
  [trustKey(apiUrl, pendingPhoneId)]: { deviceId: pendingPhoneId, publicKey: b64u(pendingPhone.publicKey), level: "pending" },
};

/**
 * The copy this computer waits on, as the server returns it once `answeredBy` answered `copy` (its own
 * copy, signed over that copy's ids and the context of the envelope it opened). `shown` overrides the
 * ids the server names as the answered copy.
 */
function settled({ copy = otherCopy, shown = copy, answeredBy = secondPhoneId, signer = secondPhone, question = context,
  state = "approved", value = "approve", at = signedAt } = {}) {
  const fields = { interactionId: copy.id, notificationId: copy.eventId, deviceId: answeredBy, value, respondedAt: at };
  return { interaction: { id: waited.id, eventId: waited.eventId, state, respondingDevice: { id: answeredBy, name: "iPhone" },
    answeredCopy: shown,
    response: { e2eeKeyId: keyId(signer.publicKey), e2eeSignedAt: at,
      e2eeSignature: b64u(signBytes(signer.privateKey, answerSigningInput(fields))),
      ...(question ? { e2eeQuestion: question,
        e2eeQuestionSignature: b64u(signBytes(signer.privateKey, questionAnswerSigningInput({ ...fields, question }))) } : {}) } } };
}

const sealedQuestion = { interactionId: waited.id, questionContext: context, askedAt };
// A browser the first phone linked three days ago: its own answers count (outside strict mode), on the waited copy.
const browserKeys = generateKeyPair();
const linkedAt = "2026-10-10T09:00:00.000Z";
const linkedBrowser = { deviceId: browserId, kind: "browser", name: "Chrome on macOS",
  identityKey: { keyId: keyId(browserKeys.publicKey), publicKey: b64u(browserKeys.publicKey) },
  link: { deviceId: firstPhoneId, signedAt: linkedAt, signature: b64u(signBytes(firstPhone.privateKey, linkSigningInput({ browserId,
    identityKey: b64u(browserKeys.publicKey), phoneDeviceId: firstPhoneId, signedAt: linkedAt }))) } };
const problem = (payload, { strict = false, expected = sealedQuestion } = {}) =>
  answerProblem(payload.interaction, { identity: {}, strict, trusted }, apiUrl, expected, nowMs, { devices: [linkedBrowser] });

test("a second phone's signed answer on its own copy counts for the copy this computer waits on", () => {
  assert.equal(problem(settled()), null);
  assert.equal(problem(settled({ state: "yes", value: "yes" })), null);
  // Strict mode concerns linked browsers only: a trusted phone's answer on its copy still counts.
  assert.equal(problem(settled(), { strict: true }), null);
});

test("the Lock Screen buttons answering a long question (the card's copy) count for the notification it continues as", () => {
  // This computer waits on the long question's notification; the phone answered the card's copy.
  const cardCopy = { id: "int_00000000-0000-4000-8000-0000000000aa", eventId: "ntf_00000000-0000-4000-8000-0000000000aa" };
  assert.equal(problem(settled({ copy: cardCopy, answeredBy: firstPhoneId, signer: firstPhone })), null);
});

test("an answer named as another copy but given to a different question is refused", () => {
  // A copy of a different question: the phone bound its answer to that question's context.
  assert.equal(problem(settled({ question: "ntf:another-question-context-000000" })), "the phone approved a different question");
  // Unbound (no envelope opened): never enough for a sealed question.
  assert.equal(problem(settled({ question: null })), "the phone approved a different question");
  // The server names other ids than the phone signed.
  assert.equal(problem(settled({ shown: { id: "int_00000000-0000-4000-8000-0000000000ef", eventId: otherCopy.eventId } })),
    "the signature does not match");
  // An old approval replayed as a fresh copy's answer.
  assert.equal(problem(settled({ at: "2026-10-12T09:00:00.000Z" })), "the answer was not signed for this question");
  // Signed with another key than the trusted phone's, or by a phone this computer does not trust.
  assert.equal(problem(settled({ signer: generateKeyPair() })), "signed by a different key");
  assert.equal(problem(settled({ answeredBy: pendingPhoneId, signer: pendingPhone })), "answered on a phone this computer does not trust");
  // A negative answer relabeled as a yes.
  assert.equal(problem(settled({ value: "deny" })), "the signature does not match");
  assert.equal(problem(settled({ shown: { id: "not-an-id", eventId: otherCopy.eventId } })), "the answered copy is malformed");
});

test("another copy counts only for a question this computer sealed; a browser always answers the waited copy", () => {
  // Not sealed, or asked elsewhere: nothing this computer chose binds the copy, so the server's word does not count.
  assert.match(problem(settled({ question: null }), { expected: { interactionId: waited.id } }), /only for a question this computer sealed/u);
  assert.match(problem(settled(), { expected: { interactionId: waited.id } }), /only for a question this computer sealed/u);
  assert.equal(problem(settled({ answeredBy: browserId, signer: browserKeys })), "the browser answered another copy of the question");
  assert.equal(problem(settled({ copy: waited, answeredBy: browserId, signer: browserKeys })), null);
  // The answered copy is the waited copy itself: the ordinary rule.
  assert.equal(problem(settled({ copy: waited })), null);
});

test("relo ask accepts the second phone's answer, remembered across a resume, and exits 8 on a forged sibling", async () => {
  const folder = mkdtempSync(join(tmpdir(), "relo-answered-copy-"));
  try {
    const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_STATE_DIR: join(folder, "state") };
    const { store } = await ensureIdentity(env.RELO_KEY_STORE_PATH);
    store.trusted = trusted;
    await saveKeyStore(env.RELO_KEY_STORE_PATH, store);
    const dependencies = { configPath: () => join(folder, "config.json"), env, now: () => nowMs };
    const client = { apiUrl, listDeviceKeys: async () => ({ devices: [] }) };
    await rememberQuestion({ env }, sealedQuestion);
    await assert.rejects(verifyAnswer(settled({ question: "ntf:another-question-context-000000" }), client, dependencies,
      { interactionId: waited.id }),
    (error) => error.exitCode === 8 && error.details.state === "unverified" && /different question/u.test(error.details.reason));
    const accepted = await verifyAnswer(settled(), client, dependencies, { interactionId: waited.id });
    assert.equal(accepted.verified, true);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
