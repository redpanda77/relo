import assert from "node:assert/strict";
import test from "node:test";
import { applyPlanCommand,closePlan,EMPTY_WORK_PLAN,type PlanCommand,type WorkPlan } from "../src/works.js";

function run(commands: PlanCommand[],sealed = false): { plan: WorkPlan; version: number } {
  let plan = EMPTY_WORK_PLAN;
  let version = 1;
  for (const command of commands) {
    const result = applyPlanCommand(plan,command,version + 1,{ sealed });
    assert.ok(result.ok,JSON.stringify(result));
    if (result.structural) version += 1;
    plan = result.plan;
  }
  return { plan,version };
}
const shape = (plan: WorkPlan) => plan.steps.map((step) => `${step.id}:${step.state}`).join(" ");

test("an emergent plan keeps stable ids and never deletes steps",() => {
  const { plan } = run([
    { op: "set",steps: [{ label: "Read" },{ label: "Change" }] },
    { op: "next" },
    { op: "add",steps: [{ label: "Test" },{ label: "Docs" }] },
    { op: "set",steps: [{ id: "s2" },{ id: "s3" },{ label: "Release" }] },
    { op: "step",id: "s3" },
  ]);
  assert.equal(shape(plan),"s1:done s2:done s3:current s5:open s4:skipped");
  assert.equal(plan.next,6);
});

test("revise matches labels and re-lists skipped steps as open",() => {
  const { plan } = run([
    { op: "set",steps: [{ label: "A" },{ label: "B" },{ label: "C" }] },
    { op: "revise",labels: ["A","C"] },
    { op: "revise",labels: ["A","B","C"] },
  ]);
  assert.deepEqual(plan.steps.map((step) => step.label),["A","B","C"]);
  assert.ok(plan.steps.every((step) => step.state !== "skipped"));
});

test("sealed plans refuse labels and mispredicted ids",() => {
  const sealed = applyPlanCommand(EMPTY_WORK_PLAN,{ op: "set",steps: [{ id: "s1" },{ id: "s2" }] },2,{ sealed: true });
  assert.ok(sealed.ok);
  const wrong = applyPlanCommand(sealed.plan,{ op: "add",steps: [{ id: "s7" }] },3,{ sealed: true });
  assert.equal(wrong.ok ? "ok" : wrong.code,"plan_ids_invalid");
  const labelled = applyPlanCommand(sealed.plan,{ op: "add",steps: [{ label: "x" }] },3,{ sealed: true });
  assert.equal(labelled.ok ? "ok" : labelled.code,"labels_sealed");
});

test("plans hold at most 30 steps; unknown steps are named",() => {
  const { plan } = run([{ op: "set",steps: Array.from({ length: 30 },(_,index) => ({ label: `L${index}` })) }]);
  const over = applyPlanCommand(plan,{ op: "add",steps: [{ label: "one more" }] },3,{ sealed: false });
  assert.equal(over.ok ? "ok" : over.code,"plan_too_long");
  const unknown = applyPlanCommand(plan,{ op: "step",id: "s99" },3,{ sealed: false });
  assert.equal(unknown.ok ? "ok" : unknown.code,"step_not_found");
});

test("finishing skips open steps and completes the current one",() => {
  const { plan } = run([{ op: "set",steps: [{ label: "A" },{ label: "B" }] }]);
  assert.equal(shape(closePlan(plan,"finished")),"s1:done s2:skipped");
  assert.equal(shape(closePlan(plan,"failed")),"s1:skipped s2:skipped");
});

test("handoff: the request takes a note, start takes a handle in place of a goal, and the new codes exist",async () => {
  const { workHandoffRequestSchema,workStartRequestSchema,WORK_DISPOSITIONS,WORK_REFUSAL_CODES } = await import("../src/works.js");
  assert.ok(workHandoffRequestSchema.safeParse({ next: { readable: "Handing off: wire the verb" } }).success);
  assert.ok(workHandoffRequestSchema.safeParse({ next: { sealed: true },sealed: {},producerSealed: {} }).success);
  assert.equal(workHandoffRequestSchema.safeParse({}).success,false);
  assert.equal(workHandoffRequestSchema.safeParse({ next: { readable: "x".repeat(121) } }).success,false);
  assert.equal(workHandoffRequestSchema.safeParse({ next: { readable: "ok" },extra: 1 }).success,false);
  assert.ok(workStartRequestSchema.safeParse({ from: "rh_abc" }).success);
  assert.ok(workStartRequestSchema.safeParse({ goal: { readable: "Ship" } }).success);
  assert.equal(workStartRequestSchema.safeParse({}).success,false,"a start needs a goal or a handle");
  for (const disposition of ["handed_off","taken_over"]) assert.ok((WORK_DISPOSITIONS as readonly string[]).includes(disposition));
  for (const code of ["handoff_invalid","handoff_finished"]) assert.ok((WORK_REFUSAL_CODES as readonly string[]).includes(code));
});
