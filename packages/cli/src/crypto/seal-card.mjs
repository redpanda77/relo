// Seals Live Activity card text for this computer's verified phones (docs/ENCRYPTION-PROTOCOL.md, E5).
//
// The server receives placeholders ("Encrypted card", "Updating…", "Step 1"…) and one envelope per
// phone; the widget opens it on the phone. An update may change one field, but the phone needs the
// whole card each time, so the CLI keeps each card's text in a private local cache (0600, removed
// when the card ends) and seals the merged text. Counts and progress numbers stay readable.
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../shared/atomic-write.mjs";
import { identityKeys } from "./keystore.mjs";
import { noRecipientReason, opaqueIdentity, sealRecipients, sealingUnavailable, sealNotice, skippedNote, trustFor } from "./seal-notice.mjs";
import { loadKnownNames } from "./opaque-names.mjs";
import { sealedCardDirectory } from "./paths.mjs";
import { ReloError } from "../shared/errors.mjs";

export const SEALED_CARD_TITLE = "Encrypted card";
export const SEALED_CARD_STATUS = "Updating…";
// Two budgets: the alert rides in the push (the server caps its envelope at 1,800 bytes), so it keeps the card
// small; the content is fetched by the app and carries the whole plan, every label in full.
const MAX_CARD_TEXT_BYTES = 700;
export const MAX_CARD_CONTENT_BYTES = 64_000;
const CARD_ID = /^act_[0-9a-f-]{36}$/u;

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
  await writeFileAtomic(join(directory, `${cardId}.json`), JSON.stringify(text));
}

export async function forgetCardText(directory, cardId) {
  if (CARD_ID.test(cardId ?? "")) await rm(join(directory, `${cardId}.json`), { force: true });
}

const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 60_000;

/**
 * Runs `action` holding this card's text lock (an exclusive lock file next to the cache), so two
 * commands on one card never both read the old text and the later save drops the earlier change.
 * The lock spans read, seal, send and save. Without a writable cache folder it runs unlocked.
 */
