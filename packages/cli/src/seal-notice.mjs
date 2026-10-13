// Seals `relo notify` for the phones this computer verified (docs/END-TO-END-ENCRYPTION.md, E3.1).
//
// Each verified phone gets its own small alert envelope (title + summary, small enough for a push)
// and the body is sealed once to all of them. Sealing randomness is derived from this computer's
// identity key, the idempotency key, the recipients and the plaintext, so an exact retry produces
// byte-identical ciphertext (the server ignores the randomized signature when comparing retries)
// while any other input gets unrelated values.
import { createHash, createHmac } from "node:crypto";
import { b64u, fromB64u, sealEnvelope, verifyPrekey } from "./e2ee.mjs";
import { identityKeys, keyStorePath, loadKeyStore, trustKey } from "./keystore.mjs";

const MAX_ALERT_PLAINTEXT = 760;

function derive(seed, label, length) {
  return createHmac("sha256", seed).update(label).digest().subarray(0, length);
}

/** Phones trusted on this computer whose current prekey is signed by the pinned identity key. */
export function sealablePhones(store, apiUrl, devices, requestedDeviceIds) {
  const eligible = [];
  const skipped = [];
  for (const device of devices) {
    if (requestedDeviceIds && !requestedDeviceIds.includes(device.deviceId)) continue;
    const pinned = store.trusted[trustKey(apiUrl, device.deviceId)];
    const usable = pinned && pinned.publicKey === device.identityKey.publicKey && device.prekey
      && verifyPrekey({ identityPublicKey: fromB64u(pinned.publicKey, { length: 65 }), prekey: { ...device.prekey, deviceId: device.deviceId } });
    if (usable) eligible.push({ deviceId: device.deviceId, prekeyId: device.prekey.prekeyId, publicKey: fromB64u(device.prekey.publicKey, { length: 65 }) });
    else skipped.push(device.deviceId);
  }
  return { eligible, skipped };
}

/** Shortens the summary until the alert fits in one push alongside the rest of the payload. */
export function fitAlert({ title, summary }) {
  let alert = { title, ...(summary ? { summary } : {}) };
  while (Buffer.byteLength(JSON.stringify(alert)) > MAX_ALERT_PLAINTEXT && alert.summary) {
    const chars = [...alert.summary];
    alert = { ...alert, summary: chars.length > 1 ? `${chars.slice(0, Math.max(1, chars.length - 16)).join("")}…` : undefined };
    if (!alert.summary) delete alert.summary;
  }
  return alert;
}

export function sealNotice({ sender, idempotencyKey, phones, content, sentAt, kind = "notice", alert }) {
  const plaintext = sentAt === undefined ? { ...content } : { ...content, sentAt };
  const recipients = [...phones].sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
  const seed = createHmac("sha256", sender.privateKey).update([
    `relo.e2e.v1 seal-${kind}`, idempotencyKey,
    ...recipients.map((phone) => `${phone.deviceId} ${phone.prekeyId} ${b64u(phone.publicKey)}`),
    createHash("sha256").update(JSON.stringify(plaintext)).digest("hex"),
  ].join("\n")).digest();
  const context = `ntf:${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
  // A card's per-phone envelope is what the Lock Screen renders, so it carries the whole card text.
  const alertContent = alert ?? { ...fitAlert({ title: content.title, summary: content.summary }), ...(sentAt === undefined ? {} : { sentAt }) };
  const alerts = recipients.map((phone, index) => sealEnvelope({
    kind, context, sender, recipients: [phone], content: alertContent,
    contentKey: derive(seed, `alert-key ${index}`, 32), nonce: derive(seed, `alert-nonce ${index}`, 12),
    ephemeralKeys: [derive(seed, `alert-ephemeral ${index}`, 32)],
  }));
  const body = sealEnvelope({
    kind, context, sender, recipients, content: plaintext,
    contentKey: derive(seed, "content-key", 32), nonce: derive(seed, "content-nonce", 12),
    ephemeralKeys: recipients.map((_, index) => derive(seed, `content-ephemeral ${index}`, 32)),
  });
  return { alerts, content: body };
}

/**
 * Returns the request body to send: sealed for verified phones when any exist, otherwise the
 * plain body with a note. `body` is the already validated plaintext request.
 */
export async function sealNoticeRequest({ body, key, client, config, dependencies, notes }) {
  // Read only: a computer that never ran `relo keys` gets no key store from sending a notice.
  const store = await loadKeyStore(keyStorePath(dependencies.configPath(), dependencies.env));
  const hasTrust = store.identity && Object.keys(store.trusted).some((entry) => entry.startsWith(`${config.apiUrl}|`));
  if (!hasTrust) return body;
  const { devices } = await client.listDeviceKeys();
  const { eligible, skipped } = sealablePhones(store, config.apiUrl, devices, body.deviceIds);
  if (eligible.length === 0) {
    notes.push("not end-to-end encrypted: no verified phone has a valid key (relo keys status)");
    return body;
  }
  const sealed = sealNotice({
    sender: identityKeys(store), idempotencyKey: key, phones: eligible,
    // The captured command time, not now: an exact retry must seal the same plaintext.
    sentAt: body.relevance?.occurredAt ?? new Date(dependencies.now()).toISOString(),
    content: Object.fromEntries(Object.entries({
      title: body.title, summary: body.summary, body: body.body, bodyFormat: body.bodyFormat,
      imageUrl: body.imageUrl, destinationUrl: body.destinationUrl,
    }).filter(([, value]) => value !== undefined)),
  });
  if (skipped.length) notes.push(`end-to-end encrypted for ${eligible.length} verified phone(s); ${skipped.length} unverified phone(s) skipped`);
  const { title, summary, body: _text, bodyFormat, imageUrl, destinationUrl, deviceIds, ...metadata } = body;
  return { ...metadata, sealed };
}

/**
 * Seals a question's title and prompt for this computer's verified phones (E4.1); null when none
 * are verified, so the question goes out as today. The answer buttons' labels stay readable.
 */
export async function sealQuestion({ title, prompt, key, client, config, dependencies, notes, deviceIds }) {
  const store = await loadKeyStore(keyStorePath(dependencies.configPath(), dependencies.env));
  const hasTrust = store.identity && Object.keys(store.trusted).some((entry) => entry.startsWith(`${config.apiUrl}|`));
  if (!hasTrust) return null;
  const { devices } = await client.listDeviceKeys();
  const { eligible, skipped } = sealablePhones(store, config.apiUrl, devices, deviceIds);
  if (eligible.length === 0) {
    notes.push("question not end-to-end encrypted: no verified phone has a valid key (relo keys status)");
    return null;
  }
  if (skipped.length) notes.push(`question end-to-end encrypted for ${eligible.length} verified phone(s); ${skipped.length} unverified phone(s) see a placeholder`);
  return sealNotice({ kind: "question", sender: identityKeys(store), idempotencyKey: key, phones: eligible,
    content: { title: title ?? "Question", summary: prompt, body: prompt } });
}
