// Sealed works (STATE-SPEC v2, contracts/works.ts): on an end-to-end account the server never sees the
// goal, status, outcome, waiting reason or step labels. Those travel as {sealed: true}; plan entries carry
// predicted ids only; `sealed` holds the card text (kind "card", the envelope the iPhone widget opens:
// title/status/steps) for the work's card.
import { randomUUID } from "node:crypto";
import { identityKeys } from "./keystore.mjs";
import { MAX_CARD_CONTENT_BYTES, fitCardText } from "./seal-card.mjs";
import { opaqueIdentity, sealablePhones, sealingUnavailable, sealNotice, skippedNote, trustFor } from "./seal-notice.mjs";
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
      // The content (fetched by the app) holds every label in full; only the push alert is trimmed to its budget.
      const clean = Object.fromEntries(Object.entries(text).filter(([, value]) => value !== undefined && value !== null));
      const content = fitCardText(clean, MAX_CARD_CONTENT_BYTES);
      return sealNotice({ kind: "card", sender, idempotencyKey: `relo-work:${randomUUID()}`, phones: eligible, readers, content, alert: fitCardText(clean), names });
    },
    /**
     * The outcome notification of a deliver or finish, sealed on its own (kind "notice": title and outcome, as
     * `relo notify` seals). Never the card's envelopes: the phone opens those as a card, not as a notification.
     */
    outcome({ title, summary }) {
      const clean = (value) => (value === undefined || value === null ? undefined : String(value));
      const head = [...(clean(title) ?? "Relo")];
      const content = { title: head.length > 80 ? `${head.slice(0, 79).join("")}…` : head.join(""), ...(clean(summary) ? { summary: clean(summary) } : {}) };
      return sealNotice({ kind: "notice", sender, idempotencyKey: `relo-work-outcome:${randomUUID()}`, phones: eligible, readers, content });
    },
    /** The work context with project, topic and computer names as handles (E2.5), and the names to seal. */
    opaque: (context) => opaqueIdentity(store, context, dependencies),
  };
}

/**
 * The card text of a work as the phone shows it, v2: goal, status (or what it waits on) and the plan as
 * phases, one per round (`r<n>`), each with its title, its outcome once closed and its steps by id
 * ({ id, label, detail? }). The phone matches labels by step id (ReloSealedCards.swift); a step without a
 * label reads "Step n". Round 1 is titled by the goal, which is the card's own title, so it carries none.
 * `stepId` is the current leaf step's id, sent with the status so the phone can group a work's updates by step
 * (plan UX 4.6); absent when no step is current. `spoken` is the line Relo for Mac says aloud for a deliver or a
 * finish (`--say`): it lives only in this sealed text, so the server never holds it, and the next update's card
 * (built from the work again) leaves it out.
 */
export function workCardText(work, { status, spoken } = {}) {
  // Skipped steps keep their labels: the server still lists them (by id) and the phone shows them behind its
  // "n skipped" row, so a label left out reads "Not readable on this phone" on the owner's own phone.
  const steps = work?.plan?.steps ?? [];
  const waiting = work?.waiting && typeof work.waiting === "object" ? work.waiting.reason : work?.waiting;
  const rounds = work?.plan?.rounds ?? (steps.length ? [{ n: 1, state: "open" }] : []);
  const phases = rounds.map((round) => ({
    id: `r${round.n}`,
    ...(round.title ? { title: round.title } : {}),
    ...(round.outcome ? { outcome: round.outcome } : {}),
    steps: steps.filter((step) => (step.round ?? 1) === round.n).map((step, index) => ({ id: step.id, label: step.label ?? `Step ${index + 1}`, ...(step.detail ? { detail: step.detail } : {}) })),
  }));
  const current = (work?.plan?.steps ?? []).find((step) => step.state === "current");
  return {
    title: work?.goal ?? undefined,
    // ADR 0015: how the work is called aloud ("Needs you: <name>."), declared with relo work start|update --spoken-name.
    ...(work?.spokenName ? { name: work.spokenName } : {}),
    // ADR 0015 revision 1: how much Relo for Mac may say of it (off|brief|full|verbose), from this computer's settings.
    ...(work?.voice ? { voice: work.voice } : {}),
    status: status ?? (waiting ? `Waiting on ${waiting}` : work?.status ?? undefined),
    ...(current ? { stepId: current.id } : {}),
    ...(spoken ? { spoken } : {}),
    ...(phases.some((phase) => phase.steps.length || phase.outcome) ? { phases } : {}),
  };
}

export const SEALED = Object.freeze({ sealed: true });
