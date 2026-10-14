// Pure plan rules (plan 04 §2.4). No I/O. Steps have ids s1…sN that are never reused.
import { WorkRefusal } from "./refusal.mjs";

export const MAX_PLAN_STEPS = 30;

const norm = (label) => String(label ?? "").trim().replace(/\s+/gu, " ").toLowerCase();
const clone = (plan) => plan ? { version: plan.version ?? 0, nextId: plan.nextId ?? (plan.steps?.length ?? 0) + 1, steps: (plan.steps ?? []).map((s) => ({ ...s })) } : null;

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

function limit(plan, state) {
  if (plan.steps.length > MAX_PLAN_STEPS) {
    throw new WorkRefusal("REFUSED_PLAN_SIZE", { what: `a plan holds at most ${MAX_PLAN_STEPS} steps (this would make ${plan.steps.length})`, state, next: 'relo work update --plan "<fewer, larger steps>"' });
  }
}

const empty = () => ({ skipped: [], done: [], reopened: [], added: [] });

export function startPlan(labels, progress, state = "nothing open") {
  if (!labels?.length) return { plan: null, notes: [], moved: empty() };
  const plan = { version: 1, nextId: labels.length + 1, steps: labels.map((label, i) => ({ id: `s${i + 1}`, label, state: i === 0 ? "current" : "open" })) };
  if (progress) plan.steps[0].progress = progress;
  limit(plan, state);
  return { plan, notes: [], moved: { ...empty(), added: plan.steps.map((s) => s.id) } };
}

export function position(plan) {
  const steps = plan?.steps ?? [];
  const done = steps.filter((s) => s.state === "done").length;
  const currentIndex = steps.findIndex((s) => s.state === "current");
  const toGo = currentIndex === -1 ? 0 : steps.slice(currentIndex + 1).filter((s) => s.state === "open").length;
  return { index: done + 1, toGo, complete: steps.length > 0 && currentIndex === -1 && !steps.some((s) => s.state === "open"), current: steps[currentIndex] };
}

function find(plan, x, labelsKnown, state) {
  if (/^s\d+$/u.test(x)) return plan.steps.find((s) => s.id === x);
  if (!labelsKnown) {
    throw new WorkRefusal("REFUSED_LABELS_UNKNOWN", { what: "this computer cannot read this work's step names (it was started elsewhere), so steps can't be matched by name", state: `steps by id: ${plan.steps.map((s) => `${s.id} (${s.state})`).join(", ")}`, next: 'relo work update --step s3  |  relo work update --add "…"' });
  }
  const matches = plan.steps.filter((s) => norm(s.label) === norm(x));
  return matches.find((s) => s.state !== "skipped") ?? matches[0];
}

