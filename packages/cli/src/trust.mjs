// Automatic trust (docs/END-TO-END-ENCRYPTION.md, "Trust"): like WhatsApp and Signal, a computer
// trusts the account's first phone the first time it sees its identity key ("auto") and starts
// sealing at once. A changed key for a phone it already trusts is trusted again with a visible
// notice. A phone that appears LATER is not trusted automatically: a server could add its own
// "phone" to read everything, so a new phone waits ("pending") until a trusted phone approves it
// (phone-approval.mjs) or a person runs `relo keys verify`. Strict mode (`relo keys strict on`) also holds key changes until verified.
import { fromB64u, linkSigningInput, verifyBytes } from "./e2ee.mjs";
import { ensureIdentity, keyStorePath, saveKeyStore, trustKey } from "./keystore.mjs";

const NOTICE_DAYS = 7;
/** A browser link signed longer ago than this no longer counts; the phone re-signs links it keeps. */
export const LINK_DAYS = 14;

/** Phones are dev_ ids and browsers brw_ ids; a server cannot relabel one as the other. */
export const isPhoneId = (id) => typeof id === "string" && id.startsWith("dev_");
export const isBrowserId = (id) => typeof id === "string" && id.startsWith("brw_");

/** Phones pinned for this server, excluding ones waiting for a person (and linked browsers). */
export function trustedPhones(store, apiUrl) {
  return Object.entries(store.trusted)
    .filter(([key, entry]) => key.startsWith(`${apiUrl}|`) && entry.level !== "pending" && entry.kind !== "browser"
      && isPhoneId(entry.deviceId))
    .map(([, entry]) => entry);
}

/** Notices worth showing with any command: recent key changes and phones waiting to be accepted. */
export function trustNotices(store, apiUrl, now = Date.now()) {
  const notes = [];
  for (const [key, entry] of Object.entries(store.trusted)) {
    if (!key.startsWith(`${apiUrl}|`)) continue;
    if (entry.level === "pending") {
      notes.push(entry.approval?.declined
        ? `${entry.name ?? entry.deviceId} was declined on your trusted phone and stays untrusted`
        : `a new phone (${entry.name ?? entry.deviceId}) waits for approval on your trusted phone`);
    } else if (entry.notice?.kind === "phone_replaced" && now - Date.parse(entry.notice.at) < NOTICE_DAYS * 86_400_000) {
      notes.push(`your phone ${entry.name ?? entry.deviceId} was set up again and is trusted; if you did not sign a phone in, run relo keys status`);
    } else if (entry.notice?.kind === "browser_linked" && now - Date.parse(entry.notice.at) < NOTICE_DAYS * 86_400_000) {
      notes.push(`browser ${entry.name ?? entry.deviceId} was linked from your phone and can read encrypted messages`);
    } else if (entry.notice?.kind === "security_code_changed" && now - Date.parse(entry.notice.at) < NOTICE_DAYS * 86_400_000) {
      notes.push(`security code changed for ${entry.name ?? entry.deviceId} (relo keys status)`);
    }
  }
  return notes;
}

/**
 * Loads (creating on first use) this computer's identity, publishes it to the server once, and pins
 * the account's phones. Returns { store, devices }.
 */
