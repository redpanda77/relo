// Verifies a phone's signed answer before the CLI acts on it (docs/ENCRYPTION-PROTOCOL.md, E4.2).
//
// Once this computer trusts a phone on a server, every positive answer from that server must carry a
// valid signature by a trusted phone's identity key, or by a linked browser's ("Answering from a
// linked browser"): outside strict mode only, and only while that browser's link, signed by a phone
// this computer trusts over the browser's current identity key, is 14 days old or less (the rule a
// browser's device approval follows). The signature must cover the interaction this
// CLI is waiting for and, for a sealed question, the context of the envelope this CLI sealed (a value
// the server cannot choose), and be made after the question was asked. Anything else (unsigned, an
// unknown or pending phone, another question's approval, a replay) is refused with exit 8: do not
// act. Verification never trusts a new key on the way.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../shared/atomic-write.mjs";
import { TerminalInteractionError } from "../shared/errors.mjs";
import { isLoopbackApiUrl } from "../shared/config.mjs";
import { answerSigningInput, fromB64u, keyId, questionAnswerSigningInput, verifyBytes } from "./e2ee.mjs";
import { keyStorePath, loadKeyStore, trustKey } from "./keystore.mjs";
import { isBrowserId, isPhoneId, linkHolds, strictFor } from "./trust.mjs";
import { statePath } from "../work/state-file.mjs";

const SIGNED_ACTION = { approved: "approve", yes: "yes", replied: "answer", completed: "answer" };
const CLOCK_SKEW_MS = 5 * 60_000;
const QUESTION_ID = /^int_[0-9a-f-]{36}$/u;

