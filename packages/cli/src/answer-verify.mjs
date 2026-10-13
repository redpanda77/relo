// Verifies a phone's signed answer before the CLI acts on it (docs/END-TO-END-ENCRYPTION.md, E4.2).
//
// Once this computer trusts a phone on a server, every positive answer from that server must carry a
// valid signature by a trusted phone's identity key. The signature must cover the interaction this
// CLI is waiting for and, for a sealed question, the context of the envelope this CLI sealed (a value
// the server cannot choose), and be made after the question was asked. Anything else (unsigned, an
// unknown or pending phone, another question's approval, a replay) is refused with exit 4: do not
// act. Verification never trusts a new key on the way.
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TerminalInteractionError } from "./errors.mjs";
import { answerSigningInput, fromB64u, keyId, questionAnswerSigningInput, verifyBytes } from "./e2ee.mjs";
import { keyStorePath, loadKeyStore, trustKey } from "./keystore.mjs";
import { isPhoneId } from "./trust.mjs";
import { sealedCardDirectory } from "./seal-card.mjs";

const SIGNED_ACTION = { approved: "approve", yes: "yes", replied: "answer", completed: "answer" };
const CLOCK_SKEW_MS = 5 * 60_000;
const QUESTION_ID = /^int_[0-9a-f-]{36}$/u;

function signedValue(state, response) {
  const action = SIGNED_ACTION[state];
  if (action !== "answer") return action;
  const text = typeof response?.response === "string" ? response.response : "";
  return `answer:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function questionsDirectory(env) {
  return join(sealedCardDirectory(env), "..", "questions");
}

/** Remembers what this CLI asked, so an answer can be checked against it even after a resume. */
export async function rememberQuestion(env, record) {
  if (!QUESTION_ID.test(record?.interactionId ?? "")) return;
  const directory = questionsDirectory(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${record.interactionId}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record));
  } finally {
    await handle.close();
  }
  await rename(temporary, join(directory, `${record.interactionId}.json`));
}

export async function recalledQuestion(env, interactionId) {
  if (!QUESTION_ID.test(interactionId ?? "")) return null;
  try {
    return JSON.parse(await readFile(join(questionsDirectory(env), `${interactionId}.json`), "utf8"));
  } catch {
    return null;
  }
}

export async function forgetQuestion(env, interactionId) {
  if (QUESTION_ID.test(interactionId ?? "")) await rm(join(questionsDirectory(env), `${interactionId}.json`), { force: true });
}

/** Why `interaction` is not a verified answer to `expected` from a trusted phone, or null when it is. */
export function answerProblem(interaction, store, apiUrl, expected = {}, now = Date.now()) {
  if (expected.interactionId && interaction?.id !== expected.interactionId) return "the answer is for another question";
  const deviceId = interaction?.respondingDevice?.id;
  if (!deviceId) return "no answering phone";
  const pinned = store.trusted[trustKey(apiUrl, deviceId)];
  // A linked browser reads; it never answers (its code comes from the server).
  if (!isPhoneId(deviceId) || pinned?.kind === "browser") return "answered on a device that is not a phone";
  if (!pinned || pinned.level === "pending") return "answered on a phone this computer does not trust";
  const response = interaction.response ?? {};
  const { e2eeKeyId, e2eeSignedAt, e2eeSignature, e2eeQuestion, e2eeQuestionSignature } = response;
  if (typeof e2eeSignature !== "string" || typeof e2eeSignedAt !== "string") return "the answer is not signed";
  const signedAt = Date.parse(e2eeSignedAt);
  if (!Number.isFinite(signedAt) || signedAt > now + CLOCK_SKEW_MS
    || (expected.askedAt && signedAt < Date.parse(expected.askedAt) - CLOCK_SKEW_MS)) return "the answer was not signed for this question";
  let publicKey;
  try {
    publicKey = fromB64u(pinned.publicKey, { length: 65 });
    if (keyId(publicKey) !== e2eeKeyId) return "signed by a different key";
    const value = signedValue(interaction.state, response);
    if (!value) return "not a signable answer";
    const fields = { interactionId: interaction.id, notificationId: interaction.eventId, deviceId, value, respondedAt: e2eeSignedAt };
    if (expected.questionContext) {
      // A sealed question: the phone must have signed the context of the envelope it opened.
      if (e2eeQuestion !== expected.questionContext || typeof e2eeQuestionSignature !== "string") {
        return "the phone approved a different question";
      }
      return verifyBytes(publicKey, questionAnswerSigningInput({ ...fields, question: e2eeQuestion }),
        fromB64u(e2eeQuestionSignature, { length: 64 })) ? null : "the signature does not match";
    }
    return verifyBytes(publicKey, answerSigningInput(fields), fromB64u(e2eeSignature, { length: 64 })) ? null : "the signature does not match";
  } catch {
    return "the signature is malformed";
  }
}

/**
 * Returns `payload` when its positive answer may be acted on; throws otherwise. `expected` carries
 * what this CLI asked: { interactionId, questionContext?, askedAt? }.
 */
export async function verifyAnswer(payload, client, dependencies, expected = {}) {
  const interaction = payload?.interaction ?? payload;
  if (!SIGNED_ACTION[interaction?.state]) return payload;
  const apiUrl = client?.apiUrl;
  if (!apiUrl || !dependencies?.configPath) return payload;
  const store = await loadKeyStore(keyStorePath(dependencies.configPath(), dependencies.env));
  // Any phone recorded for this server (pending ones too) means answers must be signed.
  if (!store.identity || !Object.keys(store.trusted).some((entry) => entry.startsWith(`${apiUrl}|`))) return payload;
  const recalled = expected.interactionId ? await recalledQuestion(dependencies.env, expected.interactionId) : null;
  const problem = answerProblem(interaction, store, apiUrl, { ...recalled, ...expected },
    dependencies.now?.() ?? Date.now());
  if (problem === null) {
    if (expected.interactionId) await forgetQuestion(dependencies.env, expected.interactionId);
    return { ...payload, verified: true };
  }
  throw new TerminalInteractionError(`Refusing the answer: ${problem}. Do not act on it.`, {
    state: "unverified",
    details: { interactionId: interaction.id, reason: problem },
  });
}