/** Applies one update's plan changes in the fixed order: next-step, plan, add, step, progress. */
export function applyChange(input, change, labelsKnown = true, state = "nothing open") {
  let plan = clone(input);
  const notes = [];
  const moved = empty();
  const before = JSON.stringify(plan);
  const makeStep = (label) => {
    const step = { id: `s${plan.nextId}`, label, state: "open" };
    plan.nextId += 1;
    moved.added.push(step.id);
    return step;
  };
  const currentOf = () => plan?.steps.find((s) => s.state === "current");
  const promoteFirstOpen = () => {
    const next = plan.steps.find((s) => s.state === "open");
    if (next) next.state = "current";
  };

  if (change.nextStep) {
    if (!plan || plan.steps.length === 0) throw new WorkRefusal("REFUSED_NO_PLAN", { what: "this work has no plan, so there is no next step", state, next: 'relo work update --plan "…"' });
    const current = currentOf();
    if (!current) throw new WorkRefusal("REFUSED_PLAN_COMPLETE", { what: "every step is already done", state: `${state}, plan complete`, next: 'relo work finish --outcome "…"  |  relo work update --add "…"' });
    current.state = "done";
    delete current.progress;
    moved.done.push(current.id);
    const index = plan.steps.indexOf(current);
    const next = plan.steps.slice(index + 1).find((s) => s.state === "open");
    if (next) next.state = "current";
  }

  if (change.plan) {
    if (!labelsKnown) find(plan ?? { steps: [] }, "x", false, state);
    plan ??= { version: 0, nextId: 1, steps: [] };
    const listed = [];
    for (const label of change.plan) {
      const existing = plan.steps.find((s) => s.state !== "skipped" && norm(s.label) === norm(label)) ?? plan.steps.find((s) => norm(s.label) === norm(label));
      if (existing && listed.includes(existing)) continue;
      listed.push(existing ?? makeStep(label));
    }
    for (const step of plan.steps) {
      if (listed.includes(step)) {
        if (step.state === "skipped") { step.state = "open"; moved.reopened.push(step.id); }
        continue;
      }
      if (step.state === "open" || step.state === "current") {
        const wasCurrent = step.state === "current";
        step.state = "skipped";
        delete step.progress;
        moved.skipped.push(step.id);
        notes.push(wasCurrent
          ? `${step.id} ${step.label ?? ""} skipped (left out of --plan; add --next-step to mark it done)`.replace("  ", " ")
          : `skipped ${step.id} ${step.label ?? ""} (left out of --plan)`.replace("  ", " "));
      }
    }
    const settled = plan.steps.filter((s) => s.state === "done" || (s.state === "skipped" && !listed.includes(s)));
    // Plan order after a revision (DOGFOOD #16): settled steps, the current one, then --plan's own order.
    const current = listed.filter((s) => s.state === "current");
    const rest = listed.filter((s) => !settled.includes(s) && !current.includes(s));
    plan.steps = [...settled, ...current, ...rest];
    if (!currentOf()) promoteFirstOpen();
  }

  if (change.add?.length) {
    plan ??= { version: 0, nextId: 1, steps: [] };
    for (const label of change.add) {
      const dup = plan.steps.find((s) => s.state !== "skipped" && norm(s.label) === norm(label));
      if (dup) throw new WorkRefusal("REFUSED_DUPLICATE_STEP", { what: `step "${label}" is already in the plan (${dup.id})`, state, next: `relo work update --step "${label}"` });
      plan.steps.push(makeStep(label));
    }
    if (!currentOf()) promoteFirstOpen();
  }

  if (change.step) {
    if (!plan) throw new WorkRefusal("REFUSED_NO_PLAN", { what: "this work has no plan, so there is no step to move to", state, next: 'relo work update --plan "…"' });
    const target = find(plan, change.step, labelsKnown, state);
    if (!target) throw new WorkRefusal("REFUSED_UNKNOWN_STEP", { what: `no step "${change.step}" in this plan`, state: `steps: ${plan.steps.map((s) => `${s.id} ${s.label ?? ""} (${s.state})`).join(", ")}`, next: `relo work update --add "${change.step}" --step "${change.step}"` });
    const current = currentOf();
    if (target === current) notes.push(`${target.id} is already the current step`);
    else {
      const ci = current ? plan.steps.indexOf(current) : -1;
      const ti = plan.steps.indexOf(target);
      if (target.state === "open") {
        if (current) { current.state = "done"; delete current.progress; moved.done.push(current.id); }
        for (const s of plan.steps.slice(ci + 1, ti)) if (s.state === "open") { s.state = "skipped"; moved.skipped.push(s.id); }
        target.state = "current";
      } else if (target.state === "done") {
        if (current) { current.state = "open"; delete current.progress; }
        target.state = "current";
        moved.reopened.push(target.id);
      } else if (target.state === "skipped") {
        if (current) { current.state = "done"; delete current.progress; moved.done.push(current.id); }
        plan.steps.splice(ti, 1);
        const at = current ? plan.steps.indexOf(current) + 1 : plan.steps.length;
        plan.steps.splice(at, 0, target);
        target.state = "current";
        moved.reopened.push(target.id);
      }
    }
  }

  if (change.progress && plan && plan.steps.length) {
    const current = currentOf();
    if (!current) throw new WorkRefusal("REFUSED_NO_CURRENT", { what: "no step is current, so the count has nowhere to go", state: `${state}, plan complete`, next: 'relo work update --add "…" --progress 0/6' });
    current.progress = change.progress;
  }

  if (plan) {
    limit(plan, state);
    if (JSON.stringify(plan) === before) { if (change.plan) notes.push("plan unchanged"); }
    else plan.version += 1;
  }
  return { plan, notes, moved };
}

/** Finishing (DOGFOOD #20, server closePlan): on success the current step is done; every other unsettled step is skipped. */
export function finishPlan(input, result = "finished") {
  const plan = clone(input);
  if (!plan) return { plan, notes: [], moved: empty() };
  const moved = empty();
  for (const s of plan.steps) {
    if (s.state === "current" && result === "finished") { s.state = "done"; delete s.progress; moved.done.push(s.id); }
    else if (s.state === "open" || s.state === "current") { s.state = "skipped"; delete s.progress; moved.skipped.push(s.id); }
  }
  plan.version += 1;
  return { plan, notes: [], moved };
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
