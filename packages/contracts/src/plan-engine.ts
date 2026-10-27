/**
 * The plan engine: the pure rules of a work's plan (ids, nesting, rounds, current step, progress, times). No
 * imports and no zod, so the CLI ships a generated copy of this very module (scripts/generated.ts) and applies
 * a plan exactly as the server does; works.ts holds the zod schemas and re-exports this.
 */

/** Steps per round, steps in a whole plan (all rounds), and levels (a step, its child, its grandchild). */
export const WORK_PLAN_MAX_STEPS = 30;
export const WORK_PLAN_MAX_NODES = 120;
export const WORK_PLAN_MAX_DEPTH = 3;
/** A card event carries the steps of only the newest rounds (a long work would otherwise repeat them all in every event). */
export const PLAN_ROUNDS_WITH_STEPS = 3;

export type StepState = "open" | "current" | "done" | "skipped";
export type WorkResult = "finished" | "failed" | "dropped";
export type StepProgress = { done: number; total: number };

export type PlanStep = {
  id: string;
  state: StepState;
  addedIn: number;
  label?: string | undefined;
  progress?: StepProgress | undefined;
  /** The step this one belongs to: same round, earlier in `steps`. Only leaves do the work. */
  parent?: string | undefined;
  /** The round the step belongs to; absent means 1. Set on new steps whenever the plan has a `rounds` array. */
  round?: number | undefined;
  detail?: string | undefined;
  /** When the step became current (set when the write carries a clock). */
  startedAt?: string | undefined;
  /** When the step became done or skipped. */
  doneAt?: string | undefined;
  /** Set when the round's close skipped this open leaf (the agent did not choose to skip it): the next round carries it. */
  dropped?: boolean | undefined;
  /** The round whose unfinished step this one continues (set when a round opens without its own plan). */
  carriedFrom?: number | undefined;
};

export type PlanRound = {
  n: number;
  state: "open" | "closed";
  title?: string | undefined;
  outcome?: string | undefined;
  openedAt?: string | undefined;
  closedAt?: string | undefined;
};

export type WorkPlan = {
  v: 1;
  next: number;
  steps: PlanStep[];
  /** Absent means one open round 1. Rounds are numbered 1..k; at most one is open and it is the last. */
  rounds?: PlanRound[] | undefined;
};
export const EMPTY_WORK_PLAN: WorkPlan = { v: 1,next: 1,steps: [] };

export type PlanEntry = { id?: string | undefined; label?: string | undefined; detail?: string | undefined; children?: PlanEntry[] | undefined };
export type PlanCommand =
  | { op: "set"; steps: PlanEntry[] }
  | { op: "add"; steps: PlanEntry[]; under?: string | undefined; after?: string | undefined }
  | { op: "next" }
  | { op: "step"; id: string }
  | { op: "revise"; labels: string[] }
  | { op: "round"; title?: string | undefined; steps?: PlanEntry[] | undefined }
  | { op: "close"; outcome?: string | undefined; dropRest?: boolean | undefined }
  | { op: "detail"; id?: string | undefined; detail: string };

export const stepRound = (step: PlanStep): number => step.round ?? 1;

