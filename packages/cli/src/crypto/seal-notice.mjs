// Seals `relo notify` for the phones this computer verified (docs/ENCRYPTION-PROTOCOL.md, E3.1).
//
// Each verified phone gets its own small alert envelope (title + summary, small enough for a push)
// and the body is sealed once to all of them. Sealing randomness is derived from this computer's
// identity key, the idempotency key, the recipients and the plaintext, so an exact retry produces
// byte-identical ciphertext (the server ignores the randomized signature when comparing retries)
// while any other input gets unrelated values.
import { createHash, createHmac } from "node:crypto";
import { b64u, fromB64u, sealEnvelope, verifyPrekey } from "./e2ee.mjs";
import { identityKeys, subkey, trustKey } from "./keystore.mjs";
import { approveCommand, ensureTrust, isPhoneId, pinnedPhones, trustNotices, trustedPhones } from "./trust.mjs";
import { isOwnerOverview, phoneLabel } from "./device-names.mjs";
import { keyStorePath, loadKeyStore } from "./keystore.mjs";
import { EXIT, ReloError, LOCAL_NOT_LINKED, LOCAL_RELINK } from "../shared/errors.mjs";
import { isLoopbackApiUrl } from "../shared/config.mjs";
import { dropDeviceKeys } from "./device-keys-cache.mjs";
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
 * this server and the server cannot do end-to-end encryption (an older server, no key store), or when
 * the account is local (see below).
 * Once a phone is trusted, anything that would downgrade to readable text fails closed: a server
 * that hides the phone's keys must not be able to make the CLI send readable content.
 */
export async function trustFor({ client, config, dependencies, notes }) {
  // A local account (Relo for Mac's own server) whose server is on this computer: nothing leaves it, so nothing is sealed.
  // Both conditions: an SSH tunnel to a remote server is loopback too, but it is not marked local, so it still seals.
  if (config.local === true && isLoopbackApiUrl(config.apiUrl)) return null;
  let known = null;
  try {
    known = await loadKeyStore(keyStorePath(dependencies.configPath(), dependencies.env));
  } catch (error) {
    if (!STORE_ERRORS.has(error?.code)) throw error;
  }
  // Once this computer has trusted a phone on this server it stays committed, even if pins vanish.
  const committed = known?.identity && (known.committed?.[config.apiUrl] === true || trustedPhones(known, config.apiUrl).length > 0);
  try {
    const trust = await ensureTrust({ client, config, dependencies });
    notes?.push(...trustNotices(trust.store, config.apiUrl, dependencies.now?.() ?? Date.now(), trust.devices));
    return { ...trust, committed: committed || trust.store.committed?.[config.apiUrl] === true
      || trustedPhones(trust.store, config.apiUrl).length > 0 };
  } catch (error) {
    await dropDeviceKeys(dependencies);
    // The cause stays on the error: a network failure lets `relo work` queue the write (EDGE.3).
    if (committed) throw Object.assign(sealingUnavailable(error?.message), { cause: error });
    // Never sealed for this server: a server without key routes or a test double stays readable.
    const unsupported = error?.status === 404 || error instanceof TypeError || STORE_ERRORS.has(error?.code);
    if (!unsupported) notes?.push(`not end-to-end encrypted: ${error?.message ?? "keys unavailable"}`);
    return null;
  }
}

/**
 * The names behind an agent session's handles, sealed for this computer's trusted phones and linked
 * browsers (kind "names"), as { envelope, recipients } where `recipients` names who it is sealed for;
 * { plain: true } when this account is not encrypted (Relo for Mac's local server, a computer never committed with
 * nobody to seal for on a server that does not require it): the labels then go readable, as the cards do; null when
 * there is nobody to seal for and readable labels are not allowed. Agent sessions carry no other envelope, so without this the
 * phone could only show the handles. When `unlessRecipients` equals the current recipients nothing is
 * sealed (envelope null): a browser linked after the session began changes them, and only then is it
 * sealed again so the new browser can read the session's names.
 */
export async function sealSessionNames({ names = {}, title, session, client, config, dependencies, unlessRecipients }) {
  if (Object.keys(names).length === 0 && !title) return null;
  const trust = await trustFor({ client, config, dependencies, notes: [] });
  if (!trust) return { plain: true };
  const { eligible, readers } = await sealRecipients({ trust, client, config });
  // Names carry no alert, so Relo for Mac and linked browsers can be their only readers: an account with no phone
  // (or one whose phone was skipped) still names its sessions' handles, which the hooks send whenever a key is pinned.
  if (eligible.length === 0 && readers.length === 0) {
    if (trust.committed) return null;
    let required = false;
    try { required = (await client.endToEndPolicy())?.required === true; } catch { /* an older server: not required */ }
    return required ? null : { plain: true };
  }
  const recipients = [...eligible, ...readers].map((device) => device.deviceId).sort().join(",");
  if (unlessRecipients === recipients) return { envelope: null, recipients };
  const envelope = sealEnvelope({ kind: "names", context: `ses:${String(session).slice(0, 32)}`, sender: identityKeys(trust.store),
    recipients: [...eligible, ...readers], content: { names, ...(title ? { title } : {}) } });
  return { envelope, recipients };
}

