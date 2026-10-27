// The CLI's side of a work's plan. The rules (ids, nesting, rounds, the current step, progress, times) are the
// contracts plan engine itself (shared/plan-engine.generated.mjs, generated from packages/contracts/src/plan-engine.ts)
// and are applied here exactly as the server applies them, so local ids and states cannot drift from the
// server's. What stays here is CLI-only: parsing --plan/--add text, matching a typed label to a step, the
// refusals in the three-line shape, and turning one update into the engine commands it sends.
import { FACTS } from "../shared/facts.generated.mjs";
import {
  applyPlanCommand, closePlan, currentPath as enginePath, droppedLeaves, EMPTY_WORK_PLAN, lastRound as engineLastRound, leafIds, openRound as engineOpenRound,
  planLineText, planProgress, setCurrentStepProgress, stepDepth, stepRound,
} from "../shared/plan-engine.generated.mjs";
import { WorkRefusal } from "./refusal.mjs";

const MAX_DEPTH = FACTS.work.planMaxDepth;

const norm = (label) => String(label ?? "").trim().replace(/\s+/gu, " ").toLowerCase();

// The local plan is { version, next, steps, rounds? }: the engine's plan plus the plan version the server counts.
const planNext = (plan) => plan.next ?? plan.nextId ?? (plan.steps?.length ?? 0) + 1;
const clone = (plan) => (plan ? { ...plan, version: plan.version ?? 0, next: planNext(plan), steps: (plan.steps ?? []).map((s) => ({ ...s })), ...(plan.rounds ? { rounds: plan.rounds.map((r) => ({ ...r })) } : {}) } : null);
const toEngine = (plan) => ({ v: 1, next: planNext(plan), steps: (plan.steps ?? []).map((s) => ({ ...s })), ...(plan.rounds ? { rounds: plan.rounds.map((r) => ({ ...r })) } : {}) });
const fromEngine = (local, engine, structural) => {
  const { v, ...rest } = engine;
  return { ...local, ...rest, version: (local.version ?? 0) + (structural ? 1 : 0) };
};

export function parseCount(value, state = "nothing open") {
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/u.exec(String(value));
  const done = match ? Number(match[1]) : NaN;
  const total = match ? Number(match[2]) : NaN;
  if (!match || total < 1 || done > total || total > 100_000) {
    throw new WorkRefusal("REFUSED_PROGRESS", { what: "--progress takes a count like 3/10; a percentage is not a count", state, next: "relo work update --progress 4/10" });
  }
  return { done, total };
}

/**
 * Step labels from one --plan/--add value (DOGFOOD #15). One per line when the value has line breaks;
 * otherwise comma-separated, where a comma inside (), [] or quotes belongs to the label
 * ("Install iPhone 0.10.0 (owner, later)" stays one step). Unbalanced brackets are refused: the split would be a guess.
 */
