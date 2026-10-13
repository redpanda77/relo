// Verifies a phone's signed answer before the CLI acts on it (docs/END-TO-END-ENCRYPTION.md, E4.2).
//
// Once this computer trusts a phone on a server (`relo keys verify`), every positive answer from that
// server must carry a valid signature by a trusted phone's identity key over exactly this interaction,
// notification, device and value. Anything else (unsigned, unknown device, changed key, a value the
// phone did not sign) is refused with exit 4: do not act. Computers that never verified a phone keep
// today's behaviour.
import { createHash } from "node:crypto";
import { TerminalInteractionError } from "./errors.mjs";
import { answerSigningInput, fromB64u, keyId, verifyBytes } from "./e2ee.mjs";
import { keyStorePath, loadKeyStore, trustKey } from "./keystore.mjs";

const SIGNED_ACTION = { approved: "approve", yes: "yes", replied: "answer" };

function signedValue(state, response) {
  const action = SIGNED_ACTION[state];
  if (action !== "answer") return action;
  const text = typeof response?.response === "string" ? response.response : "";
  return `answer:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** Why `interaction` is not a verified answer from a trusted phone, or null when it is. */
export function answerProblem(interaction, store, apiUrl) {
  const deviceId = interaction?.respondingDevice?.id;
  if (!deviceId) return "no answering phone";
  const pinned = store.trusted[trustKey(apiUrl, deviceId)];
  if (!pinned) return "answered on a phone this computer has not verified";
  const response = interaction.response ?? {};
  const { e2eeKeyId, e2eeSignedAt, e2eeSignature } = response;
  if (typeof e2eeSignature !== "string" || typeof e2eeSignedAt !== "string") return "the answer is not signed";
  let publicKey;
  try {
    publicKey = fromB64u(pinned.publicKey, { length: 65 });
    if (keyId(publicKey) !== e2eeKeyId) return "signed by a different key";
    const value = signedValue(interaction.state, response);
    if (!value) return "not a signable answer";
    const message = answerSigningInput({
      interactionId: interaction.id, notificationId: interaction.eventId, deviceId, value, respondedAt: e2eeSignedAt,
    });
    return verifyBytes(publicKey, message, fromB64u(e2eeSignature, { length: 64 })) ? null : "the signature does not match";
  } catch {
    return "the signature is malformed";
  }
}

/** Returns `payload` when its positive answer may be acted on; throws otherwise. */
export async function verifyAnswer(payload, client, dependencies) {
  const interaction = payload?.interaction ?? payload;
  if (!SIGNED_ACTION[interaction?.state]) return payload;
  const apiUrl = client?.apiUrl;
  if (!apiUrl || !dependencies?.configPath) return payload;
  const store = await loadKeyStore(keyStorePath(dependencies.configPath(), dependencies.env));
  const required = store.identity && Object.keys(store.trusted).some((entry) => entry.startsWith(`${apiUrl}|`));
  if (!required) return payload;
  const problem = answerProblem(interaction, store, apiUrl);
  if (problem === null) return { ...payload, verified: true };
  throw new TerminalInteractionError(`Refusing the answer: ${problem}. Do not act on it.`, {
    state: "unverified",
    details: { interactionId: interaction.id, reason: problem },
  });
}
