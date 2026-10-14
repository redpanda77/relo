// The CLI's end-to-end encryption identity and its trust store (docs/END-TO-END-ENCRYPTION.md, E2.3).
//
// One file, e2ee.json, next to config.json and protected the same way (0600 in a 0700 folder,
// owned by the current user, no symlinks). It holds this computer's P-256 identity key and the
// phone identity keys a person verified with a safety number. The CLI seals only to those phones.
import { lstatSync, readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hkdfSync, randomBytes } from "node:crypto";
import { configPath } from "./config.mjs";
import { AuthError } from "./errors.mjs";
import { b64u, fromB64u, generateKeyPair, keyId, publicKeyFor } from "./e2ee.mjs";

const MAX_STORE_BYTES = 256 * 1024;

export function keyStorePath(configFile, env = process.env) {
  // process.env too: a caller's own env object (as in tests) must never fall back to the real store.
  return env.RELO_KEY_STORE_PATH || process.env.RELO_KEY_STORE_PATH || join(dirname(configFile), "e2ee.json");
}

function insecure(message) {
  return new AuthError(message, { code: "INSECURE_KEY_STORE" });
}

async function readSecure(path, { platform = process.platform, uid = process.getuid?.() } = {}) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw insecure(`Refusing non-regular key store at ${path}.`);
  if (platform !== "win32" && (info.mode & 0o077) !== 0) throw insecure(`Refusing key store at ${path}: expected mode 0600.`);
  if (platform !== "win32" && uid !== undefined && info.uid !== uid) throw insecure(`Refusing key store at ${path}: not owned by you.`);
  if (info.size > MAX_STORE_BYTES) throw insecure(`Refusing oversized key store at ${path}.`);
  return readFile(path, "utf8");
}

function emptyStore() {
  return { version: 1, identity: null, trusted: {} };
}

function parseStore(text, path) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw insecure(`Key store at ${path} is not valid JSON.`);
  }
  if (value?.version !== 1 || typeof value.trusted !== "object" || value.trusted === null) {
    throw insecure(`Key store at ${path} has an unknown format.`);
  }
  if (value.identity !== null) {
    const privateKey = fromB64u(value.identity?.privateKey ?? "", { length: 32, name: "identity" });
    if (b64u(publicKeyFor(privateKey)) !== value.identity.publicKey) throw insecure(`Key store at ${path} is corrupt.`);
  }
  return value;
}

export async function loadKeyStore(path, options) {
  const text = await readSecure(path, options);
  return text === null ? emptyStore() : parseStore(text, path);
}

export async function saveKeyStore(path, store) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Loads the store, creating this computer's identity key on first use. */
export async function ensureIdentity(path, { now = Date.now(), ...options } = {}) {
  const store = await loadKeyStore(path, options);
  if (store.identity) return { store, created: false };
  const pair = generateKeyPair();
  store.identity = {
    privateKey: b64u(pair.privateKey), publicKey: b64u(pair.publicKey),
    keyId: keyId(pair.publicKey), createdAt: new Date(now).toISOString(),
  };
  await saveKeyStore(path, store);
  return { store, created: true };
}

export function identityKeys(store) {
  return { privateKey: fromB64u(store.identity.privateKey, { length: 32 }), publicKey: fromB64u(store.identity.publicKey, { length: 65 }) };
}

/** Trust is per server and per phone, pinned to the exact identity key the person verified. */
export function trustKey(apiUrl, deviceId) {
  return `${apiUrl}|${deviceId}`;
}

/**
 * "verified" (security codes compared), "approved" (a person ran `relo keys approve`) or "auto" when the
 * pinned key matches; "pending" for a phone added later that nobody has accepted; "changed" while strict
 * mode (or a simulator) holds a key change; "new" before first use.
 */
export function trustState(store, apiUrl, device) {
  const pinned = store.trusted[trustKey(apiUrl, device.deviceId)];
  if (!pinned) return "new";
  if (pinned.level === "pending") return "pending";
  if (pinned.publicKey !== device.identityKey.publicKey) return "changed";
  return pinned.level === "auto" || pinned.level === "approved" ? pinned.level : "verified";
}

/**
 * A separate key for each use of the identity key (seal seeds, name handles, card keys), so the
 * ECDSA scalar is never used directly as an HMAC key.
 */
export function subkey(identityPrivateKey, label) {
  return Buffer.from(hkdfSync("sha256", identityPrivateKey, Buffer.from(`relo.e2e.v1 ${label}`), Buffer.from(label), 32));
}

/** This computer's identity private key, read synchronously, or null without a usable key store. */
export function loadIdentitySync(env = process.env) {
  try {
    const path = keyStorePath(configPath({ env }), env);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) return null;
    const store = JSON.parse(readFileSync(path, "utf8"));
    return store?.identity?.privateKey ? fromB64u(store.identity.privateKey, { length: 32 }) : null;
  } catch {
    return null;
  }
}