export function splitLabels(value, state = "nothing open") {
  const text = String(value ?? "");
  if (/[\r\n]/u.test(text)) return text.split(/\r?\n/u).map((part) => part.trim().replace(/\s+/gu, " ")).filter(Boolean);
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  const ambiguous = () => new WorkRefusal("REFUSED_PLAN_LIST", { what: `--plan "${text}" has an unclosed bracket or quote, so where one step ends is a guess`, state, next: "close the bracket, or give one step per line (a newline-separated --plan value)" });
  for (const ch of text) {
    if (quote) { if (ch === quote) quote = null; current += ch; continue; }
    if (ch === '"') { quote = ch; current += ch; continue; }
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") { depth -= 1; if (depth < 0) throw ambiguous(); }
    if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  if (depth !== 0 || quote) throw ambiguous();
  parts.push(current);
  return parts.map((part) => part.trim().replace(/\s+/gu, " ")).filter(Boolean);
}

const asEntry = (x) => (typeof x === "string" ? { label: x } : x);
const roundOf = stepRound;
const entryDepth = (entries) => 1 + Math.max(0, ...entries.map((e) => (e.children?.length ? entryDepth(e.children) : 0)));
const flatten = (entries) => entries.flatMap((e) => [e, ...(e.children ? flatten(e.children) : [])]);
/** Every label of a plan value in pre-order (for the content filter, split warnings and the card). */
export const entryLabels = (entries) => flatten(entries.map(asEntry)).map((e) => e.label);
function deepRefusal(label, state, next) {
  return new WorkRefusal("REFUSED_PLAN_DEPTH", { what: `step "${label}" would sit deeper than ${MAX_DEPTH} levels (a step, its child, its grandchild)`, state, next: next ?? "relo work update --plan with fewer levels, or --add the deeper steps as steps of their own" });
}

/** The last round, or the implicit open round 1 of a plan without a rounds array. */
export const lastRound = (plan) => engineLastRound(plan ?? { v: 1, next: 1, steps: [] });
export const openRound = (plan) => engineOpenRound(plan ?? { v: 1, next: 1, steps: [] });
/** The open work's last round is closed: the owner's turn (a finished work is not "delivered"). */
export const isDelivered = (work) => Boolean(work) && work.lifecycle !== "finished" && !work.result && work.plan?.rounds?.[work.plan.rounds.length - 1]?.state === "closed";
/** The current step with its ancestors, top first (empty when nothing is current). */
export const currentPath = (plan) => enginePath(plan ?? { v: 1, next: 1, steps: [] });
export const depthOf = (plan, step) => stepDepth(plan, step);
const roundSteps = (plan) => { const n = (openRound(plan) ?? lastRound(plan)).n; return (plan?.steps ?? []).filter((s) => roundOf(s) === n); };


/**
 * A --plan/--add value as entries { label, children? }. A value with line breaks may nest by indentation (two
 * spaces or one tab per level); a single line keeps the comma and bracket rules of splitLabels. More than
 * three levels is refused.
 */
export function parsePlan(value, state = "nothing open") {
  const text = String(value ?? "");
  if (!/[\r\n]/u.test(text)) return splitLabels(text, state).map((label) => ({ label }));
  const entries = [];
  const stack = [];
  let base;
  for (const raw of text.split(/\r?\n/u)) {
    const label = raw.trim().replace(/\s+/gu, " ");
    if (!label) continue;
    const lead = /^[ \t]*/u.exec(raw)[0];
    const tabs = (lead.match(/\t/gu) ?? []).length;
    // The first line sets the top level (a value indented as a whole is still one list).
    const indent = tabs + Math.floor((lead.length - tabs) / 2);
    base ??= indent;
    const level = Math.min(Math.max(0, indent - base), stack.length);
    if (level + 1 > MAX_DEPTH) throw deepRefusal(label, state, 'relo work update --plan "…" with at most three levels of indentation, or add the deeper steps as steps of their own');
    const entry = { label };
    if (level === 0) entries.push(entry);
    else (stack[level - 1].children ??= []).push(entry);
    stack.length = level;
    stack.push(entry);
  }
  return entries;
}

const empty = () => ({ skipped: [], done: [], reopened: [], added: [] });
// Closed rounds are pruned first when a plan is over its size, so a refusal means the open round alone is too long.
export const OPEN_STEPS_NEXT = 'the owner must act mid-plan: relo ask "…" --approval  |  relo work update --waiting "…"   or this request is done: relo work update --plan "<what\'s left>" then deliver, or relo work deliver --outcome "…" --drop-rest (closes it, skips these steps, and a next round carries them)';
const PLAN_NEXT = 'relo work update --plan "<fewer, larger steps for this round>"';

/** An engine refusal in the three-line shape. */
function refusalOf(failure, state) {
  switch (failure.code) {
    case "plan_too_long": return new WorkRefusal("REFUSED_PLAN_SIZE", { what: failure.message, state, next: PLAN_NEXT });
    case "plan_too_deep": return new WorkRefusal("REFUSED_PLAN_DEPTH", { what: failure.message, state, next: "relo work update --plan with fewer levels, or --add the deeper steps as steps of their own" });
    case "step_not_found": return new WorkRefusal("REFUSED_UNKNOWN_STEP", { what: failure.message, state, next: 'relo work update --add "…"' });
    case "no_open_round": return new WorkRefusal("REFUSED_ROUND_CLOSED", { what: failure.message, state, next: 'relo work start --round "<the request in a few words>" --plan "…"  |  relo work finish --outcome "…"' });
    case "round_open": return new WorkRefusal("REFUSED_ROUND_OPEN", { what: failure.message, state, next: 'relo work deliver --outcome "…"' });
    case "open_steps": return new WorkRefusal("REFUSED_OPEN_STEPS", { what: `${failure.message}; delivering means this request is done`, state, next: OPEN_STEPS_NEXT });
    default: return new WorkRefusal("REFUSED_PLAN_INVALID", { what: failure.message, state, next: "relo state" });
  }
}

/** One engine command on a local plan: the same call the server makes. Returns the new local plan. */
function apply(local, command, state, now) {
  const result = applyPlanCommand(toEngine(local), command, (local.version ?? 0) + 1, { sealed: false, ...(now ? { now } : {}) });
  if (!result.ok) throw refusalOf(result, state);
  return fromEngine(local, result.plan, result.structural);
}

/** Predicted ids for a tree of new entries: pre-order from the plan's next id (what the engine will assign). */
function grow(next, entries) {
  const tree = [];
  let at = next;
  const visit = (list, out) => {
    for (const raw of list) {
      const entry = asEntry(raw);
      const node = { id: `s${at}`, label: entry.label, ...(entry.detail ? { detail: entry.detail } : {}), isNew: true };
      at += 1;
      out.push(node);
      if (entry.children?.length) visit(entry.children, (node.children = []));
    }
  };
  visit(entries, tree);
  return { tree, next: at };
}

/** A tree of { id, label, isNew, detail?, children? } as plan entries: kept steps by id, new ones by label. */
export function wireEntries(tree) {
  return tree.map((node) => ({ ...(node.isNew ? { label: node.label, ...(node.detail ? { detail: node.detail } : {}) } : { id: node.id }), ...(node.children?.length ? { children: wireEntries(node.children) } : {}) }));
}

export function startPlan(entries, progress, state = "nothing open") {
  if (!entries?.length) return { plan: null, notes: [], moved: empty(), tree: [] };
  if (entryDepth(entries.map(asEntry)) > MAX_DEPTH) throw deepRefusal(entryLabels(entries)[0], state);
  const { tree } = grow(1, entries);
  let plan = apply({ version: 0, next: 1, steps: [] }, { op: "set", steps: wireEntries(tree) }, state);
  if (progress) plan = withProgress(plan, progress, state);
  const moved = empty();
  moved.added = plan.steps.map((s) => s.id);
  return { plan, notes: [], moved, tree };
}

function withProgress(plan, progress, state) {
  const updated = setCurrentStepProgress(toEngine(plan), progress);
  if (!updated) throw new WorkRefusal("REFUSED_NO_CURRENT", { what: "no step is current, so the count has nowhere to go", state: `${state}, plan complete`, next: 'relo work update --add "…" --progress 0/6' });
  return { ...plan, steps: updated.steps };
}

/** Where the work stands in the round on show: the current leaf, and the one count of plan UX rule U1. */
export function position(plan) {
  const progress = planProgress(plan ?? EMPTY_WORK_PLAN);
  const current = (plan?.steps ?? []).find((s) => s.state === "current" && roundOf(s) === progress.round);
  const open = (plan?.steps ?? []).filter((s) => roundOf(s) === progress.round && s.state === "open" && !(plan.steps ?? []).some((k) => k.parent === s.id));
  return { index: progress.done + 1, toGo: open.length, total: progress.total, complete: Boolean(openRound(plan)) && progress.state === "complete", current, progress };
}

/** U2: the one plan line (the same words as the Lock Screen), from the contracts rule; "" without a plan. */
export function planLine(work) {
  const plan = work?.plan;
  if (!plan?.steps?.length) return "";
  const ended = work.result ?? (work.lifecycle === "finished" ? "finished" : undefined);
  const progress = planProgress(plan, { stopped: ended === "failed" || ended === "dropped" });
  const labels = new Map(plan.steps.map((s) => [s.id, s.label]));
  return planLineText(progress, (id) => labels.get(id), { paused: work.lifecycle === "paused", ...(ended ? { ended } : {}) });
}

function find(plan, x, labelsKnown, state) {
  const inRound = roundSteps(plan);
  if (/^s\d+$/u.test(x)) return inRound.find((s) => s.id === x) ?? plan.steps.find((s) => s.id === x);
  if (!labelsKnown) {
    throw new WorkRefusal("REFUSED_LABELS_UNKNOWN", { what: "this computer cannot read this work's step names (it was started elsewhere), so steps can't be matched by name", state: `steps by id: ${roundSteps(plan).map((s) => `${s.id} (${s.state})`).join(", ")}`, next: 'relo work update --step s3  |  relo work update --add "…"' });
  }
  const matches = inRound.filter((s) => norm(s.label) === norm(x));
  return matches.find((s) => s.state !== "skipped") ?? matches[0];
}

function needOpenRound(plan, state, what) {
  if (!plan?.rounds || openRound(plan)) return;
  const last = plan.rounds[plan.rounds.length - 1];
  throw new WorkRefusal("REFUSED_ROUND_CLOSED", { what: `round ${last.n} is delivered, so there are no steps to ${what}`, state: `${state}, round ${last.n} delivered`, next: 'relo work start --round "<the request in a few words>" --plan "…"  |  relo work finish --outcome "…"' });
}

const stateOf = (plan) => new Map((plan?.steps ?? []).map((s) => [s.id, s.state]));

/**
 * Applies one update's plan changes in the fixed order: next-step, plan, add (under), step, detail, progress.
 * `plan` and `add` take labels or entries { label, children? }. Each change becomes the engine command the
 * update sends (planCommands) and is applied with the contracts engine. `trees` name the steps each one listed or
 * created ({ id, label, isNew, children? }), for the commands and the sealed form.
 */
export function applyChange(input, change, labelsKnown = true, state = "nothing open") {
  let plan = clone(input);
  const notes = [];
  const moved = empty();
  const trees = {};
  const before = JSON.stringify(plan);
  const currentOf = () => plan?.steps.find((s) => s.state === "current");
  if (plan && (change.nextStep || change.plan || change.add || change.step || change.detail !== undefined)) needOpenRound(plan, state, change.nextStep ? "move through" : "change");

  if (change.nextStep) {
    if (!plan || plan.steps.length === 0) throw new WorkRefusal("REFUSED_NO_PLAN", { what: "this work has no plan, so there is no next step", state, next: 'relo work update --plan "…"' });
    const current = currentOf();
    if (!current) throw new WorkRefusal("REFUSED_PLAN_COMPLETE", { what: "every step is already done", state: `${state}, plan complete`, next: 'relo work deliver --outcome "…"  |  relo work update --add "…"' });
    moved.done.push(current.id);
    plan = apply(plan, { op: "next" }, state);
  }

  if (change.plan) {
    if (!labelsKnown) find(plan ?? { steps: [] }, "x", false, state);
    plan ??= { version: 0, next: 1, steps: [] };
    const entries = change.plan.map(asEntry);
    if (entryDepth(entries) > MAX_DEPTH) throw deepRefusal(entryLabels(entries)[0], state);
    const n = (openRound(plan) ?? { n: 1 }).n;
    const inRound = plan.steps.filter((s) => roundOf(s) === n);
    const listed = new Set();
    let next = planNext(plan);
    const walk = (list, parentId) => {
      const out = [];
      // An entry matches only a step at its own place in the tree: top level against top-level steps, children against the matched step's.
      const level = inRound.filter((s) => s.parent === parentId);
      for (const entry of list) {
        const existing = level.find((s) => s.state !== "skipped" && norm(s.label) === norm(entry.label)) ?? level.find((s) => norm(s.label) === norm(entry.label));
        if (existing && listed.has(existing.id)) continue;
        let node;
        if (existing) { listed.add(existing.id); node = { id: existing.id, label: existing.label, isNew: false }; }
        else { node = { id: `s${next}`, label: entry.label, ...(entry.detail ? { detail: entry.detail } : {}), isNew: true }; next += 1; }
        out.push(node);
        if (entry.children?.length) node.children = walk(entry.children, node.id);
        // A step listed without children keeps the ones it has: a flat --plan restates the phases, it does not
        // skip their steps. Leaving the step out, or listing its children, is how they change.
        else if (existing) node.children = kept(existing.id);
      }
      return out;
    };
    const kept = (parentId) => {
      const children = inRound.filter((s) => s.parent === parentId && s.state !== "skipped");
      if (children.length === 0) return undefined;
      return children.map((s) => { listed.add(s.id); return { id: s.id, label: s.label, isNew: false, children: kept(s.id) }; });
    };
    trees.plan = walk(entries, undefined);
    const was = stateOf(plan);
    plan = apply(plan, { op: "set", steps: wireEntries(trees.plan) }, state);
    const parents = new Set(plan.steps.map((s) => s.parent).filter(Boolean));
    for (const s of plan.steps) {
      const prior = was.get(s.id);
      if (prior === undefined) { moved.added.push(s.id); continue; }
      if (prior === "skipped" && s.state !== "skipped") moved.reopened.push(s.id);
      else if (s.state === "skipped" && (prior === "open" || prior === "current") && !parents.has(s.id)) {
        moved.skipped.push(s.id);
        notes.push(prior === "current"
          ? `${s.id} ${s.label ?? ""} skipped (left out of --plan; add --next-step to mark it done)`.replace("  ", " ")
          : `skipped ${s.id} ${s.label ?? ""} (left out of --plan)`.replace("  ", " "));
      }
    }
  }

  if (change.add?.length) {
    plan ??= { version: 0, next: 1, steps: [] };
    const entries = change.add.map(asEntry);
    const n = (openRound(plan) ?? { n: 1 }).n;
    const inRound = plan.steps.filter((s) => roundOf(s) === n);
    let parent;
    let anchor;
    if (change.under !== undefined && change.after !== undefined) throw new WorkRefusal("REFUSED_CONTRADICTION", { what: "--under and --after contradict each other: --under makes the new steps children, --after makes them siblings", state, next: `relo work update --add "${entryLabels(entries)[0]}" --after ${change.after}` });
    if (change.after !== undefined) {
      anchor = find(plan, String(change.after), labelsKnown, state);
      if (!anchor || roundOf(anchor) !== n) throw new WorkRefusal("REFUSED_UNKNOWN_STEP", { what: `no step "${change.after}" in this round to add after`, state: `steps: ${inRound.map((s) => `${s.id} ${s.label ?? ""} (${s.state})`).join(", ") || "none"}`, next: `relo work update --add "${entryLabels(entries)[0]}"` });
      if (depthOf(plan, anchor) - 1 + entryDepth(entries) > MAX_DEPTH) throw deepRefusal(entryLabels(entries)[0], state);
    } else if (change.under !== undefined) {
      parent = find(plan, String(change.under), labelsKnown, state);
      if (!parent || roundOf(parent) !== n) throw new WorkRefusal("REFUSED_UNKNOWN_STEP", { what: `no step "${change.under}" in this round to add under`, state: `steps: ${inRound.map((s) => `${s.id} ${s.label ?? ""} (${s.state})`).join(", ") || "none"}`, next: `relo work update --add "${entryLabels(entries)[0]}"` });
      if (depthOf(plan, parent) + entryDepth(entries) > MAX_DEPTH) throw deepRefusal(entryLabels(entries)[0], state);
    } else if (entryDepth(entries) > MAX_DEPTH) throw deepRefusal(entryLabels(entries)[0], state);
    for (const label of entryLabels(entries)) {
      const dup = inRound.find((s) => s.state !== "skipped" && norm(s.label) === norm(label));
      if (dup) throw new WorkRefusal("REFUSED_DUPLICATE_STEP", { what: `step "${label}" is already in the plan (${dup.id})`, state, next: `relo work update --step "${label}"` });
    }
    const grown = grow(planNext(plan), entries);
    trees.add = grown.tree;
    if (parent) moved.under = parent.id;
    if (anchor) moved.after = anchor.id;
    // A finished step that gains substeps is open again: say so, the count drops.
    if (parent && (parent.state === "done" || parent.state === "skipped")) {
      const count = entries.length;
      notes.push(`${parent.id} reopened: ${count} new substep${count === 1 ? "" : "s"}${parent.state === "done" ? " (it counted as done)" : ""}`);
    }
    plan = apply(plan, { op: "add", steps: wireEntries(grown.tree), ...(parent ? { under: parent.id } : {}), ...(anchor ? { after: anchor.id } : {}) }, state);
    const flat = (nodes) => nodes.flatMap((node) => [node.id, ...(node.children ? flat(node.children) : [])]);
    moved.added.push(...flat(grown.tree));
  }

  if (change.step) {
    if (!plan) throw new WorkRefusal("REFUSED_NO_PLAN", { what: "this work has no plan, so there is no step to move to", state, next: 'relo work update --plan "…"' });
    const target = find(plan, change.step, labelsKnown, state);
    if (!target) throw new WorkRefusal("REFUSED_UNKNOWN_STEP", { what: `no step "${change.step}" in this plan`, state: `steps: ${roundSteps(plan).map((s) => `${s.id} ${s.label ?? ""} (${s.state})`).join(", ")}`, next: /^s\d+(\.\d+)*$/u.test(change.step) ? `relo work update --step <one of the listed ids>  (relo state lists them)` : `relo work update --add "${change.step}" --step "${change.step}"` });
    if (plan.steps.some((s) => s.parent === target.id)) {
      const kids = plan.steps.filter((s) => s.parent === target.id).map((s) => s.id);
      throw new WorkRefusal("REFUSED_STEP_HAS_CHILDREN", { what: `step ${target.id} has sub-steps; only a step without them can be current`, state, next: `relo work update --step ${kids[0]}` });
    }
    const current = currentOf();
    if (target.id === current?.id) notes.push(`${target.id} is already current. Done with it: \`--next-step\`.`);
    else {
      const prior = target.state;
      if (current) moved.done.push(current.id);
      if (prior !== "open") moved.reopened.push(target.id);
      plan = apply(plan, { op: "step", id: target.id }, state);
    }
  }

  if (change.detail !== undefined) {
    const current = currentOf();
    if (!current) throw new WorkRefusal("REFUSED_NO_CURRENT", { what: "no step is current, so the detail has nowhere to go", state: `${state}, plan complete`, next: 'relo work update --add "…" --detail "…"' });
    plan = apply(plan, { op: "detail", detail: change.detail }, state);
    moved.detail = current.id;
  }

  if (change.progress && plan && plan.steps.length) {
    if (!currentOf()) throw new WorkRefusal("REFUSED_NO_CURRENT", { what: "no step is current, so the count has nowhere to go", state: `${state}, plan complete`, next: 'relo work update --add "…" --progress 0/6' });
    plan = withProgress(plan, change.progress, state);
    const filled = currentOf();
    notes.push(`${change.progress.done}/${change.progress.total} fills ${filled.id}${filled.label ? ` (${filled.label})` : ""}; it clears when ${filled.id} ends.`);
  }

  if (plan && JSON.stringify(plan) === before && change.plan) notes.push("plan unchanged");
  return { plan, notes, moved, trees };
}

/**
 * The plan commands one update sends, in the order the server applies them (it takes one per request):
 * next, set (the plan as the update listed it, by id; a script without `trees` sends revise by label), add,
 * step, detail. `stepId` is the resolved id for --step; `trees` come from applyChange; a sealed work sends no
 * detail (it travels in the sealed card text only).
 */
export function planCommands(change, stepId, { trees, sealed = false, under, after } = {}) {
  const commands = [];
  if (change.nextStep) commands.push({ op: "next" });
  if (change.plan) commands.push(trees?.plan ? { op: "set", steps: wireEntries(trees.plan) } : { op: "revise", labels: change.plan.map((e) => asEntry(e).label) });
  if (change.add) commands.push({ op: "add", steps: trees?.add ? wireEntries(trees.add) : change.add.map((e) => ({ label: asEntry(e).label })), ...(under ? { under } : {}), ...(after ? { after } : {}) });
  if (stepId) commands.push({ op: "step", id: stepId });
  if (change.detail !== undefined && !sealed) commands.push({ op: "detail", detail: change.detail });
  return commands;
}

/** One request body per plan command: `first` (text, base version) rides on the first, progress on the last. */
export function planBodies(commands, first = {}, progress) {
  const bodies = (commands.length ? commands : [undefined]).map((plan, i) => ({ ...(i === 0 ? first : {}), ...(plan ? { plan } : {}) }));
  if (progress) bodies[bodies.length - 1].progress = progress;
  return bodies;
}

/**
 * Finishing (the server's closePlan): on success the current step is done; every other unsettled leaf is
 * skipped; parents follow; the open round closes when the plan has rounds, and the local copy keeps the outcome.
 */
export function finishPlan(input, result = "finished", outcome, now = new Date().toISOString()) {
  const plan = clone(input);
  if (!plan) return { plan, notes: [], moved: empty() };
  const moved = empty();
  for (const s of leavesOf(plan.steps)) {
    if (s.state === "current" && result === "finished") moved.done.push(s.id);
    else if (s.state === "open" || s.state === "current") moved.skipped.push(s.id);
  }
  const closed = closePlan(toEngine(plan), result, now);
  const last = closed.rounds?.[closed.rounds.length - 1];
  if (last?.state === "closed" && outcome && !last.outcome) last.outcome = outcome;
  return { plan: fromEngine(plan, closed, true), notes: [], moved };
}

const leavesOf = (steps) => { const ids = leafIds({ steps }); return steps.filter((s) => ids.has(s.id)); };

/** Delivering: the engine's close of the open round (the plan gets its rounds array when it has none). Open top-level steps refuse it unless `dropRest`. */
export function deliverPlan(input, outcome, { dropRest = false, state = "nothing open" } = {}) {
  const plan = clone(input) ?? { version: 0, next: 1, steps: [] };
  const moved = empty();
  for (const s of leavesOf(plan.steps)) {
    if (s.state === "current") moved.done.push(s.id);
    else if (s.state === "open") moved.skipped.push(s.id);
  }
  const notes = [];
  if (dropRest && moved.skipped.length) {
    const named = moved.skipped.map((id) => { const step = plan.steps.find((x) => x.id === id); return step?.label ? `${id} ${step.label}` : id; });
    notes.push(`skipped ${moved.skipped.length} open step${moved.skipped.length === 1 ? "" : "s"} (--drop-rest): ${named.join(", ")} (a next round without --plan carries them)`);
  }
  return { plan: apply(plan, { op: "close", outcome, ...(dropRest ? { dropRest: true } : {}) }, state), notes, moved };
}

/** The steps left unfinished by the last closed round, for the "not carried" note (a round opened with its own plan). */
export const unfinishedOfLastRound = (plan) => (plan?.rounds ? droppedLeaves(toEngine(plan), lastRound(plan).n) : []);

/** A flat list of steps (pre-order, with parents) as the nested tree grow() builds: { id, label, isNew, children? }. */
function treeOfSteps(steps) {
  const nodes = new Map(steps.map((s) => [s.id, { id: s.id, label: s.label, ...(s.detail ? { detail: s.detail } : {}), isNew: true }]));
  const roots = [];
  for (const s of steps) {
    const node = nodes.get(s.id);
    if (s.parent !== undefined && nodes.has(s.parent)) (nodes.get(s.parent).children ??= []).push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * Opening the next round of a delivered work: the title (kept locally; sealed works never send it) and its steps.
 * Without steps the round carries the unfinished steps of the one before (the engine does it, the server does
 * the same); with steps it carries nothing, and `notCarried` counts what was left behind.
 */
export function openRoundPlan(input, title, entries = [], progress, state = "nothing open") {
  const plan = clone(input);
  const last = lastRound(plan);
  if (!plan?.rounds || last.state !== "closed") {
    throw new WorkRefusal("REFUSED_ROUND_OPEN", { what: `round ${last.n} is still open, so there is no next round to open`, state, next: 'relo work deliver --outcome "…"' });
  }
  if (entries.length && entryDepth(entries.map(asEntry)) > MAX_DEPTH) throw deepRefusal(entryLabels(entries)[0], state);
  const { tree: own } = grow(planNext(plan), entries);
  const notCarried = entries.length ? unfinishedOfLastRound(plan).length : 0;
  let opened = apply(plan, { op: "round", ...(title ? { title } : {}), ...(entries.length ? { steps: wireEntries(own) } : {}) }, state);
  if (progress && opened.steps.some((s) => s.state === "current")) opened = withProgress(opened, progress, state);
  const moved = empty();
  moved.added = opened.steps.filter((s) => !plan.steps.some((p) => p.id === s.id)).map((s) => s.id);
  const carried = entries.length ? 0 : opened.steps.filter((s) => s.carriedFrom !== undefined && moved.added.includes(s.id) && s.parent === undefined).length;
  const tree = entries.length ? own : treeOfSteps(opened.steps.filter((s) => moved.added.includes(s.id)));
  return { plan: opened, tree, moved, carried, carriedFrom: last.n, notCarried };
}

const CONNECTOR = /^(?:and|or|then|but|plus|later|etc|including|incl|e\.g|i\.e|also|so|with|without|before|after)\b/iu;
const TRAILING = /\b(?:and|or|then|but|with|of|for|to|on|in|the|a|an|by|from|via|e\.g|i\.e)$/iu;

/**
 * DOGFOOD #15: labels that look like a comma split one step in two ("Install 0.10.0 owner", "later").
 * Returns notes for the echo; the labels are kept as given.
 */
export function splitWarnings(labels) {
  const notes = [];
  labels.forEach((label, i) => {
    const text = String(label).trim();
    const previous = i > 0 ? labels[i - 1] : undefined;
    const lowerWord = previous !== undefined && !/\s/u.test(text) && text === text.toLowerCase() && /^\p{Ll}/u.test(text);
    const continues = previous !== undefined && (CONNECTOR.test(text) || lowerWord || TRAILING.test(String(previous).trim()));
    if (continues) notes.push(`step "${text}" looks like the end of "${previous}" split at a comma; if it is one step, put the comma in brackets or give one step per line`);
  });
  return notes;
}
