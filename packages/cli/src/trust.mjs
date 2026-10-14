// Automatic trust (docs/END-TO-END-ENCRYPTION.md, "Trust"): like WhatsApp and Signal, a computer
// trusts the account's first phone the first time it sees its identity key ("auto") and starts
// sealing at once. A changed key for a phone it already trusts is trusted again with a visible
// notice. A phone that appears LATER is not trusted automatically: a server could add its own
// "phone" to read everything, so a new phone waits ("pending") until a trusted phone approves it
// in Relo → Settings → Security (a signed approval; a linked browser may sign too, outside strict
// mode) or a person runs `relo keys approve`. Strict mode (`relo keys strict on`) also holds key
// changes, and a phone set up again, until approved. A simulator is never trusted automatically.
import { approveDeviceSigningInput, fromB64u, linkSigningInput, verifyBytes } from "./e2ee.mjs";
import { ensureIdentity, keyStorePath, saveKeyStore, trustKey } from "./keystore.mjs";
import { isSimulator, phoneHandle, phoneLabel } from "./device-names.mjs";

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

/** Phones and browsers pinned for this server (every level). */
function pinnedFor(store, apiUrl) {
  return Object.entries(store.trusted).filter(([key]) => key.startsWith(`${apiUrl}|`)).map(([, entry]) => entry);
}

const DASHBOARD_REMOVE = "Dashboard → Account → Security → Devices → Remove";

/** "your iPhone 17 Pro" or "your iPhone 17 Pro or iPhone 15": the phones that can approve, by name. */
export function trustedPhonesLabel(store, apiUrl) {
  const phones = trustedPhones(store, apiUrl);
  const real = phones.filter((entry) => !isSimulator(entry));
  const labels = [...new Set((real.length ? real : phones).map((entry) => phoneLabel(entry)))];
  if (labels.length === 0) return "a trusted iPhone";
  return `your ${labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`}`;
}

/** What to run to accept `entry`: `relo keys approve <handle>`. */
export function approveCommand(store, apiUrl, entry) {
  const phones = pinnedFor(store, apiUrl).filter((pinned) => pinned.kind !== "browser" && isPhoneId(pinned.deviceId));
  return `relo keys approve ${phoneHandle(entry, phones)}`;
}

/** What waiting for approval means and the three ways out, naming the phones. */
export function pendingNote(store, apiUrl, entry) {
  return `${phoneLabel(entry)} is waiting for approval: run \`${approveCommand(store, apiUrl, entry)}\`, approve it on`
    + ` ${trustedPhonesLabel(store, apiUrl)} in Relo → Settings → Security, or remove it (${DASHBOARD_REMOVE})`;
}

/**
 * Notices worth showing with any command: phones waiting to be accepted (always), and for a week after
 * they happen key changes, approvals, phones set up again and linked browsers. With `devices` (the
 * current key listing) it also names a phone whose security code change strict mode holds.
 */
