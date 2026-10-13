// Automatic trust (docs/END-TO-END-ENCRYPTION.md, "Trust"): like WhatsApp and Signal, a computer
// trusts a phone's identity key the first time it sees it ("auto") and starts sealing at once; no
// person has to compare anything. A changed key is trusted again with a visible, non-blocking notice
// ("security code changed"). `relo keys verify` optionally upgrades a phone to "verified" by safety
// number, and `relo keys strict on` makes a change block until verified.
import { ensureIdentity, keyStorePath, saveKeyStore, trustKey } from "./keystore.mjs";

/**
 * Loads (creating on first use) this computer's identity, publishes it to the server once, and pins
 * every phone of the account that published keys. Returns { store, devices }.
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
  const now = new Date(dependencies.now?.() ?? Date.now()).toISOString();
  for (const device of devices) {
    if (!device?.identityKey?.publicKey) continue;
    const key = trustKey(config.apiUrl, device.deviceId);
    const pinned = store.trusted[key];
    if (pinned?.publicKey === device.identityKey.publicKey) continue;
    if (pinned && store.strict) continue;
    store.trusted[key] = {
      deviceId: device.deviceId, name: device.name, keyId: device.identityKey.keyId, publicKey: device.identityKey.publicKey,
      level: "auto", trustedAt: now,
      ...(pinned ? { notice: { kind: "security_code_changed", at: now, previousKeyId: pinned.keyId } } : {}),
    };
    changed = true;
  }
  if (changed) await saveKeyStore(path, store);
  return { store, devices };
}
