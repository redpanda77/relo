// Relo for Mac as the account's receiving device (local mode: no iPhone). The key listing says so in
// `capabilities` (owner_overview); a current prekey means the Mac has signed in and can open sealed content.
import { isOwnerOverview } from "./device-names.mjs";

const MAX_PREKEY_AGE_MS = 30 * 86_400_000;

/** The account's owner overview devices (Relo for Mac) from the key listing, or [] when none or the listing fails. */
export async function ownerMacs(client) {
  try {
    const listing = await client?.listDeviceKeys?.();
    return (Array.isArray(listing?.devices) ? listing.devices : []).filter((device) => isOwnerOverview(device));
  } catch {
    return [];
  }
}

/** A Mac whose prekey is recent enough to seal to. */
export const hasCurrentKey = (device, now = Date.now()) =>
  Boolean(device?.prekey) && now - Date.parse(device.prekey.createdAt) < MAX_PREKEY_AGE_MS;

/**
 * Relo for Mac devices that can receive: with keys on an account that seals, and on a local account every
 * signed-in Relo for Mac (nothing is encrypted there, so no key is needed). The plain device list does not
 * say what a device is, so the key listing's capabilities do; a device the plain list marks itself counts too.
 */
export async function receivingMacs(client, { local = false, now = Date.now(), devices = [] } = {}) {
  const listed = await ownerMacs(client);
  if (!local) return listed.filter((device) => hasCurrentKey(device, now));
  const known = new Set(listed.map((device) => device.deviceId));
  return [...listed, ...devices.filter((device) => isOwnerOverview(device) && !known.has(device.deviceId))];
}