export function trustNotices(store, apiUrl, now = Date.now(), devices = []) {
  const notes = [];
  const recent = (notice) => now - Date.parse(notice.at) < NOTICE_DAYS * 86_400_000;
  const byId = new Map(pinnedFor(store, apiUrl).map((entry) => [entry.deviceId, entry]));
  for (const entry of pinnedFor(store, apiUrl)) {
    const label = phoneLabel(entry);
    if (entry.level === "pending" && entry.notice?.kind === "phone_replaced") {
      notes.push(`your phone was set up again as ${label}; strict mode holds it until you run \`${approveCommand(store, apiUrl, entry)}\``
        + ` (or remove it: ${DASHBOARD_REMOVE})`);
    } else if (entry.level === "pending") {
      notes.push(pendingNote(store, apiUrl, entry));
    } else if (entry.notice?.kind === "new_phone_approved" && recent(entry.notice)) {
      const by = entry.notice.by ? phoneLabel(byId.get(entry.notice.by) ?? { deviceId: entry.notice.by }) : "your trusted phone";
      notes.push(`${label} was approved on ${by}: messages are now encrypted for it too`);
    } else if (entry.notice?.kind === "approved_from_browser" && recent(entry.notice)) {
      notes.push(`${label} was approved from ${entry.notice.byName ?? "a linked browser"}: messages are now encrypted for it too;`
        + ` if you did not do that, remove it (${DASHBOARD_REMOVE})`);
    } else if (entry.notice?.kind === "phone_replaced" && recent(entry.notice)) {
      notes.push(`your phone was set up again: ${label} is now trusted and nothing is needed; if you did not sign a phone in, remove it (${DASHBOARD_REMOVE})`);
    } else if (entry.notice?.kind === "browser_linked" && recent(entry.notice)) {
      const by = entry.linkedBy && byId.get(entry.linkedBy) ? phoneLabel(byId.get(entry.linkedBy)) : "your phone";
      notes.push(`browser ${entry.name ?? entry.deviceId} was linked from ${by} and can read encrypted messages`);
    } else if (entry.notice?.kind === "security_code_changed" && recent(entry.notice)) {
      notes.push(`security code changed for ${label} (reinstalled or reset): it stays trusted and nothing is needed if you did that;`
        + ` otherwise remove it (${DASHBOARD_REMOVE})`);
    }
  }
  for (const device of devices) {
    const pinned = byId.get(device?.deviceId);
    if (!pinned || pinned.level === "pending" || pinned.kind === "browser" || !isPhoneId(device.deviceId)) continue;
    if (!device.identityKey?.publicKey || pinned.publicKey === device.identityKey.publicKey) continue;
    const label = phoneLabel({ ...pinned, ...presentation(device) });
    const why = isSimulator(device) || isSimulator(pinned) ? "a simulator is never re-trusted automatically" : "strict mode";
    notes.push(`security code changed for ${label}: nothing is encrypted for it until you run`
      + ` \`${approveCommand(store, apiUrl, pinned)}\` (${why}; or remove it: ${DASHBOARD_REMOVE})`);
  }
  return notes;
}

/** The fields that name a phone, from a key listing entry (merged with the device inventory). */
function presentation(device) {
  return Object.fromEntries(Object.entries({ name: device.name, model: device.model, isSimulator: device.isSimulator === true ? true : undefined })
    .filter(([, value]) => value !== undefined && value !== null));
}

/**
 * The key listing with each phone's model, last-seen and registration time from the device inventory
 * (`GET /api/devices`), when the listing lacks them and they matter: a phone this computer has not
 * accepted, or `always` (relo keys status / approve). The model is server-provided metadata like the
 * listing itself: a server that lies about it gains nothing it could not get by unlisting a phone.
 */
export async function withDeviceDetails(client, store, apiUrl, devices, { always = false } = {}) {
  const phones = devices.filter((device) => isPhoneId(device?.deviceId) && device?.kind !== "browser");
  const unsettled = phones.some((device) => {
    const pinned = store.trusted[trustKey(apiUrl, device.deviceId)];
    return !pinned || pinned.level === "pending" || pinned.publicKey !== device.identityKey?.publicKey;
  });
  const missing = phones.some((device) => device.model === undefined && device.isSimulator === undefined && device.simulator === undefined)
    || (always && phones.some((device) => device.lastSeenAt === undefined));
  let inventory = [];
  if (missing && (always || unsettled) && typeof client?.listDevices === "function") {
    try {
      const listed = await client.listDevices({ limit: 100 });
      inventory = Array.isArray(listed?.devices) ? listed.devices : [];
    } catch {
      inventory = [];
    }
  }
  const byId = new Map(inventory.map((entry) => [entry?.deviceId, entry]));
  return devices.map((device) => {
    if (!isPhoneId(device?.deviceId) || device?.kind === "browser") return device;
    const extra = byId.get(device.deviceId) ?? {};
    const pinned = store.trusted[trustKey(apiUrl, device.deviceId)];
    const simulator = device.simulator === true || device.isSimulator === true || extra.isSimulator === true
      || (extra.isSimulator === undefined && pinned?.isSimulator === true);
    return { ...device, model: device.model ?? extra.model ?? pinned?.model, lastSeenAt: device.lastSeenAt ?? extra.lastSeenAt,
      registeredAt: device.registeredAt ?? extra.registeredAt, ...(simulator ? { isSimulator: true } : {}) };
  });
}

