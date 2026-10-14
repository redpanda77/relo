// Sealed works (STATE-SPEC v2, contracts/works.ts): on an end-to-end account the server never sees the
// goal, status, outcome, waiting reason or step labels. Those travel as {sealed: true}; plan entries carry
// predicted ids only; `sealed` holds the card text (kind "card", the envelope the iPhone widget opens:
// title/status/steps) for the work's card.
import { randomUUID } from "node:crypto";
import { identityKeys } from "../keystore.mjs";
import { fitCardText } from "../seal-card.mjs";
import { opaqueIdentity, sealablePhones, sealingUnavailable, sealNotice, skippedNote, trustFor } from "../seal-notice.mjs";
import { sealSelfCopy, selfKey } from "./self-copy.mjs";

/**
 * Resolves once per command: null when this computer seals for no phone (readable work), else
 * { seal(cardText) } returning the `sealed` object for a work request, and { self(copyText) } returning the
 * producer's own copy (`producerSealed`, plan 2.21) that only this computer opens.
 */
export async function workSealer({ client, config, dependencies, notes = [] }) {
  if (!config?.apiUrl || typeof dependencies?.configPath !== "function") return null;
  const trust = await trustFor({ client, config, dependencies, notes });
  if (!trust) return null;
  const { store, devices } = trust;
  const { eligible, readers, skipped } = sealablePhones(store, config.apiUrl, devices);
  if (eligible.length === 0) {
    if (trust.committed) throw sealingUnavailable("no trusted phone has a current key");
    return null;
  }
  if (skipped.length) notes.push(skippedNote("card", eligible, skipped));
  const sender = identityKeys(store);
  const own = selfKey(sender.privateKey);
  return {
    self: (text) => sealSelfCopy(own, text),
    /** `names`: the handle → name map for the work's opaque context, so the phone shows the names. */
    seal(text, names) {
      const content = fitCardText(Object.fromEntries(Object.entries(text).filter(([, value]) => value !== undefined && value !== null)));
      return sealNotice({ kind: "card", sender, idempotencyKey: `relo-work:${randomUUID()}`, phones: eligible, readers, content, alert: content, names });
    },
    /** The work context with project, topic and computer names as handles (E2.5), and the names to seal. */
    opaque: (context) => opaqueIdentity(store, context, dependencies),
  };
}

/** The card text of a work as the phone shows it: goal, status (or what it waits on), visible step labels. */
export function workCardText(work, { status } = {}) {
  const visible = (work?.plan?.steps ?? []).filter((step) => step.state !== "skipped");
  const waiting = work?.waiting && typeof work.waiting === "object" ? work.waiting.reason : work?.waiting;
  const labels = visible.map((step, index) => step.label ?? `Step ${index + 1}`);
  return {
    title: work?.goal ?? undefined,
    status: status ?? (waiting ? `Waiting on ${waiting}` : work?.status ?? undefined),
    ...(labels.length ? { steps: labels } : {}),
  };
}

export const SEALED = Object.freeze({ sealed: true });
