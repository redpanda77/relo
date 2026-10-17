import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyPlanCommand, closePlan, EMPTY_WORK_PLAN, planLineText, planProgress, planProgressWire, planProgressWireSchema, setCurrentStepProgress, workPlanSchema, type PlanCommand, type WorkPlan } from "../src/works.js";

type Fixture = {
  name: string; plan: WorkPlan; progressOptions?: { stopped: boolean }; expected: unknown; text: string;
  variants?: Array<{ options: { paused?: boolean; ended?: "finished" | "failed" | "dropped" }; text: string }>;
};
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/plan-progress.json",import.meta.url),"utf8")) as Fixture[];

for (const fixture of fixtures) {
  test(`plan progress fixture: ${fixture.name}`,() => {
    assert.equal(workPlanSchema.safeParse(fixture.plan).success,true);
    const labelOf = (id: string) => fixture.plan.steps.find((step) => step.id === id)?.label;
    const progress = planProgress(fixture.plan,fixture.progressOptions);
    assert.deepEqual(progress,fixture.expected);
    assert.equal(planLineText(progress,labelOf),fixture.text);
    for (const variant of fixture.variants ?? []) assert.equal(planLineText(progress,labelOf,variant.options),variant.text);
  });
}

const run = (commands: PlanCommand[],now?: string,start: WorkPlan = EMPTY_WORK_PLAN) => commands.reduce((plan,command,index) => {
  const result = applyPlanCommand(plan,command,index + 2,{ sealed: false,...(now ? { now: `${now}${index}` } : {}) });
  assert.ok(result.ok,JSON.stringify(result));
  return result.plan;
},start);

test("step times: startedAt when a step becomes current, doneAt when done or skipped, only with a clock",() => {
  const plan = run([{ op: "set",steps: [{ label: "A" },{ label: "B",children: [{ label: "B1" },{ label: "B2" }] },{ label: "C" }] },{ op: "next" },{ op: "next" },{ op: "set",steps: [{ id: "s2" },{ id: "s3" },{ id: "s4" }] }],"2026-10-16T10:00:0");
  const at = (id: string) => plan.steps.find((step) => step.id === id)!;
  assert.equal(at("s1").startedAt,"2026-10-16T10:00:00");
  assert.equal(at("s1").doneAt,"2026-10-16T10:00:01");
  assert.equal(at("s3").startedAt,"2026-10-16T10:00:01");
  assert.equal(at("s3").doneAt,"2026-10-16T10:00:02");
  assert.equal(at("s4").startedAt,"2026-10-16T10:00:02");
  assert.equal(at("s4").doneAt,undefined);
  assert.equal(at("s5").doneAt,"2026-10-16T10:00:03");
  assert.equal(at("s5").startedAt,undefined);
  const plain = run([{ op: "set",steps: [{ label: "A" },{ label: "B" }] },{ op: "next" }]);
  assert.equal(plain.steps.some((step) => step.startedAt !== undefined || step.doneAt !== undefined),false);
});

test("a reopened step loses its doneAt; closing a plan stamps what it skips",() => {
  let plan = run([{ op: "set",steps: [{ label: "A" },{ label: "B" }] },{ op: "next" },{ op: "step",id: "s1" }],"2026-10-16T10:00:0");
  assert.equal(plan.steps[0]!.doneAt,undefined);
  assert.equal(plan.steps[0]!.startedAt,"2026-10-16T10:00:02");
  plan = closePlan(plan,"failed","2026-10-16T11:00:00Z");
  // Jumping back left B open (not done), so closing a failed plan skips both.
  assert.deepEqual(plan.steps.map((step) => [step.state,step.doneAt]),[["skipped","2026-10-16T11:00:00Z"],["skipped","2026-10-16T11:00:00Z"]]);
  assert.equal(workPlanSchema.safeParse(plan).success,true);
});