function signedValue(state, response) {
  // A picked option is stored as replied; the phone signed which option it was.
  if (state === "replied" && typeof response?.optionId === "string") return `choose:${response.optionId}`;
  const action = SIGNED_ACTION[state];
  if (action !== "answer") return action;
  const text = typeof response?.response === "string" ? response.response : "";
  return `answer:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function questionsDirectory(place) {
  return statePath(place, "questions");
}

/** Remembers what this CLI asked, so an answer can be checked against it even after a resume. */
export async function rememberQuestion(place, record) {
  if (!QUESTION_ID.test(record?.interactionId ?? "")) return;
  const directory = questionsDirectory(place);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFileAtomic(join(directory, `${record.interactionId}.json`), JSON.stringify(record));
}

/** What this CLI asked as `interactionId`, or null (asked elsewhere, or already verified and forgotten). */
export async function recalledQuestion(place, interactionId) {
  if (!QUESTION_ID.test(interactionId ?? "")) return null;
  try {
    return JSON.parse(await readFile(join(questionsDirectory(place), `${interactionId}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function forgetQuestion(place, interactionId) {
  if (QUESTION_ID.test(interactionId ?? "")) await rm(join(questionsDirectory(place), `${interactionId}.json`), { force: true });
}

/**
 * The identity key an answer from `deviceId` must be signed with, or why none counts. A phone must be
 * pinned and accepted. A linked browser (`brw_…`) counts outside strict mode only, found in the current
 * key listing (`devices`, from `GET /api/devices/keys`) with a link a trusted phone signed over its
 * identity key 14 days ago or less: its keys live in a web page the server delivers.
 */
function answererKey(store, apiUrl, deviceId, devices, now) {
  if (isBrowserId(deviceId)) {
    if (strictFor(store, apiUrl)) return { problem: "answered in a linked browser, which strict mode does not accept (answer on a trusted phone)" };
    const browser = (devices ?? []).find((entry) => entry?.deviceId === deviceId && entry?.kind === "browser");
    if (!browser?.identityKey?.publicKey) return { problem: "answered in a browser that is no longer linked" };
    if (!linkHolds(store, apiUrl, browser, new Date(now).toISOString())) {
      return { problem: "answered in a browser without a current link from a phone this computer trusts (links last 14 days)" };
    }
    return { publicKey: browser.identityKey.publicKey };
  }
  const pinned = store.trusted[trustKey(apiUrl, deviceId)];
  if (!isPhoneId(deviceId) || pinned?.kind === "browser") return { problem: "answered on a device that is not a phone or a linked browser" };
  if (!pinned || pinned.level === "pending") return { problem: "answered on a phone this computer does not trust" };
  return { publicKey: pinned.publicKey };
}

const NOTIFICATION_ID = /^ntf_[0-9a-f-]{36}$/u;

/**
 * The ids the answering phone signed: this copy's, or another copy's of the same question
 * (docs/ENCRYPTION-PROTOCOL.md, "Answers on another copy"). A question folded onto a card has one
 * copy per phone and a long one continues as a notification; when another phone answers its own copy,
 * the server names that copy (`answeredCopy`). Which copy it names is the server's word, so it counts
 * only for a sealed question this computer asked: the phone's second signature binds the answer to the
 * context of the envelope it opened, a value this computer chose for this question alone, so the copy's
 * ids carry no trust of their own. A linked browser always answers the copy this computer waits on.
 */
function signedCopy(interaction, deviceId, expected) {
  const copy = interaction?.answeredCopy;
  if (copy === undefined || copy === null || (copy.id === interaction.id && copy.eventId === interaction.eventId)) {
    return { interactionId: interaction.id, notificationId: interaction.eventId };
  }
  if (!QUESTION_ID.test(copy?.id ?? "") || !NOTIFICATION_ID.test(copy?.eventId ?? "")) return { problem: "the answered copy is malformed" };
  if (isBrowserId(deviceId)) return { problem: "the browser answered another copy of the question" };
  if (!expected.questionContext) {
    return { problem: "answered on another copy of the question, which counts only for a question this computer sealed and remembers" };
  }
  return { interactionId: copy.id, notificationId: copy.eventId };
}

/**
 * Why `interaction` is not a verified answer to `expected` from a trusted phone or linked browser, or
 * null when it is. `options.devices` is the current key listing, needed for a browser's answer.
 */
export function answerProblem(interaction, store, apiUrl, expected = {}, now = Date.now(), options = {}) {
  if (expected.interactionId && interaction?.id !== expected.interactionId) return "the answer is for another question";
  const deviceId = interaction?.respondingDevice?.id;
  if (!deviceId) return "no answering phone";
  const answerer = answererKey(store, apiUrl, deviceId, options.devices, now);
  if (answerer.problem) return answerer.problem;
  const response = interaction.response ?? {};
  const { e2eeKeyId, e2eeSignedAt, e2eeSignature, e2eeQuestion, e2eeQuestionSignature } = response;
  if (typeof e2eeSignature !== "string" || typeof e2eeSignedAt !== "string") return "the answer is not signed";
  const signedAt = Date.parse(e2eeSignedAt);
  if (!Number.isFinite(signedAt) || signedAt > now + CLOCK_SKEW_MS
    || (expected.askedAt && signedAt < Date.parse(expected.askedAt) - CLOCK_SKEW_MS)) return "the answer was not signed for this question";
  let publicKey;
  try {
    publicKey = fromB64u(answerer.publicKey, { length: 65 });
    if (keyId(publicKey) !== e2eeKeyId) return "signed by a different key";
    const value = signedValue(interaction.state, response);
    if (!value) return "not a signable answer";
    const copy = signedCopy(interaction, deviceId, expected);
    if (copy.problem) return copy.problem;
    const fields = { interactionId: copy.interactionId, notificationId: copy.notificationId, deviceId, value, respondedAt: e2eeSignedAt };
    if (expected.questionContext) {
      // A sealed question: the phone must have signed the context of the envelope it opened.
      if (e2eeQuestion !== expected.questionContext || typeof e2eeQuestionSignature !== "string") {
        return isBrowserId(deviceId) ? "the browser answered a different question" : "the phone approved a different question";
      }
      return verifyBytes(publicKey, questionAnswerSigningInput({ ...fields, question: e2eeQuestion }),
        fromB64u(e2eeQuestionSignature, { length: 64 })) ? null : "the signature does not match";
    }
    return verifyBytes(publicKey, answerSigningInput(fields), fromB64u(e2eeSignature, { length: 64 })) ? null : "the signature does not match";
  } catch {
    return "the signature is malformed";
  }
}

/** The key listing now (browsers with their links); an empty one when it cannot be read: a browser's answer then does not count. */
export async function currentKeyListing(client) {
  try {
    const listing = await client?.listDeviceKeys?.();
    return Array.isArray(listing?.devices) ? listing.devices : [];
  } catch {
    return [];
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
  // A local account (Relo for Mac's own server on this computer): nothing is signed or encrypted; the answer is accepted as is.
  if (client.local === true && isLoopbackApiUrl(apiUrl)) return payload;
  const store = await loadKeyStore(keyStorePath(dependencies.configPath(), dependencies.env));
  // Any phone recorded for this server (pending ones too) means answers must be signed.
  if (!store.identity || !Object.keys(store.trusted).some((entry) => entry.startsWith(`${apiUrl}|`))) return payload;
  const recalled = expected.interactionId ? await recalledQuestion(dependencies, expected.interactionId) : null;
  const browserId = interaction?.respondingDevice?.id;
  const devices = isBrowserId(browserId) && !strictFor(store, apiUrl) ? await currentKeyListing(client) : undefined;
  const problem = answerProblem(interaction, store, apiUrl, { ...recalled, ...expected },
    dependencies.now?.() ?? Date.now(), { devices });
  if (problem === null) {
    if (expected.interactionId) await forgetQuestion(dependencies, expected.interactionId);
    // A browser's answer says so, so an answer the owner did not give is visible (like an approval from a browser).
    const browser = isBrowserId(browserId) ? devices?.find((entry) => entry?.deviceId === browserId) : undefined;
    return { ...payload, verified: true, ...(browser ? { answeredIn: { browser: browserId, name: browser.name ?? null } } : {}) };
  }
  throw new TerminalInteractionError(`Refusing the answer: ${problem}. Do not act on it.`, {
    state: "unverified",
    details: { interactionId: interaction.id, reason: problem },
  });
}