/**
 * Loads (creating on first use) this computer's identity, publishes it to the server once, and pins
 * the account's phones. Returns { store, devices }; `devices` carries each phone's model when known.
 */
export async function ensureTrust({ client, config, dependencies, details = false }) {
  const path = keyStorePath(dependencies.configPath(), dependencies.env);
  const { store } = await ensureIdentity(path, { now: dependencies.now?.() ?? Date.now() });
  let changed = false;
  store.published ??= {};
  if (store.published[config.apiUrl] !== store.identity.keyId) {
    await client.publishClientKey({ identityKey: store.identity.publicKey });
    store.published[config.apiUrl] = store.identity.keyId;
    changed = true;
  }
  const listing = await client.listDeviceKeys();
  if (!Array.isArray(listing?.devices)) throw Object.assign(new Error("the key directory returned no device list"), { code: "E2EE_UNAVAILABLE" });
  const devices = await withDeviceDetails(client, store, config.apiUrl, listing.devices, { always: details });
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
  // A simulator is never "the trusted phone still on the account": it cannot hold back the automatic
  // re-trust of a real phone that was set up again.
  const listed = new Set(phones.filter((device) => !isSimulator(device)).map((device) => device.deviceId));
  // Like WhatsApp after a reinstall: when every phone this computer trusted is gone from the
  // account (signed out, replaced), the account's phone is trusted again automatically, with a
  // visible "set up again" notice. A phone that comes back with a key this computer already trusts
  // (same phone, new registration) needs no notice at all. Strict mode holds that phone as pending
  // instead: whoever has the account password can sign the trusted phone out and sign in their own.
  const replaced = !firstContact && known.length > 0 && !known.some((entry) => listed.has(entry.deviceId));
  for (const device of phones) {
    if (!device?.identityKey?.publicKey) continue;
    const key = trustKey(config.apiUrl, device.deviceId);
    const pinned = store.trusted[key];
    // A simulator is never trusted automatically (first contact, set up again, a changed key): only
    // an approval on a trusted phone or browser, or `relo keys approve`, accepts it.
    const simulator = isSimulator(device);
    const retrust = replaced && !store.strict && !simulator;
    const automatic = firstContact && !simulator;
    const sameKey = knownKeys.has(device.identityKey.publicKey);
    const approval = approvedBy(store, config.apiUrl, device, devices, now);
    const approvedNotice = approval?.kind === "browser"
      ? { kind: "approved_from_browser", at: now, by: approval.deviceId, byName: approval.name }
      : approval ? { kind: "new_phone_approved", at: now, by: approval.deviceId } : undefined;
    const named = presentation(device);
    if (pinned && pinned.level === "pending") {
      store.trusted[key] = { ...pinned, ...named, keyId: device.identityKey.keyId, publicKey: device.identityKey.publicKey,
        ...(sameKey || retrust || approval ? { level: "auto", trustedAt: now,
          notice: sameKey ? undefined : approvedNotice ?? { kind: "phone_replaced", at: now } }
          : replaced && !simulator ? { notice: { kind: "phone_replaced", at: now } } : {}) };
      changed = true;
      continue;
    }
    if (pinned?.publicKey === device.identityKey.publicKey) {
      // Keep the name and model current so every note names the phone the way the owner knows it.
      if (Object.entries(named).some(([field, value]) => pinned[field] !== value)) {
        store.trusted[key] = { ...pinned, ...named };
        changed = true;
      }
      continue;
    }
    if (pinned && (store.strict || simulator) && !approval) continue;
    store.trusted[key] = {
      deviceId: device.deviceId, ...named, keyId: device.identityKey.keyId, publicKey: device.identityKey.publicKey,
      level: pinned || automatic || sameKey || retrust || approval ? "auto" : "pending", trustedAt: now,
      ...(pinned ? { notice: approvedNotice ?? { kind: "security_code_changed", at: now, previousKeyId: pinned.keyId } }
        : automatic || sameKey ? {} : approvedNotice ? { notice: approvedNotice }
        : replaced && !simulator ? { notice: { kind: "phone_replaced", at: now } } : { notice: { kind: "new_phone", at: now } }),
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
 * Whether a linked browser's link (docs/END-TO-END-ENCRYPTION.md, "Linked browsers") holds right now:
 * signed by a phone this computer trusts, over the browser's current identity key, within LINK_DAYS.
 */
function linkHolds(store, apiUrl, device, now) {
  const link = device?.link;
  const phone = link?.deviceId ? store.trusted[trustKey(apiUrl, link.deviceId)] : undefined;
  try {
    // Like WhatsApp Web: a link lasts LINK_DAYS unless the phone re-signs it, so unlinking on the
    // phone takes effect even if the server keeps listing the browser.
    const age = Date.parse(now) - Date.parse(link.signedAt);
    return Boolean(isPhoneId(link.deviceId) && phone && phone.kind !== "browser" && phone.level !== "pending" && phone.publicKey
      && device.identityKey?.publicKey && typeof link.signedAt === "string"
      && age < LINK_DAYS * 86_400_000 && age > -5 * 60_000
      && verifyBytes(fromB64u(phone.publicKey, { length: 65 }), linkSigningInput({ browserId: device.deviceId,
        identityKey: device.identityKey.publicKey, phoneDeviceId: link.deviceId, signedAt: link.signedAt }),
      fromB64u(link.signature, { length: 64 })));
  } catch {
    return false;
  }
}

/** A linked browser is trusted only while a phone this computer trusts has signed its current identity key. Returns true when the store changed. */
function browserTrust(store, apiUrl, device, now) {
  const key = trustKey(apiUrl, device.deviceId);
  const pinned = store.trusted[key];
  if (!linkHolds(store, apiUrl, device, now)) {
    if (!pinned) return false;
    delete store.trusted[key];
    return true;
  }
  if (pinned?.publicKey === device.identityKey.publicKey) return false;
  store.trusted[key] = { deviceId: device.deviceId, kind: "browser", name: device.name, keyId: device.identityKey.keyId,
    publicKey: device.identityKey.publicKey, level: "auto", linkedBy: device.link.deviceId, trustedAt: now,
    notice: { kind: "browser_linked", at: now } };
  return true;
}

/**
 * Who approved a pending phone, or null: a phone this computer trusts that signed the phone's id and
 * current identity key in Relo → Settings → Security, or (not in strict mode) a browser linked right
 * now by such a phone, signing the same bytes with approverDeviceId = its brw_ id. The server only
 * relays the signature. Returns { kind: "phone"|"browser", deviceId, name }.
 */
function approvedBy(store, apiUrl, device, devices, now) {
  const approval = device.approval;
  if (!approval?.deviceId || approval.deviceId === device.deviceId || typeof approval.signedAt !== "string") return null;
  let approverKey;
  let found;
  if (isPhoneId(approval.deviceId)) {
    const approver = store.trusted[trustKey(apiUrl, approval.deviceId)];
    if (!approver || approver.level === "pending" || approver.kind === "browser" || !approver.publicKey) return null;
    approverKey = approver.publicKey;
    found = { kind: "phone", deviceId: approval.deviceId, name: approver.name };
  } else if (isBrowserId(approval.deviceId)) {
    // Strict mode accepts only phones: a browser's keys live in a web page the server delivers.
    if (store.strict) return null;
    const browser = devices.find((entry) => entry?.deviceId === approval.deviceId && entry?.kind === "browser");
    if (!browser || !linkHolds(store, apiUrl, browser, now)) return null;
    approverKey = browser.identityKey.publicKey;
    found = { kind: "browser", deviceId: approval.deviceId, name: browser.name };
  } else {
    return null;
  }
  try {
    return verifyBytes(fromB64u(approverKey, { length: 65 }), approveDeviceSigningInput({ deviceId: device.deviceId,
      identityKey: device.identityKey.publicKey, approverDeviceId: approval.deviceId, signedAt: approval.signedAt }),
    fromB64u(approval.signature, { length: 64 })) ? found : null;
  } catch {
    return null;
  }
}
