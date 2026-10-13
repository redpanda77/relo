// A new phone is approved on a phone this computer already trusts (docs/END-TO-END-ENCRYPTION.md,
// "Trust"). A phone that appears after the first one is pending: nothing is sealed to it. Instead of
// asking a person to compare keys, this computer sends an end-to-end encrypted approval question to
// its trusted phones: "“iPad” signed in to your Relo account. Allow it to read your encrypted
// messages?". The answer counts only when it carries a valid signature from a trusted phone, bound to
// this question (answer-verify.mjs), so neither the server nor the new phone can approve it.
// `relo keys verify` stays available, e.g. when no trusted phone is left.
import { answerProblem } from "./answer-verify.mjs";
import { identityKeys, keyStorePath, saveKeyStore } from "./keystore.mjs";
import { sealNotice, sealablePhones } from "./seal-notice.mjs";

/** An approval question stays open this long (the server's maximum); unanswered, it is asked again later. */
export const APPROVAL_SECONDS = 28_800;
const ASK_AGAIN_MS = 24 * 3_600_000;

function question(entry) {
  const name = entry.name ?? "A new phone";
  return { title: "New phone", summary: `“${name}” signed in to your Relo account. Allow it to read your encrypted messages?`,
    body: `“${name}” signed in to your Relo account. Approve only if you just signed in on it yourself.` };
}

/**
 * Settles answered approval questions and asks about pending phones that have none. Returns notes for
 * the command's output. Never throws: approving is best effort and a pending phone simply stays pending.
 */
export async function approvePendingPhones({ client, apiUrl, store, devices, dependencies }) {
  const notes = [];
  const now = dependencies.now?.() ?? Date.now();
  let changed = false;
  for (const [key, entry] of Object.entries(store.trusted)) {
    if (!key.startsWith(`${apiUrl}|`) || entry.level !== "pending") continue;
    try {
      let approval = entry.approval?.keyId === entry.keyId ? entry.approval : null;
      if (approval?.interactionId && typeof client.getInteraction === "function") {
        const payload = await client.getInteraction(approval.interactionId);
        const interaction = payload?.interaction ?? payload;
        if (interaction?.state === "approved") {
          const problem = answerProblem(interaction, store, apiUrl,
            { interactionId: approval.interactionId, questionContext: approval.questionContext, askedAt: approval.askedAt }, now);
          if (problem === null) {
            const { approval: _settled, ...rest } = entry;
            store.trusted[key] = { ...rest, level: "auto", approvedBy: interaction.respondingDevice.id,
              notice: { kind: "new_phone_approved", at: new Date(now).toISOString() } };
            notes.push(`${entry.name ?? entry.deviceId} was approved on your trusted phone: messages are now encrypted for it too`);
          } else {
            store.trusted[key] = { ...entry, approval: { ...approval, interactionId: null, refused: problem } };
          }
          changed = true;
          continue;
        }
        if (interaction?.state === "denied") {
          store.trusted[key] = { ...entry, approval: { ...approval, interactionId: null, declined: true } };
          changed = true;
          continue;
        }
        if (interaction?.state === "pending") continue;
        approval = { ...approval, interactionId: null }; // expired or withdrawn: may be asked again later
      }
      if (approval?.declined) continue;
      if (approval?.askedAt && now - Date.parse(approval.askedAt) < ASK_AGAIN_MS) continue;
      if (typeof client.createInteraction !== "function") continue;
      const { eligible } = sealablePhones(store, apiUrl, devices ?? []);
      if (eligible.length === 0) continue;
      const idempotencyKey = `phone-approval:${entry.deviceId}:${entry.keyId}:${Math.floor(now / ASK_AGAIN_MS)}`;
      const sealed = sealNotice({ kind: "question", sender: identityKeys(store), idempotencyKey, phones: eligible, content: question(entry) });
      const created = await client.createInteraction({ sealed, type: "approval", expiresInSeconds: APPROVAL_SECONDS, answerInApp: true },
        idempotencyKey);
      const interactionId = created?.interaction?.id;
      if (!interactionId) continue;
      store.trusted[key] = { ...entry, approval: { keyId: entry.keyId, interactionId, questionContext: sealed.content.context,
        askedAt: new Date(now).toISOString() } };
      notes.push(`asked your trusted phone to approve ${entry.name ?? entry.deviceId}`);
      changed = true;
    } catch {
      // Best effort: the phone stays pending and the next command tries again.
    }
  }
  if (changed) await saveKeyStore(keyStorePath(dependencies.configPath(), dependencies.env), store);
  return notes;
}

