// Automatic trust (docs/END-TO-END-ENCRYPTION.md, "Trust"): like WhatsApp and Signal, a computer
// trusts the account's first phone the first time it sees its identity key ("auto") and starts
// sealing at once. A changed key for a phone it already trusts is trusted again with a visible
// notice. A phone that appears LATER is not trusted automatically: a server could add its own
// "phone" to read everything, so a new phone waits ("pending") until a trusted phone approves it
// (phone-approval.mjs) or a person runs `relo keys verify`. Strict mode (`relo keys strict on`) also holds key changes until verified.
import { ensureIdentity, keyStorePath, saveKeyStore, trustKey } from "./keystore.mjs";

const NOTICE_DAYS = 7;

/** Phones pinned for this server, excluding ones waiting for a person. */
export function trustedPhones(store, apiUrl) {
  return Object.entries(store.trusted)
    .filter(([key, entry]) => key.startsWith(`${apiUrl}|`) && entry.level !== "pending")
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
  // Trust on first use applies to the account's FIRST phone(s) only.
  const firstContact = trustedPhones(store, config.apiUrl).length === 0;
  for (const device of devices) {
    if (!device?.identityKey?.publicKey) continue;
    const key = trustKey(config.apiUrl, device.deviceId);
    const pinned = store.trusted[key];
    if (pinned?.publicKey === device.identityKey.publicKey) continue;
    if (pinned && pinned.level === "pending") {
      store.trusted[key] = { ...pinned, keyId: device.identityKey.keyId, publicKey: device.identityKey.publicKey };
      changed = true;
      continue;
    }
    if (pinned && store.strict) continue;
    store.trusted[key] = {
      deviceId: device.deviceId, name: device.name, keyId: device.identityKey.keyId, publicKey: device.identityKey.publicKey,
      level: pinned || firstContact ? "auto" : "pending", trustedAt: now,
      ...(pinned ? { notice: { kind: "security_code_changed", at: now, previousKeyId: pinned.keyId } }
        : firstContact ? {} : { notice: { kind: "new_phone", at: now } }),
    };
    changed = true;
  }
  if (changed) await saveKeyStore(path, store);
  return { store, devices };
}
