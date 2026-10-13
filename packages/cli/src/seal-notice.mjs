// Seals `relo notify` for the phones this computer verified (docs/END-TO-END-ENCRYPTION.md, E3.1).
//
// Each verified phone gets its own small alert envelope (title + summary, small enough for a push)
// and the body is sealed once to all of them. Sealing randomness is derived from this computer's
// identity key, the idempotency key, the recipients and the plaintext, so an exact retry produces
// byte-identical ciphertext (the server ignores the randomized signature when comparing retries)
// while any other input gets unrelated values.
import { createHash, createHmac } from "node:crypto";
import { b64u, fromB64u, sealEnvelope, verifyPrekey } from "./e2ee.mjs";
import { identityKeys, subkey, trustKey } from "./keystore.mjs";
import { approvePendingPhones } from "./phone-approval.mjs";
import { ensureTrust, trustNotices, trustedPhones } from "./trust.mjs";
import { keyStorePath, loadKeyStore } from "./keystore.mjs";
import { EXIT, ReloError } from "./errors.mjs";
import { groupingKey, loadKnownNames, opaqueContext, rememberNames } from "./opaque-names.mjs";

const MAX_ALERT_PLAINTEXT = 760;

/** Adds the handle → name map when it still fits; the phone also learns names from other envelopes. */
function withNames(content, names, limit) {
  if (!names || Object.keys(names).length === 0) return content;
  const named = { ...content, names };
  return limit === undefined || Buffer.byteLength(JSON.stringify(named)) <= limit ? named : content;
}

const MAX_PREKEY_AGE_MS = 30 * 86_400_000;

/**
 * This computer's trust, established automatically, or null when this computer has never sealed for
 * this server and the server cannot do end-to-end encryption (an older server, no key store).
 * Once a phone is trusted, anything that would downgrade to readable text fails closed: a server
 * that hides the phone's keys must not be able to make the CLI send readable content.
 */
export async function trustFor({ client, config, dependencies, notes }) {
  let known = null;
  try {
    known = await loadKeyStore(keyStorePath(dependencies.configPath(), dependencies.env));
  } catch (error) {
    if (!STORE_ERRORS.has(error?.code)) throw error;
  }
  const committed = known?.identity && trustedPhones(known, config.apiUrl).length > 0;
  try {
    const trust = await ensureTrust({ client, config, dependencies });
    notes?.push(...await approvePendingPhones({ client, apiUrl: config.apiUrl, store: trust.store, devices: trust.devices, dependencies }));
    notes?.push(...trustNotices(trust.store, config.apiUrl, dependencies.now?.() ?? Date.now()));
    return { ...trust, committed: committed || trustedPhones(trust.store, config.apiUrl).length > 0 };
  } catch (error) {
    if (committed) throw sealingUnavailable(error?.message);
    // Never sealed for this server: a server without key routes or a test double stays readable.
    const unsupported = error?.status === 404 || error instanceof TypeError || STORE_ERRORS.has(error?.code);
    if (!unsupported) notes?.push(`not end-to-end encrypted: ${error?.message ?? "keys unavailable"}`);
    return null;
  }
}

/**
 * The names behind an agent session's handles, sealed for this computer's trusted phones (kind
 * "names"), or null when there is nobody to seal for. Agent sessions carry no other envelope, so
 * without this the phone could only show the handles.
 */
export async function sealSessionNames({ names, session, client, config, dependencies }) {
  if (!names || Object.keys(names).length === 0) return null;
  const trust = await trustFor({ client, config, dependencies, notes: [] });
  if (!trust) return null;
  const { eligible } = sealablePhones(trust.store, config.apiUrl, trust.devices);
  if (eligible.length === 0) return null;
  return sealEnvelope({ kind: "names", context: `ses:${String(session).slice(0, 32)}`, sender: identityKeys(trust.store),
    recipients: eligible, content: { names } });
}

export function sealingUnavailable(reason) {
  return new ReloError(`End-to-end encryption is on for this server but the phone's keys are unavailable${reason ? ` (${reason})` : ""}. Nothing was sent.`,
    { code: "E2EE_UNAVAILABLE", exitCode: EXIT.API, details: { hint: "Open Relo on the iPhone, then retry; relo keys status shows the phones" } });
}

const STORE_ERRORS = new Set(["ENOENT", "EACCES", "EROFS", "ENOTDIR", "EPERM"]);