test("plan card fixture: the wire counts top-level steps and fills the current one by its substeps",() => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/plan-card.json",import.meta.url),"utf8")) as { plan: WorkPlan; card: { plan: unknown } };
  assert.equal(workPlanSchema.safeParse(fixture.plan).success,true);
  assert.deepEqual(planProgressWire(fixture.plan,{ readable: true }),fixture.card.plan);
  // A step's own count refines it only while it is current, and is gone once it ends.
  const flat: WorkPlan = { ...fixture.plan,steps: fixture.plan.steps.filter((step) => step.parent === undefined).map((step) => step.id === "s1" ? { ...step,state: "current" as const } : step) };
  const own = setCurrentStepProgress(flat,{ done: 1,total: 4 })!;
  assert.equal(planProgressWire(own,{ readable: false })?.fill,0.25);
  const ended = applyPlanCommand(own,{ op: "next" },2,{ sealed: false });
  assert.ok(ended.ok && ended.plan.steps.every((step) => step.progress === undefined));
  assert.equal(planProgressWire(ended.ok ? ended.plan : own,{ readable: false })?.current,2);
});

test("a substep's own progress rolls into its parent's fill: (done + fraction) / substeps",() => {
  const fixture = fixtures.find((candidate) => candidate.name.startsWith("a substep's own progress"))!;
  const wire = planProgressWire(fixture.plan,{ readable: false })!;
  assert.equal(wire.total,4);
  assert.equal(wire.current,1);
  assert.ok(Math.abs(wire.fill! - 1.75 / 3) < 1e-9);
});

test("an old-shaped plan wire (no current, no fill) still parses",() => {
  const old = { done: 1,total: 3,currentId: "s2",sub: null,round: 1,rounds: 1,delivered: false };
  assert.equal(planProgressWireSchema.safeParse(old).success,true);
  assert.equal(planProgressWireSchema.safeParse({ ...old,current: 2,fill: null }).success,true);
});

test("a round that carries unfinished steps counts the goal: batches 1-2 done, 3-4 carried read Step 3 of 4",() => {
  const base = run([{ op: "set",steps: [{ label: "B1" },{ label: "B2" },{ label: "B3" },{ label: "B4" }] },{ op: "next" },{ op: "close",outcome: "Batch 1",dropRest: true }]);
  const carried = run([{ op: "round",title: "Go on" }],undefined,base);
  assert.deepEqual(carried.steps.filter((step) => step.round === 2).map((step) => step.label),["B3","B4"]);
  const progress = planProgress(carried);
  assert.deepEqual([progress.done,progress.total,progress.current,progress.round],[2,4,3,2]);
  const wire = planProgressWire(carried,{ readable: true })!;
  assert.deepEqual([wire.done,wire.total,wire.current],[2,4,3]);
  assert.equal(planLineText(progress,(id) => carried.steps.find((step) => step.id === id)?.label),"Step 3 of 4 · B3");
  const moved = run([{ op: "next" }],undefined,carried);
  assert.deepEqual([planProgress(moved).done,planProgress(moved).total,planProgress(moved).current],[3,4,4]);
});

test("one batch finished and the rest carried: B1 done in round 1, B2 to B4 carried, Step 2 of 4",() => {
  const base = run([{ op: "set",steps: [{ label: "B1" },{ label: "B2" },{ label: "B3" },{ label: "B4" }] },{ op: "close",outcome: "Batch 1",dropRest: true }]);
  const carried = run([{ op: "round" }],undefined,base);
  const progress = planProgress(carried);
  assert.deepEqual([progress.done,progress.total,progress.current],[1,4,2]);
});

test("a round with its own plan counts alone; a chain of carried rounds counts every finished step",() => {
  const base = run([{ op: "set",steps: [{ label: "A" },{ label: "B" },{ label: "C" }] },{ op: "close",outcome: "A",dropRest: true }]);
  const own = run([{ op: "round",steps: [{ label: "X" },{ label: "Y" },{ label: "Z" }] }],undefined,base);
  assert.deepEqual([planProgress(own).done,planProgress(own).total,planProgress(own).current],[0,3,1]);
  const carried = run([{ op: "round" },{ op: "close",outcome: "B",dropRest: true },{ op: "round" }],undefined,base);
  const progress = planProgress(carried);
  assert.deepEqual([progress.round,progress.done,progress.total,progress.current],[3,2,3,3]);
});