export function sealingUnavailable(reason, { local = false } = {}) {
  if (local) return new ReloError(`${LOCAL_NOT_LINKED} Nothing was sent.`, { code: "E2EE_UNAVAILABLE", exitCode: EXIT.API, details: { hint: LOCAL_RELINK } });
  return new ReloError(`End-to-end encryption is on for this server but the phone's keys are unavailable${reason ? ` (${reason})` : ""}. Nothing was sent.`,
    { code: "E2EE_UNAVAILABLE", exitCode: EXIT.API, details: { hint: "Open Relo on the iPhone, then retry; relo keys status shows the phones" } });
}

// EEXIST: Windows' answer to a mkdir under a file (ENOTDIR elsewhere).
const STORE_ERRORS = new Set(["ENOENT", "EACCES", "EROFS", "ENOTDIR", "EPERM", "EEXIST"]);

/** The opaque work identity for a sealed request (E2.5), and the names to seal for the phone. */
export async function opaqueIdentity(store, context, dependencies) {
  const opaque = opaqueContext(context, groupingKey(identityKeys(store).privateKey), await loadKnownNames(dependencies));
  await rememberNames(dependencies, Object.fromEntries(Object.entries(opaque.names)));
  return opaque;
}

function derive(seed, label, length) {
  return createHmac("sha256", seed).update(label).digest().subarray(0, length);
}

/**
 * Phones trusted on this computer whose current prekey is signed by the pinned identity key, and the
 * linked browsers and owner overview devices (`readers`, such as the Mac's notch app) that get the
 * content envelope too. A reader never gets an alert envelope, so it never becomes a target the server
 * would deliver to. Targeting phones never drops readers.
 * `skipped` lists every other phone with { deviceId, label, reason } so no command drops one silently.
 */
export function sealablePhones(store, apiUrl, devices, requestedDeviceIds) {
  const eligible = [];
  const readers = [];
  const skipped = [];
  for (const device of devices) {
    const browser = device.kind === "browser";
    const reader = browser || isOwnerOverview(device);
    if (!reader && requestedDeviceIds && !requestedDeviceIds.includes(device.deviceId)) continue;
    const pinned = store.trusted[trustKey(apiUrl, device.deviceId)];
    const fresh = device.prekey && Date.now() - Date.parse(device.prekey.createdAt) < MAX_PREKEY_AGE_MS;
    const sameKey = pinned && device.identityKey?.publicKey && pinned.publicKey === device.identityKey.publicKey;
    let prekeyOk = false;
    try {
      prekeyOk = Boolean(sameKey && pinned.level !== "pending" && fresh
        && verifyPrekey({ identityPublicKey: fromB64u(pinned.publicKey, { length: 65 }), prekey: { ...device.prekey, deviceId: device.deviceId } }));
    } catch {
      prekeyOk = false;
    }
    const recipient = prekeyOk && { deviceId: device.deviceId, prekeyId: device.prekey.prekeyId, publicKey: fromB64u(device.prekey.publicKey, { length: 65 }) };
    if (recipient && reader) readers.push(recipient);
    else if (recipient) eligible.push(recipient);
    else if (!browser) {
      const reason = !pinned || !device.identityKey?.publicKey ? "no keys yet: open Relo on it"
        : pinned.level === "pending" ? `waiting for approval: ${approveCommand(store, apiUrl, pinned)}`
        : !sameKey ? `security code changed and not accepted: ${approveCommand(store, apiUrl, pinned)}`
        : "no fresh key: open Relo on it";
      skipped.push({ deviceId: device.deviceId, label: phoneLabel({ ...pinned, ...device, name: device.name ?? pinned?.name }), reason });
    }
  }
  return { eligible, readers: readers.slice(0, Math.max(0, 16 - eligible.length)), skipped };
}

/**
 * Who a sealed command is for: the one rule every sealer (notice, question, card, work, session names) uses.
 * Phones first (with the readers beside them). With no phone eligible but Relo for Mac (an owner overview device)
 * holding a current key, a computer that is committed to encryption, or a server that requires it, seals for the
 * Mac instead of sending readable content or refusing: a Mac-only account on a remote server would otherwise
 * deadlock. The server needs one alert envelope per sealed command, so the Mac stands in for the phone there.
 * Only when no phone is pinned for this server at all: a pinned phone that was merely skipped (a stale key, a
 * changed key held in strict mode, one waiting for approval) is never replaced by the Mac, or the phone would
 * silently get nothing; the caller then reports the skip reason. A server that does not require encryption
 * (Automatic, no phone) still gets readable content.
 */