export async function withCardTextLock(directory, cardId, action, { sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  if (!CARD_ID.test(cardId ?? "")) return action();
  const path = join(directory, `${cardId}.lock`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch {
    return action();
  }
  const deadline = Date.now() + LOCK_WAIT_MS;
  let handle;
  for (;;) {
    try {
      handle = await open(path, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") return action();
      const info = await stat(path).catch(() => null);
      // A lock left by a crashed command: no request holds it this long.
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) { await rm(path, { force: true }); continue; }
      if (Date.now() > deadline) {
        throw new ReloError("Another relo command is still updating this card.", { code: "CARD_TEXT_LOCKED",
          details: { hint: "Retry in a few seconds with the same command" } });
      }
      await sleep(25);
    }
  }
  try {
    return await action();
  } finally {
    await handle.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
  }
}

/** The request body without the CLI's own bookkeeping fields. */
function serverCardBody(body) {
  if (!body?.steps?.labelsFromServer) return body;
  const { labelsFromServer: _local, ...steps } = body.steps;
  return { ...body, steps };
}

/**
 * The card text after this command: the previous text with this command's fields applied.
 * Step labels the CLI only read back from the server (placeholders on a sealed card) are never
 * sealed as the card's text: the phone keeps the labels it has and moves only the current step.
 */
export function mergedCardText(previous, body, reserved = 0) {
  const { names: _names, ...earlier } = previous ?? {};
  const text = { ...earlier };
  for (const field of ["title", "status", "detail", "progressLabel"]) {
    if (body[field] === null) delete text[field];
    else if (typeof body[field] === "string") text[field] = body[field];
  }
  if (Array.isArray(body.steps?.labels)) {
    if (!body.steps.labelsFromServer) text.steps = [...body.steps.labels];
    else if (text.steps?.length !== body.steps.labels.length) delete text.steps;
  }
  return fitCardText(text, MAX_CARD_CONTENT_BYTES - reserved);
}

/**
 * Keeps sealed card text within `limit`: the push alert's small budget by default, the fetched content's large one
 * when given. Card text v2 (phases) loses its
 * earlier rounds first: their step details, then their step labels, then the oldest rounds whole; the last
 * round (the one on show) is touched only after that, then the v1 trims.
 */
export function fitCardText(text, limit = MAX_CARD_TEXT_BYTES) {
  const fitted = { ...text };
  const size = () => Buffer.byteLength(JSON.stringify(fitted));
  const shorten = (value, length) => ([...value].length > length ? `${[...value].slice(0, length - 1).join("")}…` : value);
  if (Array.isArray(fitted.phases)) {
    fitted.phases = fitted.phases.map((phase) => ({ ...phase, ...(phase.steps ? { steps: phase.steps.map((step) => ({ ...step })) } : {}) }));
    const earlier = () => fitted.phases.slice(0, -1);
    if (size() > limit) for (const phase of earlier()) for (const step of phase.steps ?? []) delete step.detail;
    if (size() > limit) for (const phase of earlier()) delete phase.steps;
    while (size() > limit && fitted.phases.length > 1) fitted.phases.shift();
    const last = fitted.phases[fitted.phases.length - 1];
    if (size() > limit && last?.outcome) last.outcome = shorten(last.outcome, 80);
    if (size() > limit) for (const step of last?.steps ?? []) delete step.detail;
    if (size() > limit && last?.steps) for (const step of last.steps) if (step.label) step.label = shorten(step.label, 14);
    if (size() > limit && last?.title) last.title = shorten(last.title, 30);
    if (size() > limit && fitted.status) fitted.status = shorten(fitted.status, 60);
  }
  if (size() > limit && fitted.detail) fitted.detail = shorten(fitted.detail, 80);
  if (size() > limit) delete fitted.detail;
  if (size() > limit) delete fitted.progressLabel;
  if (size() > limit && fitted.steps) fitted.steps = fitted.steps.map((label) => shorten(label, 14));
  if (size() > limit && fitted.title) fitted.title = shorten(fitted.title, 40);
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
  if (!trust) return { body: serverCardBody(body), text: null };
  const { store } = trust;
  const { eligible, readers, skipped } = await sealRecipients({ trust, client, config, deviceIds });
  if (eligible.length === 0) {
    if (trust.committed) throw sealingUnavailable(noRecipientReason(skipped));
    return { body: serverCardBody(body), text: null };
  }
  // Like notify and ask: a phone that cannot open the card is named, with why, never dropped silently.
  if (skipped.length) notes?.push(skippedNote("card", eligible, skipped));
  const previous = cardId ? await loadCardText(sealedCardDirectory(dependencies), cardId) : null;
  // The card's project, topic and task go to the server as handles; the phone gets the names (E2.5).
  // Every update carries them (from this command or the card's cache), so the phone always can name them.
  const identity = await opaqueIdentity(store, body.context, dependencies);
  let names = { ...(previous?.names ?? {}), ...identity.names };
  if (Object.keys(names).length === 0 && cardId) names = await namesForCard(client, cardId, dependencies);
  const text = { ...mergedCardText(previous, body, Buffer.byteLength(JSON.stringify(names))), ...(Object.keys(names).length ? { names } : {}) };
  const sealed = sealNotice({ kind: "card", sender: identityKeys(store), idempotencyKey: key, phones: eligible, readers,
    content: text, alert: fitCardText(text, MAX_CARD_TEXT_BYTES) });
  const placeholder = placeholderCardBody(serverCardBody(body));
  if (identity.context) placeholder.context = identity.context;
  return { body: { ...placeholder, sealed }, text };
}

/**
 * The card's real step labels when this computer sealed it and its cache matches the card, else
 * undefined: a missing or mismatched cache never stands in for labels (the server's may be placeholders).
 */
export async function cachedStepLabels(cardId, count, dependencies) {
  const cached = await loadCardText(sealedCardDirectory(dependencies), cardId);
  return Array.isArray(cached?.steps) && cached.steps.length === count ? cached.steps : undefined;
}

/** Names this computer knows for the handles in a card's context (a card sealed before names travelled). */
async function namesForCard(client, cardId, dependencies) {
  try {
    const context = (await client.getActivity(cardId))?.activity?.context ?? {};
    const known = await loadKnownNames(dependencies);
    return Object.fromEntries(Object.values(context).filter((value) => typeof value === "string" && known[value])
      .map((handle) => [handle, known[handle]]));
  } catch {
    return {};
  }
}
