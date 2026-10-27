// Opaque project, topic and task names (docs/ENCRYPTION-PROTOCOL.md, E2.5).
//
// When this computer seals for a phone, the work identity it sends is made of keyed handles
// ("p-…" project, "t-…" topic, "w-…" task, "c-…" computer, "a-…" account) instead of names: HMAC-SHA256 under a grouping key derived from this
// computer's identity key, so the server can still group one project's items but cannot read or
// guess the name. The real names travel inside the sealed envelopes (`names`), and the phone maps
// handles back. Handles are lowercase base32 so the server's case folding and label limits keep
// them intact. Each computer has its own grouping key: the same project used from two computers
// gets two handles, and the phone shows the same name for both.
import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../shared/atomic-write.mjs";
import { statePath } from "../work/state-file.mjs";
import { identityKeys, keyStorePath, loadKeyStore, subkey } from "./keystore.mjs";
import { isLoopbackApiUrl } from "../shared/config.mjs";

export const HANDLE_PATTERN = /^[ptwca]-[a-z2-7]{16}$/u;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const NAME_FIELDS = { project: "p", threadName: "t", taskTitle: "w", computer: "c", account: "a" };
const MAX_REMEMBERED_NAMES = 2_000;

export function groupingKey(identityPrivateKey) {
  return subkey(identityPrivateKey, "grouping");
}

function base32(bytes, length) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < length) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return output;
}

/** Same name (ignoring case and repeated spaces) → same handle on this computer. */
export function nameHandle(key, prefix, name) {
  const normalized = String(name).trim().replace(/\s+/gu, " ").toLowerCase();
  return `${prefix}-${base32(createHmac("sha256", key).update(`${prefix}\n${normalized}`).digest(), 16)}`;
}

/**
 * Replaces project, topic and task names with handles. Values that already are handles (a context
 * read back from the server) are kept, and their names come from `known`. Returns the opaque
 * context and the handle → name map to seal for the phone.
 */
export function opaqueContext(context, key, known = {}) {
  if (!context || typeof context !== "object") return { context, names: {} };
  const opaque = { ...context };
  const names = {};
  for (const [field, prefix] of Object.entries(NAME_FIELDS)) {
    const value = context[field];
    if (typeof value !== "string" || value.length === 0) continue;
    if (HANDLE_PATTERN.test(value)) {
      if (known[value]) names[value] = known[value];
      continue;
    }
    opaque[field] = nameHandle(key, prefix, value);
    names[opaque[field]] = value;
  }
  // The conversation key must not be a plain hash of names the server could test guesses against.
  if (typeof context.providerThreadId === "string" && context.providerThreadId.startsWith("cli-topic:")) {
    opaque.providerThreadId = `cli-topic:${createHash("sha256")
      .update(JSON.stringify([opaque.providerName, opaque.project, opaque.threadName])).digest("hex")}`;
  }
  return { context: opaque, names };
}

function namesPath(place) {
  return statePath(place, "names.json");
}

// One read per file per process while it is unchanged (size and mtime): a sealed command reads the map for each
// identity it makes and then remembers into it.
const loaded = new Map();

/** Handle → name for handles this computer made, so a context read back from the server resolves. */
export async function loadKnownNames(place) {
  const path = namesPath(place);
  try {
    const info = await stat(path);
    const stamp = `${info.size}:${info.mtimeMs}`;
    const hit = loaded.get(path);
    if (hit?.stamp === stamp) return hit.known;
    const known = JSON.parse(await readFile(path, "utf8"));
    loaded.set(path, { stamp, known });
    return known;
  } catch {
    loaded.delete(path);
    return {};
  }
}

export async function rememberNames(place, names) {
  if (!names || Object.keys(names).length === 0) return;
  const current = await loadKnownNames(place);
  // Nothing new: the file stays as it is (no rewrite, no new mtime for the next process to re-read).
  if (Object.entries(names).every(([handle, name]) => current[handle] === name)) return;
  const known = { ...current, ...names };
  const entries = Object.entries(known);
  const kept = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_REMEMBERED_NAMES)));
  const path = namesPath(place);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, JSON.stringify(kept));
  loaded.delete(path);
}

/** The hook's labels as handles plus the handle → name map the phone needs to show them. */
export async function hookLabelsWithNames(labels, apiUrl, dependencies, { local = false } = {}) {
  // Relo for Mac's own server on this computer: nothing is sealed there (trustFor), so a handle would never be named.
  if (!apiUrl || (local && isLoopbackApiUrl(apiUrl))) return { labels, names: {} };
  const store = await loadKeyStore(keyStorePath(dependencies.configPath(), dependencies.env));
  const sealing = store.identity && Object.keys(store.trusted).some((entry) => entry.startsWith(`${apiUrl}|`));
  if (!sealing) return { labels, names: {} };
  const key = groupingKey(identityKeys(store).privateKey);
  const prefixes = { project: "p", computer: "c", account: "a" };
  const opaque = { ...labels };
  const names = {};
  for (const [field, prefix] of Object.entries(prefixes)) {
    if (typeof labels[field] !== "string" || !labels[field] || HANDLE_PATTERN.test(labels[field])) continue;
    opaque[field] = nameHandle(key, prefix, labels[field]);
    names[opaque[field]] = labels[field];
  }
  await rememberNames(dependencies, names);
  return { labels: opaque, names };
}