export async function sealRecipients({ trust, client, config, deviceIds }) {
  const found = sealablePhones(trust.store, config.apiUrl, trust.devices, deviceIds);
  if (found.eligible.length > 0) return found;
  const macs = found.readers.filter((reader) => isPhoneId(reader.deviceId));
  if (macs.length === 0) return found;
  if (pinnedPhones(trust.store, config.apiUrl).length > 0) return found;
  if (!trust.committed) {
    let required = false;
    try { required = (await client.endToEndPolicy())?.required === true; } catch { /* an older server: not required */ }
    if (!required) return found;
  }
  return { ...found, eligible: macs, readers: found.readers.filter((reader) => !macs.includes(reader)) };
}

/** Why nobody can be sealed for: each skipped phone and its reason, else the plain statement. */
export function noRecipientReason(skipped = []) {
  return skipped.length ? skipped.map((phone) => `${phone.label}: ${phone.reason}`).join("; ") : "no trusted phone has a current key";
}

/** "encrypted for 1 phone; not sent to iPhone Air (Simulator) (waiting for approval: relo keys approve iphone-air)". */
export function skippedNote(what, eligible, skipped) {
  const names = skipped.map((phone) => `${phone.label} (${phone.reason})`).join("; ");
  return `${what} end-to-end encrypted for ${eligible.length} phone${eligible.length === 1 ? "" : "s"}; not readable on ${names}`;
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

export function sealNotice({ sender, idempotencyKey, phones, readers = [], content, sentAt, kind = "notice", alert, names }) {
  const plaintext = withNames(sentAt === undefined ? { ...content } : { ...content, sentAt }, names);
  const byDevice = (a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);
  // Phones get a push alert each; linked browsers (readers) only the shared content envelope.
  const alerted = [...phones].sort(byDevice);
  const recipients = [...phones, ...readers].sort(byDevice);
  const seed = createHmac("sha256", subkey(sender.privateKey, "seal-seed")).update([
    `relo.e2e.v1 seal-${kind}`, idempotencyKey,
    ...recipients.map((phone) => `${phone.deviceId} ${phone.prekeyId} ${b64u(phone.publicKey)}`),
    createHash("sha256").update(JSON.stringify(plaintext)).digest("hex"),
  ].join("\n")).digest();
  const context = `ntf:${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
  // A card's per-phone envelope is what the Lock Screen renders, so it carries the whole card text.
  const alertContent = withNames(alert ?? { ...fitAlert({ title: content.title, summary: content.summary }),
    ...(sentAt === undefined ? {} : { sentAt }) }, names, MAX_ALERT_PLAINTEXT);
  const alerts = alerted.map((phone, index) => sealEnvelope({
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
  const { store } = trust;
  const { eligible, readers, skipped } = await sealRecipients({ trust, client, config, deviceIds: body.deviceIds });
  if (eligible.length === 0) {
    if (trust.committed) throw sealingUnavailable(noRecipientReason(skipped));
    return body;
  }
  const identity = await opaqueIdentity(store, body.context, dependencies);
  const sealed = sealNotice({
    sender: identityKeys(store), idempotencyKey: key, phones: eligible, readers, names: identity.names,
    // The captured command time, not now: an exact retry must seal the same plaintext.
    sentAt: body.relevance?.occurredAt ?? new Date(dependencies.now()).toISOString(),
    content: Object.fromEntries(Object.entries({
      title: body.title, summary: body.summary, body: body.body, bodyFormat: body.bodyFormat,
      imageUrl: body.imageUrl, destinationUrl: body.destinationUrl,
    }).filter(([, value]) => value !== undefined)),
  });
  if (skipped.length) notes.push(skippedNote("notice", eligible, skipped));
  const { title, summary, body: _text, bodyFormat, imageUrl, destinationUrl, deviceIds, ...metadata } = body;
  return { ...metadata, ...(identity.context ? { context: identity.context } : {}), sealed };
}

/**
 * Seals a question's title and prompt for the account's phones that have keys (E4.1); null when
 * none has, so the question goes out as today. The answer buttons' labels stay readable.
 * Returns { sealed, context } where context is the opaque work identity to send (E2.5).
 */
export async function sealQuestion({ title, prompt, detail, key, client, config, dependencies, notes, deviceIds, context }) {
  const trust = await trustFor({ client, config, dependencies, notes });
  if (!trust) return null;
  const { store } = trust;
  const { eligible, readers, skipped } = await sealRecipients({ trust, client, config, deviceIds });
  if (eligible.length === 0) {
    if (trust.committed) throw sealingUnavailable(noRecipientReason(skipped));
    return null;
  }
  if (skipped.length) notes.push(skippedNote("question", eligible, skipped));
  const identity = await opaqueIdentity(store, context, dependencies);
  const sealed = sealNotice({ kind: "question", sender: identityKeys(store), idempotencyKey: key, phones: eligible, readers,
    // The detail travels inside the seal, never as plaintext beside it.
    content: { title: title ?? "Question", summary: prompt, body: detail ?? prompt, ...(detail ? { bodyFormat: "markdown" } : {}) },
    names: identity.names });
  return { sealed, context: identity.context };
}