/** The structural rules of a whole plan (the zod schema reports these as issues). Empty when the plan is sound. */
export function planProblems(plan: WorkPlan): string[] {
  const problems: string[] = [];
  const bad = (message: string) => { problems.push(message); };
  if (plan.steps.length > WORK_PLAN_MAX_NODES) bad(`at most ${WORK_PLAN_MAX_NODES} steps in a plan`);
  const k = plan.rounds?.length ?? 1;
  plan.rounds?.forEach((round,index) => {
    if (round.n !== index + 1) bad("rounds are numbered 1..k in order");
    if (round.state === "open" && index !== k - 1) bad("only the last round can be open");
  });
  const perRound = new Map<number,number>();
  const index = new Map<string,number>();
  const parents = new Set<string>();
  for (const step of plan.steps) if (step.parent !== undefined) parents.add(step.parent);
  plan.steps.forEach((step,position) => {
    if (index.has(step.id)) bad(`duplicate step id ${step.id}`);
    if (Number(step.id.slice(1)) >= plan.next) bad(`step id ${step.id} not below next`);
    const round = stepRound(step);
    if (round > k) bad(`step ${step.id} is in round ${round} but the plan has ${k}`);
    perRound.set(round,(perRound.get(round) ?? 0) + 1);
    if (step.parent !== undefined) {
      const at = index.get(step.parent);
      if (at === undefined) bad(`parent ${step.parent} of ${step.id} must exist earlier in the plan`);
      else if (stepRound(plan.steps[at]!) !== round) bad(`step ${step.id} is in another round than its parent`);
    }
    if (step.state === "current" && parents.has(step.id)) bad(`step ${step.id} has children and cannot be current`);
    index.set(step.id,position);
  });
  for (const [round,count] of perRound) if (count > WORK_PLAN_MAX_STEPS) bad(`at most ${WORK_PLAN_MAX_STEPS} steps in round ${round}`);
  for (const step of plan.steps) {
    let depth = 1;
    for (let at = step.parent; at !== undefined && depth <= WORK_PLAN_MAX_DEPTH + 1; depth += 1) at = plan.steps[index.get(at) ?? -1]?.parent;
    if (depth > WORK_PLAN_MAX_DEPTH) bad(`step ${step.id} is deeper than ${WORK_PLAN_MAX_DEPTH} levels`);
  }
  if (plan.steps.filter((step) => step.state === "current").length > 1) bad("at most one current step");
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Pure plan rules. Ids come from `next` and are never reused (assigned in pre-order: a parent before its
// children); steps are never deleted (unlisted open steps become skipped); `steps` stays in pre-order; at
// most one current, and always a leaf (a parent's state is derived from its children). New steps never land
// before the current one. Round rule: `step.round` is set on new steps whenever the plan has a `rounds`
// array (and stamped on all steps when the array is created); without one it stays absent and means 1.

export type PlanFailure = { ok: false; code: "plan_too_long" | "plan_ids_invalid" | "step_not_found" | "labels_sealed" | "plan_invalid" | "round_open" | "no_open_round" | "plan_too_deep" | "open_steps"; message: string };
export type PlanResult = { ok: true; plan: WorkPlan; structural: boolean; complete: boolean } | PlanFailure;
export type PlanOptions = { sealed: boolean; now?: string | undefined };

const stepNumber = (id: string) => Number(id.slice(1));

function refuse(code: PlanFailure["code"],message: string): PlanFailure {
  return { ok: false,code,message };
}
const failed = (value: unknown): value is PlanFailure => typeof value === "object" && value !== null && "ok" in value && (value as { ok: unknown }).ok === false;

/** The last round, or the implicit open round 1 of a plan without a `rounds` array. */
export function lastRound(plan: WorkPlan): PlanRound {
  return plan.rounds?.[plan.rounds.length - 1] ?? { n: 1,state: "open" };
}
/** The open round (the implicit round 1 when the plan has no `rounds` array), or undefined when the last is closed. */
export function openRound(plan: WorkPlan): PlanRound | undefined {
  const round = lastRound(plan);
  return round.state === "open" ? round : undefined;
}

/** 1 for a top-level step, 2 for its child, 3 for a grandchild; 0 for an unknown step. */
export function stepDepth(plan: WorkPlan,step: PlanStep | string): number {
  const byId = new Map(plan.steps.map((candidate) => [candidate.id,candidate]));
  let at = typeof step === "string" ? byId.get(step) : step;
  let depth = 0;
  while (at && depth <= plan.steps.length) {
    depth += 1;
    at = at.parent !== undefined ? byId.get(at.parent) : undefined;
  }
  return depth;
}

/** The current step with its ancestors, top first (empty when nothing is current). */
export function currentPath(plan: WorkPlan): PlanStep[] {
  const byId = new Map(plan.steps.map((step) => [step.id,step]));
  const path: PlanStep[] = [];
  for (let at = plan.steps.find((step) => step.state === "current"); at && path.length <= plan.steps.length; at = at.parent !== undefined ? byId.get(at.parent) : undefined) path.unshift(at);
  return path;
}

export function leafIds(plan: Pick<WorkPlan,"steps">): Set<string> {
  const parents = new Set<string>();
  for (const step of plan.steps) if (step.parent !== undefined) parents.add(step.parent);
  return new Set(plan.steps.filter((step) => !parents.has(step.id)).map((step) => step.id));
}

/** Parent states follow their children, bottom-up: done when all are closed and one is done, skipped when all are skipped, else open. */
function deriveParents(plan: WorkPlan) {
  const kids = new Map<string,PlanStep[]>();
  for (const step of plan.steps) if (step.parent !== undefined) kids.set(step.parent,[...(kids.get(step.parent) ?? []),step]);
  for (let at = plan.steps.length - 1; at >= 0; at -= 1) {
    const step = plan.steps[at]!;
    const children = kids.get(step.id);
    if (!children) continue;
    if (children.every((child) => child.state === "skipped")) step.state = "skipped";
    else if (children.every((child) => child.state === "done" || child.state === "skipped")) step.state = "done";
    else step.state = "open";
  }
}

function ensureCurrent(plan: WorkPlan) {
  const open = openRound(plan);
  if (!open || plan.steps.some((step) => step.state === "current")) return;
  const leaves = leafIds(plan);
  const first = plan.steps.find((step) => stepRound(step) === open.n && step.state === "open" && leaves.has(step.id));
  if (first) first.state = "current";
}

/**
 * Over the node cap, closed rounds give up their steps, oldest first: the skipped ones, then all of them. The
 * rounds array keeps n/title/outcome/times, so history stays readable as round outcomes; `next` keeps counting,
 * so a pruned id is never reused.
 */
function prunePlan(plan: WorkPlan) {
  if (plan.steps.length <= WORK_PLAN_MAX_NODES) return;
  const open = openRound(plan)?.n;
  const closed = (plan.rounds ?? []).filter((round) => round.state === "closed" && round.n !== open).map((round) => round.n);
  for (const drop of [(step: PlanStep) => step.state === "skipped",() => true]) {
    for (const n of closed) {
      if (plan.steps.length <= WORK_PLAN_MAX_NODES) return;
      plan.steps = plan.steps.filter((step) => !(stepRound(step) === n && drop(step)));
    }
  }
}

function finalize(plan: WorkPlan,before: WorkPlan,now?: string): PlanResult {
  const deep = plan.steps.find((step) => stepDepth(plan,step) > WORK_PLAN_MAX_DEPTH);
  if (deep) return refuse("plan_too_deep",`A plan nests at most ${WORK_PLAN_MAX_DEPTH} levels (a step, its child, its grandchild); step ${deep.id} would sit deeper.`);
  prunePlan(plan);
  if (plan.steps.length > WORK_PLAN_MAX_NODES) {
    return refuse("plan_too_long",`A plan holds at most ${WORK_PLAN_MAX_NODES} steps in the open round and the rounds kept (this one would hold ${plan.steps.length}).`);
  }
  const perRound = new Map<number,number>();
  for (const step of plan.steps) perRound.set(stepRound(step),(perRound.get(stepRound(step)) ?? 0) + 1);
  for (const [round,count] of perRound) {
    if (count > WORK_PLAN_MAX_STEPS) return refuse("plan_too_long",`A round holds at most ${WORK_PLAN_MAX_STEPS} steps (round ${round} would hold ${count}).`);
  }
  const parents = new Set(plan.steps.filter((step) => step.parent !== undefined).map((step) => step.parent));
  for (const step of plan.steps) if (step.state === "current" && parents.has(step.id)) step.state = "open";
  for (const step of plan.steps) if (step.state !== "skipped") delete step.dropped;
  deriveParents(plan);
  ensureCurrent(plan);
  const problems = planProblems(plan);
  if (problems.length) return refuse("plan_invalid",problems.join("; "));
  stampTimes(plan,before,now);
  // A step's own progress refines the step only while it is current: once it ends, its count is gone.
  for (const step of plan.steps) if (step.state !== "current") delete step.progress;
  const structure = (value: WorkPlan) => JSON.stringify([value.steps.map((step) => [step.id,step.state,step.parent,step.round,step.detail]),value.rounds]);
  return { ok: true,plan,structural: structure(plan) !== structure(before),complete: planComplete(plan) };
}

/** The open round has steps and all are closed. Without a `rounds` array that is the whole plan; false when no round is open. */
export function planComplete(plan: WorkPlan): boolean {
  const open = openRound(plan);
  if (!open) return false;
  const steps = plan.steps.filter((step) => stepRound(step) === open.n);
  return steps.length > 0 && !steps.some((step) => step.state === "open" || step.state === "current");
}

/**
 * Step times, only when the write carries a clock: `startedAt` when a step becomes current, `doneAt` when it
 * becomes done or skipped (a parent's start is its first child's); a step that is open or current again loses
 * its `doneAt`. Times are not structure, so they never bump the plan version.
 */
function stampTimes(plan: WorkPlan,before: WorkPlan,now: string | undefined) {
  if (now === undefined) return;
  const was = new Map(before.steps.map((step) => [step.id,step.state]));
  const kids = new Map<string,PlanStep[]>();
  for (const step of plan.steps) if (step.parent !== undefined) kids.set(step.parent,[...(kids.get(step.parent) ?? []),step]);
  const closed = (state: StepState | undefined) => state === "done" || state === "skipped";
  for (const step of plan.steps) {
    const previous = was.get(step.id);
    if (step.state === "current" && previous !== "current") { step.startedAt = now; delete step.doneAt; }
    else if (closed(step.state) && !closed(previous)) {
      step.doneAt = now;
      const started = (kids.get(step.id) ?? []).map((child) => child.startedAt).filter((value): value is string => value !== undefined).sort()[0];
      if (step.startedAt === undefined && started !== undefined) step.startedAt = started;
    } else if (!closed(step.state)) delete step.doneAt;
  }
}

function clonePlan(plan: WorkPlan): WorkPlan {
  return {
    v: 1,next: plan.next,
    steps: plan.steps.map((step) => ({ ...step,...(step.progress ? { progress: { ...step.progress } } : {}) })),
    ...(plan.rounds ? { rounds: plan.rounds.map((round) => ({ ...round })) } : {}),
  };
}

const NO_OPEN_ROUND = () => refuse("no_open_round","The last round is closed; open the next one first (start with a round).");

/** One new step with the next id; a sealed entry carries the id the client predicted from `next`. */
function makeStep(plan: WorkPlan,entry: PlanEntry,parent: string | undefined,roundN: number,version: number,sealed: boolean): PlanStep | PlanFailure {
  const id = `s${plan.next}`;
  if (entry.id !== undefined && entry.id !== id) return refuse("plan_ids_invalid",`New step id ${entry.id} does not match the next id ${id}.`);
  if (sealed && (entry.label !== undefined || entry.detail !== undefined)) return refuse("labels_sealed","A sealed work carries no readable step labels or details.");
  plan.next += 1;
  return {
    id,state: "open",addedIn: version,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    ...(parent !== undefined ? { parent } : {}),
    ...(plan.rounds ? { round: roundN } : {}),
  };
}

/** New entries (and their children) as steps in pre-order, ids assigned in that order. */
function buildTree(plan: WorkPlan,entries: PlanEntry[],parent: string | undefined,depth: number,roundN: number,version: number,sealed: boolean): PlanStep[] | PlanFailure {
  if (depth > WORK_PLAN_MAX_DEPTH) return refuse("plan_too_deep",`A plan nests at most ${WORK_PLAN_MAX_DEPTH} levels (a step, its child, its grandchild).`);
  const created: PlanStep[] = [];
  for (const entry of entries) {
    const step = makeStep(plan,entry,parent,roundN,version,sealed);
    if (failed(step)) return step;
    created.push(step);
    if (entry.children?.length) {
      const children = buildTree(plan,entry.children,step.id,depth + 1,roundN,version,sealed);
      if (failed(children)) return children;
      created.push(...children);
    }
  }
  return created;
}

export function applyPlanCommand(current: WorkPlan,command: PlanCommand,version: number,options: PlanOptions): PlanResult {
  const before = clonePlan(current);
  const plan = clonePlan(current);
  const open = openRound(plan);
  switch (command.op) {
  case "set": {
    if (!open) return NO_OPEN_ROUND();
    const inRound = plan.steps.filter((step) => stepRound(step) === open.n);
    const others = plan.steps.filter((step) => stepRound(step) !== open.n);
    const byId = new Map(inRound.map((step) => [step.id,step]));
    const closedIds = new Set(others.map((step) => step.id));
    const seen = new Set<string>();
    const created = new Set<string>();
    const listed: PlanStep[] = [];
    const walk = (entries: PlanEntry[],parent: string | undefined,depth: number): PlanFailure | undefined => {
      if (depth > WORK_PLAN_MAX_DEPTH) return refuse("plan_too_deep",`A plan nests at most ${WORK_PLAN_MAX_DEPTH} levels (a step, its child, its grandchild).`);
      for (const entry of entries) {
        let step = entry.id !== undefined ? byId.get(entry.id) : undefined;
        if (step) {
          if (seen.has(step.id)) return refuse("plan_ids_invalid",`Step ${step.id} is listed twice.`);
          seen.add(step.id);
          if (entry.label !== undefined || entry.detail !== undefined) {
            if (options.sealed) return refuse("labels_sealed","A sealed work carries no readable step labels or details.");
            if (entry.label !== undefined) step.label = entry.label;
            if (entry.detail !== undefined) step.detail = entry.detail;
          }
          if (step.state === "skipped") step.state = "open";
        } else {
          if (entry.id !== undefined && closedIds.has(entry.id)) return refuse("plan_ids_invalid",`Step ${entry.id} belongs to a closed round and cannot be changed.`);
          const made = makeStep(plan,entry,parent,open.n,version,options.sealed);
          if (failed(made)) return made;
          step = made;
          created.add(step.id);
        }
        if (parent !== undefined) step.parent = parent;
        else delete step.parent;
        listed.push(step);
        if (entry.children?.length) {
          const refused = walk(entry.children,step.id,depth + 1);
          if (refused) return refused;
        }
      }
      return undefined;
    };
    const refused = walk(command.steps,undefined,1);
    if (refused) return refused;
    const unlisted = inRound.filter((step) => !seen.has(step.id));
    const unlistedDone = unlisted.filter((step) => step.state === "done");
    const skipped = unlisted.filter((step) => step.state !== "done").map((step) => Object.assign(step,{ state: "skipped" as const }));
    // New steps never land before the current one (unless they wrap it).
    const remaining = listed.filter((step) => step.state !== "done");
    const currentIndex = remaining.findIndex((step) => step.state === "current");
    if (currentIndex > 0) {
      const ancestors = new Set<string>();
      const listedById = new Map(listed.map((step) => [step.id,step]));
      for (let at = remaining[currentIndex]!.parent; at !== undefined; at = listedById.get(at)?.parent) ancestors.add(at);
      if (remaining.slice(0,currentIndex).some((step) => created.has(step.id) && !ancestors.has(step.id))) {
        return refuse("plan_ids_invalid","New steps cannot land before the current step.");
      }
    }
    // Pre-order again: siblings keep the order unlisted done, listed, skipped.
    const constructed = [...unlistedDone,...listed,...skipped];
    const present = new Set(constructed.map((step) => step.id));
    const kids = new Map<string | undefined,PlanStep[]>();
    for (const step of constructed) {
      if (step.parent !== undefined && !present.has(step.parent)) delete step.parent;
      kids.set(step.parent,[...(kids.get(step.parent) ?? []),step]);
    }
    const ordered: PlanStep[] = [];
    const visit = (parent: string | undefined) => { for (const step of kids.get(parent) ?? []) { ordered.push(step); visit(step.id); } };
    visit(undefined);
    plan.steps = [...others,...ordered];
    return finalize(plan,before,options.now);
  }
  case "add": {
    if (!open) return NO_OPEN_ROUND();
    if (command.under !== undefined && command.after !== undefined) return refuse("plan_invalid","An add goes under a step or after one, not both.");
    let at = plan.steps.length;
    let depth = 1;
    let parentId = command.under;
    // The index just past a step and everything inside it.
    const past = (anchor: PlanStep) => {
      const inside = new Set([anchor.id]);
      let end = plan.steps.indexOf(anchor) + 1;
      for (let index = end; index < plan.steps.length; index += 1) {
        const step = plan.steps[index]!;
        if (step.parent === undefined || !inside.has(step.parent)) continue;
        inside.add(step.id);
        end = index + 1;
      }
      return end;
    };
    const anchorId = command.under ?? command.after;
    if (anchorId !== undefined) {
      const anchor = plan.steps.find((step) => step.id === anchorId);
      if (!anchor) return refuse("step_not_found",`Step ${anchorId} is not in this plan (${plan.steps.map((step) => step.id).join(", ") || "no steps"}).`);
      if (stepRound(anchor) !== open.n) return refuse("plan_invalid",`Step ${anchor.id} belongs to a closed round.`);
      at = past(anchor);
      if (command.under !== undefined) depth = stepDepth(plan,anchor) + 1;
      else { depth = stepDepth(plan,anchor); parentId = anchor.parent; }
    }
    const made = buildTree(plan,command.steps,parentId,depth,open.n,version,options.sealed);
    if (failed(made)) return made;
    plan.steps.splice(at,0,...made);
    return finalize(plan,before,options.now);
  }
  case "next": {
    if (!open) return NO_OPEN_ROUND();
    const running = plan.steps.find((step) => step.state === "current");
    const from = running ? plan.steps.indexOf(running) : -1;
    if (running) running.state = "done";
    const leaves = leafIds(plan);
    // The next open leaf after the one just finished; an earlier open leaf only when none follows.
    const openLeaf = (step: PlanStep) => stepRound(step) === open.n && step.state === "open" && leaves.has(step.id);
    const following = plan.steps.slice(from + 1).find(openLeaf) ?? plan.steps.slice(0,from + 1).find(openLeaf);
    if (following) following.state = "current";
    return finalize(plan,before,options.now);
  }
  case "step": {
    const target = plan.steps.find((step) => step.id === command.id);
    if (!target) return refuse("step_not_found",`Step ${command.id} is not in this plan (${plan.steps.map((step) => step.id).join(", ") || "no steps"}).`);
    if (!open) return NO_OPEN_ROUND();
    if (stepRound(target) !== open.n) return refuse("plan_invalid",`Step ${target.id} belongs to a closed round.`);
    if (!leafIds(plan).has(target.id)) {
      const children = plan.steps.filter((step) => step.parent === target.id).map((step) => step.id);
      return refuse("plan_invalid",`Step ${target.id} has sub-steps; make one of them current (${children.join(", ")}).`);
    }
    if (target.state === "current") return finalize(plan,before,options.now);
    // Moving forward finishes the step left behind and the open steps passed on the way (the agent says it is past
    // them); moving back (to redo an earlier step) leaves the step left behind open.
    const running = plan.steps.find((step) => step.state === "current");
    const to = plan.steps.indexOf(target);
    if (running) running.state = plan.steps.indexOf(running) < to ? "done" : "open";
    const from = running ? plan.steps.indexOf(running) : -1;
    if (from < to) {
      const leaves = leafIds(plan);
      for (const step of plan.steps.slice(from + 1, to)) if (step.state === "open" && stepRound(step) === open.n && leaves.has(step.id)) step.state = "done";
    }
    target.state = "current";
    return finalize(plan,before,options.now);
  }
  case "revise": {
    if (options.sealed) return refuse("labels_sealed","A sealed work's labels are matched by the client; send set.");
    if (!open) return NO_OPEN_ROUND();
    if (plan.steps.some((step) => step.parent !== undefined && stepRound(step) === open.n)) {
      return refuse("plan_invalid","This round's plan has sub-steps; revise lists flat labels, so send set with the tree instead.");
    }
    return applyPlanCommand(current,revisePlanByLabels(current,command.labels),version,options);
  }
  case "round": {
    if (open) return refuse("round_open",`Round ${open.n} is still open; close or deliver it before opening the next.`);
    if (options.sealed && command.title !== undefined) return refuse("labels_sealed","A sealed work carries no readable round title.");
    const n = (plan.rounds?.length ?? 1) + 1;
    plan.rounds = [...(plan.rounds ?? [{ n: 1,state: "closed" as const }]),{ n,state: "open",...(command.title !== undefined ? { title: command.title } : {}),...(options.now !== undefined ? { openedAt: options.now } : {}) }];
    for (const step of plan.steps) step.round ??= 1;
    // A round without its own plan carries the unfinished steps of the one before as new steps (closed rounds stay as they were).
    const carried = command.steps === undefined ? unfinishedEntries(plan,n - 1) : [];
    const made = buildTree(plan,command.steps ?? carried,undefined,1,n,version,options.sealed);
    if (failed(made)) return made;
    if (command.steps === undefined) for (const step of made) step.carriedFrom = n - 1;
    plan.steps.push(...made);
    return finalize(plan,before,options.now);
  }
  case "close": {
    if (!open) return refuse("no_open_round","There is no open round to close.");
    if (options.sealed && command.outcome !== undefined) return refuse("labels_sealed","A sealed work carries no readable round outcome.");
    if (command.dropRest !== true) {
      const left = stepsLeftOpen(plan);
      if (left.length) return refuse("open_steps",`Round ${open.n} still has open steps: ${left.map((step) => step.label ? `${step.id} ${step.label}` : step.id).join(", ")}`);
    }
    closeRound(plan,open.n,"finished",{ ...(command.outcome !== undefined ? { outcome: command.outcome } : {}),...(options.now !== undefined ? { closedAt: options.now } : {}) });
    return finalize(plan,before,options.now);
  }
  case "detail": {
    if (options.sealed) return refuse("labels_sealed","A sealed work carries no readable step details.");
    const target = command.id !== undefined ? plan.steps.find((step) => step.id === command.id) : plan.steps.find((step) => step.state === "current");
    if (!target) return refuse("step_not_found",command.id !== undefined ? `Step ${command.id} is not in this plan (${plan.steps.map((step) => step.id).join(", ") || "no steps"}).` : "No step is current; name the step.");
    if (command.detail) target.detail = command.detail;
    else delete target.detail;
    return finalize(plan,before,options.now);
  }
  }
}

/** Marks the round's open and current steps (leaves) and closes the round; creates the `rounds` array if absent. */
function closeRound(plan: WorkPlan,n: number,result: WorkResult,fields: { outcome?: string; closedAt?: string }) {
  const leaves = leafIds(plan);
  for (const step of plan.steps) {
    if (stepRound(step) !== n || !leaves.has(step.id)) continue;
    if (step.state === "current") step.state = result === "finished" ? "done" : "skipped";
    else if (step.state === "open") { step.state = "skipped"; step.dropped = true; }
  }
  if (!plan.rounds) {
    plan.rounds = [{ n: 1,state: "open" }];
    for (const step of plan.steps) step.round ??= 1;
  }
  const round = plan.rounds[n - 1]!;
  round.state = "closed";
  if (fields.outcome !== undefined) round.outcome = fields.outcome;
  if (fields.closedAt !== undefined) round.closedAt = fields.closedAt;
}

/**
 * The open round's top-level steps a close would leave behind: those holding an open or current leaf. A close
 * finishes the current step, so a round whose only unfinished leaf is the current one leaves nothing behind.
 */
export function stepsLeftOpen(plan: WorkPlan): PlanStep[] {
  const open = openRound(plan);
  if (!open) return [];
  const leaves = leafIds(plan);
  const unfinished = plan.steps.filter((step) => stepRound(step) === open.n && leaves.has(step.id) && (step.state === "open" || step.state === "current"));
  if (unfinished.length === 0 || (unfinished.length === 1 && unfinished[0]!.state === "current")) return [];
  const byId = new Map(plan.steps.map((step) => [step.id,step]));
  const tops = new Set<string>();
  // The current step is finished by the close, so only the leaves still open are left behind.
  for (const leaf of unfinished.filter((step) => step.state === "open")) {
    let at = leaf;
    while (at.parent !== undefined && byId.has(at.parent)) at = byId.get(at.parent)!;
    tops.add(at.id);
  }
  return plan.steps.filter((step) => tops.has(step.id));
}

/** The leaves a closed round's close skipped (not the agent's choice): what the next round carries. */
export function droppedLeaves(plan: WorkPlan,round: number): PlanStep[] {
  const leaves = leafIds(plan);
  return plan.steps.filter((step) => stepRound(step) === round && leaves.has(step.id) && step.state === "skipped" && step.dropped === true);
}

/** The dropped leaves of a round with the steps that hold them, as entries in plan order. */
function unfinishedEntries(plan: WorkPlan,round: number): PlanEntry[] {
  const keep = new Set<string>();
  const byId = new Map(plan.steps.map((step) => [step.id,step]));
  for (const leaf of droppedLeaves(plan,round)) for (let at: PlanStep | undefined = leaf; at; at = at.parent !== undefined ? byId.get(at.parent) : undefined) keep.add(at.id);
  const entry = (step: PlanStep): PlanEntry => {
    const children = plan.steps.filter((child) => child.parent === step.id && keep.has(child.id)).map(entry);
    return { ...(step.label !== undefined ? { label: step.label } : {}),...(step.detail !== undefined ? { detail: step.detail } : {}),...(children.length ? { children } : {}) };
  };
  return plan.steps.filter((step) => stepRound(step) === round && step.parent === undefined && keep.has(step.id)).map(entry);
}

/** Matches labels to existing steps of the open round (done steps excluded) and turns them into a `set` command. */
export function revisePlanByLabels(plan: WorkPlan,labels: string[]): PlanCommand {
  const open = openRound(plan);
  const available = plan.steps.filter((step) => step.state !== "done" && (!open || stepRound(step) === open.n));
  const used = new Set<string>();
  const steps = labels.map((label) => {
    const match = available.find((step) => !used.has(step.id) && step.label?.toLowerCase() === label.toLowerCase());
    if (match) { used.add(match.id); return { id: match.id }; }
    return { label };
  });
  return { op: "set",steps };
}

/** Finishing marks every open or current leaf skipped (spec 3.3), current counts as done on success; the open round closes if the plan has rounds. */
export function closePlan(current: WorkPlan,result: WorkResult,now?: string): WorkPlan {
  const plan = clonePlan(current);
  const before = clonePlan(current);
  const leaves = leafIds(plan);
  for (const step of plan.steps) {
    if (!leaves.has(step.id)) continue;
    if (step.state === "current") step.state = result === "finished" ? "done" : "skipped";
    else if (step.state === "open") step.state = "skipped";
  }
  deriveParents(plan);
  stampTimes(plan,before,now);
  const last = plan.rounds?.[plan.rounds.length - 1];
  if (last && last.state === "open") {
    last.state = "closed";
    if (now !== undefined) last.closedAt = now;
  }
  return plan;
}

export function setCurrentStepProgress(current: WorkPlan,progress: StepProgress | null): WorkPlan | null {
  const plan = clonePlan(current);
  const step = plan.steps.find((candidate) => candidate.state === "current");
  if (!step) return null;
  if (progress) step.progress = progress;
  else delete step.progress;
  return plan;
}


export { stepNumber as workStepNumber };

// ---------------------------------------------------------------------------------------------
// Progress (plan UX rules U1 and U2): one count and one line for every surface.

export type PlanProgressState = "moving" | "delivered" | "complete" | "empty";
export type PlanProgress = {
  /** The round in play: the open round, else the last. */
  round: number;
  rounds: number;
  /** The last round is closed: the owner's turn. */
  delivered: boolean;
  /** Top-level steps of that round that are done, and all of them (skipped steps are not counted). */
  done: number;
  total: number;
  /** The top-level step that is, or contains, the current step. */
  currentId: string | null;
  /** That step's position among the counted top-level steps, from 1; null when none is current. */
  current: number | null;
  /** That step's direct children, done and all (skipped excluded); null when it has none. */
  sub: { done: number; total: number } | null;
  state: PlanProgressState;
};

/**
 * Where a plan stands, per U1. `stopped`: the work ended failed or dropped, so the steps its end skipped
 * (marked at the work's closing time) still count as steps that were not done ("Stopped at 3 of 5").
 */
export function planProgress(plan: WorkPlan | null | undefined,options: { stopped?: boolean } = {}): PlanProgress {
  return planProgressDetail(plan,options).progress;
}

/** `planProgress` plus the round's counted top-level steps and the one holding the current step (the wire needs both). */
function planProgressDetail(plan: WorkPlan | null | undefined,options: { stopped?: boolean } = {}): { progress: PlanProgress; top: PlanStep[]; at: PlanStep | undefined; leaf: PlanStep | undefined } {
  const steps = plan?.steps ?? [];
  const rounds = plan?.rounds?.length ?? 1;
  const last: PlanRound = plan?.rounds?.[rounds - 1] ?? { n: 1,state: "open" };
  const delivered = Boolean(plan?.rounds) && last.state === "closed";
  const inRound = steps.filter((step) => stepRound(step) === last.n);
  // The work's end is the latest thing that happened to a step: what it skipped carries that very time.
  const endedAt = options.stopped === true ? inRound.map((step) => step.doneAt).filter((value): value is string => value !== undefined).sort().pop() : undefined;
  const stoppedByEnd = (step: PlanStep) => endedAt !== undefined && step.state === "skipped" && step.doneAt === endedAt;
  const counted = (step: PlanStep) => step.state !== "skipped" || stoppedByEnd(step);
  const top = inRound.filter((step) => step.parent === undefined && counted(step));
  // A round that carries unfinished steps goes on with the goal: the top-level steps finished in the rounds it
  // continues count too, so the card reads "Step 2 of 4", not "Step 1 of 3". A round with its own plan counts alone.
  let before = 0;
  for (let round = last.n; round > 1 && steps.some((step) => stepRound(step) === round && step.carriedFrom !== undefined); round -= 1) {
    before += steps.filter((step) => stepRound(step) === round - 1 && step.parent === undefined && step.state === "done").length;
  }
  const done = before + top.filter((step) => step.state === "done").length;
  const byId = new Map(inRound.map((step) => [step.id,step]));
  const leaf = inRound.find((step) => step.state === "current");
  let at = leaf;
  while (at?.parent !== undefined && byId.has(at.parent)) at = byId.get(at.parent);
  const children = at ? inRound.filter((step) => step.parent === at!.id && counted(step)) : [];
  const state: PlanProgressState = top.length === 0 ? "empty" : delivered ? "delivered" : at ? "moving" : done === before + top.length ? "complete" : "moving";
  return {
    progress: {
      round: last.n,rounds,delivered,done,total: before + top.length,currentId: at?.id ?? null,
      current: at && top.some((step) => step.id === at.id) ? top.findIndex((step) => step.id === at.id) + 1 + before : null,
      sub: children.length ? { done: children.filter((step) => step.state === "done").length,total: children.length } : null,
      state,
    },
    top,at,leaf,
  };
}

/**
 * The plan line (U2) every surface prints. `labelOf` gives the readable label of a step id, or nothing when this
 * device cannot read it ("Not readable"). Empty for a work without a plan.
 */
export function planLineText(progress: PlanProgress,labelOf: (id: string) => string | null | undefined,options: { paused?: boolean; ended?: "finished" | "failed" | "dropped" } = {}): string {
  const count = `${progress.done} of ${progress.total}`;
  if (options.ended === "finished") return progress.total ? `${count} done` : "";
  if (options.ended === "failed" || options.ended === "dropped") return progress.total ? `Stopped at ${count}` : "";
  if (progress.state === "empty") return "";
  if (options.paused) return `Paused at ${count}`;
  if (progress.state === "delivered") return `Round ${progress.round} delivered`;
  if (progress.state === "complete") return `${count} done`;
  if (progress.currentId === null || progress.current === null) return count;
  const label = labelOf(progress.currentId);
  return `Step ${progress.current} of ${progress.total} · ${label ? label : "Not readable"}${progress.sub ? ` · ${progress.sub.done}/${progress.sub.total}` : ""}`;
}

/**
 * The plan progress as the server sends it on a card and a Now item: U1's count plus where the work is, and,
 * for a work whose labels the server may read, the current top-level step's label and the current substep's.
 * The phone computes the plan line (`planLineText`) from this alone.
 */
export type PlanProgressWire = {
  done: number;
  total: number;
  currentId: string | null;
  sub: { done: number; total: number } | null;
  round: number;
  rounds: number;
  delivered: boolean;
  /** Which top-level step is current, counting from 1 (the segment the bar fills); null when none is. */
  current?: number | null | undefined;
  /** How far the current top-level step is, 0 to 1: its substeps done of all, else its own `--progress`; null when it has neither. */
  fill?: number | null | undefined;
  /** The current top-level step's label (readable works only). */
  stepLabel?: string | undefined;
  /** The label of the current substep: the direct child of that step the work is in (readable works only). */
  subLabel?: string | undefined;
};

export function planProgressWire(plan: WorkPlan | null | undefined,options: { readable: boolean; stopped?: boolean; labelMax?: number } = { readable: false }): PlanProgressWire | null {
  if (!plan) return null;
  const { progress,top,at,leaf } = planProgressDetail(plan,options.stopped === undefined ? {} : { stopped: options.stopped });
  if (progress.state === "empty") return null;
  // One fraction, computed here: the current step's substeps, else its own counted progress. A step's progress
  // counts only while the step is current, so a finished step's old count never reaches a surface.
  // A substep's own count rolls up into its parent: (substeps done + the current substep's fraction) / substeps.
  const ownFraction = leaf?.progress && leaf.progress.total > 0 ? Math.min(1,leaf.progress.done / leaf.progress.total) : null;
  const fill = progress.sub
    ? Math.min(1,(progress.sub.done + (leaf && leaf.id !== at?.id ? ownFraction ?? 0 : 0)) / progress.sub.total)
    : leaf && leaf.id === at?.id ? ownFraction : null;
  const max = options.labelMax ?? 80;
  const clip = (value: string | undefined) => value === undefined || value === "" ? undefined : value.length > max ? `${value.slice(0,max - 1)}…` : value;
  const path = currentPath(plan);
  const stepLabel = options.readable ? clip(path[0]?.label) : undefined;
  const subLabel = options.readable && progress.sub ? clip(path[1]?.label) : undefined;
  return {
    done: progress.done,total: progress.total,currentId: progress.currentId,sub: progress.sub,
    round: progress.round,rounds: progress.rounds,delivered: progress.delivered,
    current: progress.current,fill,
    ...(stepLabel !== undefined ? { stepLabel } : {}),...(subLabel !== undefined ? { subLabel } : {}),
  };
}