/** The opaque work identity for a sealed request (E2.5), and the names to seal for the phone. */
export async function opaqueIdentity(store, context, dependencies) {
  const opaque = opaqueContext(context, groupingKey(identityKeys(store).privateKey), await loadKnownNames(dependencies.env));
  await rememberNames(dependencies.env, Object.fromEntries(Object.entries(opaque.names)));
  return opaque;
}

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
    const fresh = device.prekey && Date.now() - Date.parse(device.prekey.createdAt) < MAX_PREKEY_AGE_MS;
    const usable = pinned && pinned.level !== "pending" && pinned.publicKey === device.identityKey.publicKey && fresh
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

export function sealNotice({ sender, idempotencyKey, phones, content, sentAt, kind = "notice", alert, names }) {
  const plaintext = withNames(sentAt === undefined ? { ...content } : { ...content, sentAt }, names);
  const recipients = [...phones].sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
  const seed = createHmac("sha256", subkey(sender.privateKey, "seal-seed")).update([
    `relo.e2e.v1 seal-${kind}`, idempotencyKey,
    ...recipients.map((phone) => `${phone.deviceId} ${phone.prekeyId} ${b64u(phone.publicKey)}`),
    createHash("sha256").update(JSON.stringify(plaintext)).digest("hex"),
  ].join("\n")).digest();
  const context = `ntf:${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
  // A card's per-phone envelope is what the Lock Screen renders, so it carries the whole card text.
  const alertContent = withNames(alert ?? { ...fitAlert({ title: content.title, summary: content.summary }),
    ...(sentAt === undefined ? {} : { sentAt }) }, names, MAX_ALERT_PLAINTEXT);
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
  // Trust on first use: phones with keys are trusted automatically and everything to them is sealed.
  const trust = await trustFor({ client, config, dependencies, notes });
  if (!trust) return body;
  const { store, devices } = trust;
  const { eligible, skipped } = sealablePhones(store, config.apiUrl, devices, body.deviceIds);
  if (eligible.length === 0) {
    if (trust.committed) throw sealingUnavailable("no trusted phone has a current key");
    return body;
  }
  const identity = await opaqueIdentity(store, body.context, dependencies);
  const sealed = sealNotice({
    sender: identityKeys(store), idempotencyKey: key, phones: eligible, names: identity.names,
    // The captured command time, not now: an exact retry must seal the same plaintext.
    sentAt: body.relevance?.occurredAt ?? new Date(dependencies.now()).toISOString(),
    content: Object.fromEntries(Object.entries({
      title: body.title, summary: body.summary, body: body.body, bodyFormat: body.bodyFormat,
      imageUrl: body.imageUrl, destinationUrl: body.destinationUrl,
    }).filter(([, value]) => value !== undefined)),
  });
  if (skipped.length) notes.push(`end-to-end encrypted for ${eligible.length} phone(s); ${skipped.length} phone(s) without keys skipped`);
  const { title, summary, body: _text, bodyFormat, imageUrl, destinationUrl, deviceIds, ...metadata } = body;
  return { ...metadata, ...(identity.context ? { context: identity.context } : {}), sealed };
}

/**
 * Seals a question's title and prompt for the account's phones that have keys (E4.1); null when
 * none has, so the question goes out as today. The answer buttons' labels stay readable.
 * Returns { sealed, context } where context is the opaque work identity to send (E2.5).
 */
export async function sealQuestion({ title, prompt, key, client, config, dependencies, notes, deviceIds, context }) {
  const trust = await trustFor({ client, config, dependencies, notes });
  if (!trust) return null;
  const { store, devices } = trust;
  const { eligible, skipped } = sealablePhones(store, config.apiUrl, devices, deviceIds);
  if (eligible.length === 0) {
    if (trust.committed) throw sealingUnavailable("no trusted phone has a current key");
    return null;
  }
  if (skipped.length) notes.push(`question end-to-end encrypted for ${eligible.length} phone(s); ${skipped.length} phone(s) without keys see a placeholder`);
  const identity = await opaqueIdentity(store, context, dependencies);
  const sealed = sealNotice({ kind: "question", sender: identityKeys(store), idempotencyKey: key, phones: eligible,
    content: { title: title ?? "Question", summary: prompt, body: prompt }, names: identity.names });
  return { sealed, context: identity.context };
}