export async function ensureTrust({ client, config, dependencies }) {
  const path = keyStorePath(dependencies.configPath(), dependencies.env);
  const { store } = await ensureIdentity(path, { now: dependencies.now?.() ?? Date.now() });
  let changed = false;
  store.published ??= {};
  if (store.published[config.apiUrl] !== store.identity.keyId) {
    await client.publishClientKey({ identityKey: store.identity.publicKey });
    store.published[config.apiUrl] = store.identity.keyId;
    changed = true;
  }
  const { devices } = await client.listDeviceKeys();
  if (!Array.isArray(devices)) throw Object.assign(new Error("the key directory returned no device list"), { code: "E2EE_UNAVAILABLE" });
  const now = new Date(dependencies.now?.() ?? Date.now()).toISOString();
  // Trust on first use applies to the account's FIRST phone(s) only, once per server: a server that
  // makes this computer drop its pins never gets a second first contact. Browsers never get it.
  store.committed ??= {};
  if (trustedPhones(store, config.apiUrl).length > 0 && !store.committed[config.apiUrl]) {
    store.committed[config.apiUrl] = true;
    changed = true;
  }
  const firstContact = !store.committed[config.apiUrl];
  const phones = devices.filter((device) => isPhoneId(device?.deviceId) && device?.kind !== "browser");
  const known = trustedPhones(store, config.apiUrl);
  const knownKeys = new Set(known.map((entry) => entry.publicKey));
  const listed = new Set(phones.map((device) => device.deviceId));
  // Like WhatsApp after a reinstall: when every phone this computer trusted is gone from the
  // account (signed out, replaced), the account's phone is trusted again automatically, with a
  // visible "set up again" notice. A phone that comes back with a key this computer already trusts
  // (same phone, new registration) needs no notice at all.
  const replaced = !firstContact && known.length > 0 && !known.some((entry) => listed.has(entry.deviceId));
  for (const device of phones) {
    if (!device?.identityKey?.publicKey) continue;
    const key = trustKey(config.apiUrl, device.deviceId);
    const pinned = store.trusted[key];
    const sameKey = knownKeys.has(device.identityKey.publicKey);
    if (pinned && pinned.level === "pending") {
      store.trusted[key] = { ...pinned, keyId: device.identityKey.keyId, publicKey: device.identityKey.publicKey,
        ...(sameKey || replaced ? { level: "auto", trustedAt: now,
          notice: sameKey ? undefined : { kind: "phone_replaced", at: now } } : {}) };
      changed = true;
      continue;
    }
    if (pinned?.publicKey === device.identityKey.publicKey) continue;
    if (pinned && store.strict) continue;
    store.trusted[key] = {
      deviceId: device.deviceId, name: device.name, keyId: device.identityKey.keyId, publicKey: device.identityKey.publicKey,
      level: pinned || firstContact || sameKey || replaced ? "auto" : "pending", trustedAt: now,
      ...(pinned ? { notice: { kind: "security_code_changed", at: now, previousKeyId: pinned.keyId } }
        : firstContact || sameKey ? {} : replaced ? { notice: { kind: "phone_replaced", at: now } } : { notice: { kind: "new_phone", at: now } }),
    };
    changed = true;
  }
  // After the phones: a browser is trusted only with a link signed by a phone trusted above.
  for (const device of devices.filter((entry) => isBrowserId(entry?.deviceId) && entry?.kind === "browser")) {
    if (browserTrust(store, config.apiUrl, device, now)) changed = true;
  }
  if (!store.committed[config.apiUrl] && trustedPhones(store, config.apiUrl).length > 0) {
    store.committed[config.apiUrl] = true;
    changed = true;
  }
  if (changed) await saveKeyStore(path, store);
  return { store, devices };
}

/**
 * A linked browser (docs/END-TO-END-ENCRYPTION.md, "Linked browsers") is trusted only while a phone
 * this computer trusts has signed its current identity key. Returns true when the store changed.
 */
function browserTrust(store, apiUrl, device, now) {
  const key = trustKey(apiUrl, device.deviceId);
  const pinned = store.trusted[key];
  const link = device.link;
  const phone = link?.deviceId ? store.trusted[trustKey(apiUrl, link.deviceId)] : undefined;
  let valid = false;
  try {
    // Like WhatsApp Web: a link lasts LINK_DAYS unless the phone re-signs it, so unlinking on the
    // phone takes effect even if the server keeps listing the browser.
    const age = Date.parse(now) - Date.parse(link.signedAt);
    valid = Boolean(phone && phone.kind !== "browser" && phone.level !== "pending" && phone.publicKey
      && device.identityKey?.publicKey && typeof link.signedAt === "string"
      && age < LINK_DAYS * 86_400_000 && age > -5 * 60_000
      && verifyBytes(fromB64u(phone.publicKey, { length: 65 }), linkSigningInput({ browserId: device.deviceId,
        identityKey: device.identityKey.publicKey, phoneDeviceId: link.deviceId, signedAt: link.signedAt }),
      fromB64u(link.signature, { length: 64 })));
  } catch {
    valid = false;
  }
  if (!valid) {
    if (!pinned) return false;
    delete store.trusted[key];
    return true;
  }
  if (pinned?.publicKey === device.identityKey.publicKey) return false;
  store.trusted[key] = { deviceId: device.deviceId, kind: "browser", name: device.name, keyId: device.identityKey.keyId,
    publicKey: device.identityKey.publicKey, level: "auto", linkedBy: link.deviceId, trustedAt: now,
    notice: { kind: "browser_linked", at: now } };
  return true;
}
