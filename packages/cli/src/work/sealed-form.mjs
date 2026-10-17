// The two wire forms of a declared write, shared by every producer type that seals (agents and scripts):
// readable text as {readable}, or the same body with its text as {sealed: true} and plan entries as step
// ids only (the labels ride the sealed card and the producer's self copy). work/declared-lane.mjs
// `materialize` picks the form when the write is sent.
import { SEALED } from "../crypto/seal-work.mjs";

/** Declared text on the wire (contracts/works.ts declaredTextSchema). */
export const readable = (text) => ({ readable: text });

/** The same body with its text as {sealed: true}. */
export function sealedText(body) {
  const out = { ...body };
  for (const key of ["goal", "status", "outcome"]) if (out[key]) out[key] = SEALED;
  if (out.waiting) out.waiting = { reason: SEALED };
  return out;
}

/** A tree of { id, children? } as plan entries by id only: what a sealed work sends in place of labels. */
export const idEntries = (tree) => tree.map((node) => ({ id: node.id, ...(node.children?.length ? { children: idEntries(node.children) } : {}) }));

/**
 * A start's sealed form: its plan names the step ids the server will give (s1…sN, or from the work's next id
 * when it opens a round), in pre-order. `steps` is a list of labels (flat plans) or the tree from startPlan /
 * openRoundPlan. A `round` title goes sealed too.
 */
export function sealedStart(body, steps) {
  const entries = steps.length && typeof steps[0] === "object" ? idEntries(steps) : steps.map((_, index) => ({ id: `s${index + 1}` }));
  return { ...sealedText(body), ...(body.round ? { round: SEALED } : {}), ...(body.plan ? { plan: { op: "set", steps: entries } } : {}) };
}

/**
 * An update request's sealed form. With the update's `trees` (applyChange) a revise or set becomes the set of
 * the steps it listed, an add names the new ids, a detail travels only in the card text. Without them (scripts)
 * a revise becomes the set of the steps left (by id), an add names the new ids; with `replaced` (the update
 * also sent --plan) the set already lists the added steps.
 */
export function sealedUpdate(body, { final, known, replaced = false, trees }) {
  const sealed = sealedText(body);
  if (trees) {
    if (sealed.plan?.op === "revise" || sealed.plan?.op === "set") sealed.plan = { op: "set", steps: idEntries(trees.plan ?? []) };
    else if (sealed.plan?.op === "add") sealed.plan = { op: "add", steps: idEntries(trees.add ?? []), ...(sealed.plan.under ? { under: sealed.plan.under } : {}), ...(sealed.plan.after ? { after: sealed.plan.after } : {}) };
    else if (sealed.plan?.op === "detail") delete sealed.plan;
    return sealed;
  }
  if (sealed.plan?.op === "revise") {
    sealed.plan = { op: "set", steps: final.filter((step) => step.state !== "done" && step.state !== "skipped").map((step) => ({ id: step.id })) };
  } else if (sealed.plan?.op === "add") {
    if (replaced) delete sealed.plan;
    else sealed.plan = { op: "add", steps: final.filter((step) => !known.has(step.id)).map((step) => ({ id: step.id })) };
  }
  return sealed;
}
