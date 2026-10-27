// The account's device key listing (GET /api/devices/keys), kept in the state folder for a minute so a burst of
// sealed writes (a plan command sends several, each sealing) asks the server once. Only the raw listing is cached:
// ensureTrust still pins, verifies and decides trust from it on every call, so the cache can delay a new phone
// by TTL but never widen trust. Anything that suggests the keys moved (a 4xx on a sealed write, a sealing
// failure) drops it, and `relo keys ...` never reads it.
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomic } from "../shared/atomic-write.mjs";
import { statePath } from "../work/state-file.mjs";

export const DEVICE_KEYS_TTL_MS = 60_000;

/**
 * The cache lifetime: a command's `deviceKeysTtlMs` dependency, else a process-wide default (the test harness turns the
 * cache off with it, as its fake servers change keys between calls), else DEVICE_KEYS_TTL_MS. 0 turns the cache off.
 */
function ttlMs(dependencies) {
  const set = dependencies?.deviceKeysTtlMs ?? globalThis[Symbol.for("relo.deviceKeysTtlMs")];
  return Number.isFinite(set) && set >= 0 ? set : DEVICE_KEYS_TTL_MS;
}

const cachePath = (dependencies) => statePath(dependencies, "hooks", "device-keys.json");

/** The cached listing for this server and login, or undefined when absent, older than the TTL, or for another login. */
export async function readDeviceKeys(dependencies, scope) {
  const ttl = ttlMs(dependencies);
  if (ttl === 0) return undefined;
  try {
    const cached = JSON.parse(await readFile(cachePath(dependencies), "utf8"));
    const age = (dependencies.now?.() ?? Date.now()) - cached?.at;
    if (cached?.scope === scope && age >= 0 && age < ttl && Array.isArray(cached.listing?.devices)) return cached.listing;
  } catch { /* none yet */ }
  return undefined;
}

export async function writeDeviceKeys(dependencies, scope, listing) {
  if (ttlMs(dependencies) === 0) return;
  try {
    const path = cachePath(dependencies);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFileAtomic(path, JSON.stringify({ scope, at: dependencies.now?.() ?? Date.now(), listing }));
  } catch { /* a read-only state folder only costs a request next time */ }
}

export async function dropDeviceKeys(dependencies) {
  try { await rm(cachePath(dependencies), { force: true }); } catch { /* nothing to drop */ }
}
