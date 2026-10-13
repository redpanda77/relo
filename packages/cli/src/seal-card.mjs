// Seals Live Activity card text for this computer's verified phones (docs/END-TO-END-ENCRYPTION.md, E5).
//
// The server receives placeholders ("Encrypted card", "Updating…", "Step 1"…) and one envelope per
// phone; the widget opens it on the phone. An update may change one field, but the phone needs the
// whole card each time, so the CLI keeps each card's text in a private local cache (0600, removed
// when the card ends) and seals the merged text. Counts and progress numbers stay readable.
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { identityKeys } from "./keystore.mjs";
import { opaqueIdentity, sealablePhones, sealNotice, trustFor } from "./seal-notice.mjs";

export const SEALED_CARD_TITLE = "Encrypted card";
export const SEALED_CARD_STATUS = "Updating…";
const MAX_CARD_TEXT_BYTES = 500;
const CARD_ID = /^act_[0-9a-f-]{36}$/u;

export function sealedCardDirectory(env = process.env) {
  return env.RELO_SEALED_CARD_DIR || process.env.RELO_SEALED_CARD_DIR
    || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "relo", "sealed-cards");
}

export async function loadCardText(directory, cardId) {
  if (!CARD_ID.test(cardId ?? "")) return null;
  try {
    return JSON.parse(await readFile(join(directory, `${cardId}.json`), "utf8"));
  } catch {
    return null;
  }
}

export async function saveCardText(directory, cardId, text) {
  if (!CARD_ID.test(cardId ?? "")) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${cardId}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(text));
  } finally {
    await handle.close();
  }
  await rename(temporary, join(directory, `${cardId}.json`));
}

export async function forgetCardText(directory, cardId) {
  if (CARD_ID.test(cardId ?? "")) await rm(join(directory, `${cardId}.json`), { force: true });
}

/** The card text after this command: the previous text with this command's fields applied. */
export function mergedCardText(previous, body) {
  const text = { ...(previous ?? {}) };
  for (const field of ["title", "status", "detail", "progressLabel"]) {
    if (body[field] === null) delete text[field];
    else if (typeof body[field] === "string") text[field] = body[field];
  }
  if (Array.isArray(body.steps?.labels)) text.steps = [...body.steps.labels];
  return fitCardText(text);
}

/** Keeps the sealed text within two 256-byte blocks so the push stays small. */
export function fitCardText(text) {
  const fitted = { ...text };
  const size = () => Buffer.byteLength(JSON.stringify(fitted));
  const shorten = (value, length) => ([...value].length > length ? `${[...value].slice(0, length - 1).join("")}…` : value);
  if (size() > MAX_CARD_TEXT_BYTES && fitted.detail) fitted.detail = shorten(fitted.detail, 80);
  if (size() > MAX_CARD_TEXT_BYTES) delete fitted.detail;
  if (size() > MAX_CARD_TEXT_BYTES) delete fitted.progressLabel;
  if (size() > MAX_CARD_TEXT_BYTES && fitted.steps) fitted.steps = fitted.steps.map((label) => shorten(label, 14));
  if (size() > MAX_CARD_TEXT_BYTES && fitted.title) fitted.title = shorten(fitted.title, 40);
  return fitted;
}

/** What the server sees: placeholders for every text field this command sends. */
export function placeholderCardBody(body) {
  const placeholder = { ...body };
  if (typeof body.title === "string") placeholder.title = SEALED_CARD_TITLE;
  if (typeof body.status === "string") placeholder.status = SEALED_CARD_STATUS;
  if (typeof body.detail === "string") delete placeholder.detail;
  if (typeof body.progressLabel === "string") delete placeholder.progressLabel;
  if (Array.isArray(body.steps?.labels)) {
    placeholder.steps = { ...body.steps, labels: body.steps.labels.map((_, index) => `Step ${index + 1}`) };
  }
  return placeholder;
}

/**
 * Returns { body, text } to send: sealed for verified phones when any exist, otherwise the plain body
 * and null text. `cardId` is the card being updated or ended (null for a start).
 */
export async function sealCardRequest({ body, cardId, key, client, config, dependencies, notes, deviceIds }) {
  const trust = await trustFor({ client, config, dependencies, notes });
  if (!trust) return { body, text: null };
  const { store, devices } = trust;
  const { eligible } = sealablePhones(store, config.apiUrl, devices, deviceIds);
  if (eligible.length === 0) return { body, text: null };
  const previous = cardId ? await loadCardText(sealedCardDirectory(dependencies.env), cardId) : null;
  const text = mergedCardText(previous, body);
  // The card's project, topic and task go to the server as handles; the phone gets the names (E2.5).
  const identity = await opaqueIdentity(store, body.context, dependencies);
  const named = Object.keys(identity.names).length && Buffer.byteLength(JSON.stringify({ ...text, names: identity.names })) <= 760
    ? { ...text, names: identity.names } : text;
  const sealed = sealNotice({ kind: "card", sender: identityKeys(store), idempotencyKey: key, phones: eligible,
    content: named, alert: named });
  const placeholder = placeholderCardBody(body);
  if (identity.context) placeholder.context = identity.context;
  return { body: { ...placeholder, sealed }, text };
}

/** The card's real step labels when this computer sealed it, else the server's. */
export async function cardStepLabelsFor(cardId, serverLabels, dependencies) {
  const cached = await loadCardText(sealedCardDirectory(dependencies.env), cardId);
  return Array.isArray(cached?.steps) && cached.steps.length === serverLabels?.length ? cached.steps : serverLabels;
}
