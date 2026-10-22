// The producer's own sealed copy of a work (plan 2.21, EDGE.4). On an end-to-end account the server never
// sees a work's text; this computer keeps it in the per-session state file (the working copy). When that
// file is lost (deleted, a new process after a crash) the next command rebuilds the text from this copy,
// which the server stores opaquely as `producer_sealed` and returns only on the session's own reads.
//
// AES-256-GCM under subkey(identity, "work-self"): only this computer can open it. It does not widen the
// phones' recipient set and needs no prekey for the computer.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { b64u, fromB64u } from "./e2ee.mjs";
import { identityKeys, keyStorePath, loadKeyStore, subkey } from "./keystore.mjs";

const SELF_COPY_VERSION = "relo.work-self.v1";
const AAD = Buffer.from(SELF_COPY_VERSION);

export const selfKey = (identityPrivateKey) => subkey(identityPrivateKey, "work-self");
const keyIdOf = (key) => b64u(createHash("sha256").update(key).digest().subarray(0, 8));

/** The text a work's self copy holds: goal, spoken name, status, waiting reason and step labels by id. */
export function selfCopyText(work) {
  const labels = Object.fromEntries((work?.plan?.steps ?? []).filter((step) => step.label != null).map((step) => [step.id, step.label]));
  const details = Object.fromEntries((work?.plan?.steps ?? []).filter((step) => step.detail).map((step) => [step.id, step.detail]));
  const rounds = Object.fromEntries((work?.plan?.rounds ?? []).filter((round) => round.title || round.outcome).map((round) => [round.n, { ...(round.title ? { title: round.title } : {}), ...(round.outcome ? { outcome: round.outcome } : {}) }]));
  const waiting = work?.waiting && typeof work.waiting === "object" ? work.waiting.reason : work?.waiting;
  return {
    ...(work?.goal ? { goal: work.goal } : {}),
    ...(work?.spokenName ? { name: work.spokenName } : {}),
    ...(work?.status ? { status: work.status } : {}),
    ...(waiting ? { waiting } : {}),
    labels,
    ...(Object.keys(details).length ? { details } : {}),
    ...(Object.keys(rounds).length ? { rounds } : {}),
  };
}

export function sealSelfCopy(key, text) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(text), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { v: SELF_COPY_VERSION, kid: keyIdOf(key), nonce: b64u(nonce), ciphertext: b64u(ciphertext) };
}

/** The copy's text, or null when it is not this computer's (another key, tampered, unknown version). */
function openSelfCopy(key, envelope) {
  if (!key || envelope?.v !== SELF_COPY_VERSION || envelope.kid !== keyIdOf(key)) return null;
  try {
    const nonce = fromB64u(envelope.nonce, { length: 12 });
    const data = fromB64u(envelope.ciphertext);
    if (data.length < 17) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(AAD);
    decipher.setAuthTag(data.subarray(data.length - 16));
    const text = JSON.parse(Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8"));
    return text && typeof text === "object" ? text : null;
  } catch {
    return null;
  }
}

/** This computer's self-copy key, read locally (no request), or null without an identity. */
export async function loadSelfKey(dependencies) {
  if (typeof dependencies?.configPath !== "function") return null;
  try {
    const store = await loadKeyStore(keyStorePath(dependencies.configPath(), dependencies.env));
    return store?.identity ? selfKey(identityKeys(store).privateKey) : null;
  } catch {
    return null;
  }
}

/** A plan's step labels and details, and round titles and outcomes, from the self copy's text. */
export function restoredPlan(plan, text) {
  const labels = text.labels ?? {};
  const details = text.details ?? {};
  return {
    ...plan,
    steps: (plan.steps ?? []).map((step) => ({ ...step, label: step.label ?? labels[step.id] ?? null, ...(step.detail ?? details[step.id] ? { detail: step.detail ?? details[step.id] } : {}) })),
    ...(plan.rounds ? { rounds: plan.rounds.map((round) => ({ ...round, ...(text.rounds?.[round.n] ?? {}), ...(round.title ? { title: round.title } : {}), ...(round.outcome ? { outcome: round.outcome } : {}) })) } : {}),
  };
}

/** Fills a work's missing text (goal, status, waiting, labels) from its self copy; the rest is the server's. */
export function restoreFromSelfCopy(work, key) {
  if (!work?.producerSealed || !key) return work;
  const text = openSelfCopy(key, work.producerSealed);
  if (!text) return work;
  const waiting = work.waiting && typeof work.waiting === "object" && work.waiting.reason == null && text.waiting
    ? { ...work.waiting, reason: text.waiting } : work.waiting;
  return {
    ...work,
    goal: work.goal ?? text.goal ?? null,
    ...(work.spokenName ?? text.name ? { spokenName: work.spokenName ?? text.name } : {}),
    status: work.status ?? text.status ?? null,
    waiting,
    plan: work.plan ? restoredPlan(work.plan, text) : work.plan,
  };
}
