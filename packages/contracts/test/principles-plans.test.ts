// ADR 0008 principles 2, 3 and 4 (producers own their plan; wrong moves refused by construction; plans
// emerge and are revised in place) over the pure plan rules in src/works.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { applyPlanCommand,closePlan,EMPTY_WORK_PLAN,planComplete,setCurrentStepProgress,type PlanCommand,type WorkPlan } from "../src/works.js";

function run(commands: PlanCommand[],sealed = false): WorkPlan {
  let plan = EMPTY_WORK_PLAN;
  let version = 1;
  for (const command of commands) {
    const result = applyPlanCommand(plan,command,version + 1,{ sealed });
    assert.ok(result.ok,JSON.stringify(result));
    if (result.structural) version += 1;
    plan = result.plan;
  }
  return plan;
}
const shape = (plan: WorkPlan) => plan.steps.map((step) => `${step.id}:${step.state}`).join(" ");
const refusal = (plan: WorkPlan,command: PlanCommand,sealed = false) => {
  const result = applyPlanCommand(plan,command,9,{ sealed });
  assert.equal(result.ok,false);
  return (result as { code: string }).code;
};

test("principle 4: an empty plan is never complete (no placeholder counts as progress)",() => {
  assert.equal(planComplete(EMPTY_WORK_PLAN),false);
});

test("principle 2: the producer may jump to any step; the current one is marked done",() => {
  const plan = run([{ op: "set",steps: [{ label: "Read" },{ label: "Change" },{ label: "Check" }] },{ op: "step",id: "s3" }]);
  assert.equal(shape(plan),"s1:done s2:open s3:current");
});

test("principle 2: next past the last step completes the plan",() => {
  const plan = run([{ op: "set",steps: [{ label: "Read" },{ label: "Change" }] },{ op: "next" },{ op: "next" }]);
  assert.equal(shape(plan),"s1:done s2:done");
  assert.equal(planComplete(plan),true);
});

test("principle 3: an unknown step, a twice-listed step and a new step before current are refused",() => {
  const plan = run([{ op: "set",steps: [{ label: "Read" },{ label: "Change" }] }]);
  assert.equal(refusal(plan,{ op: "step",id: "s7" }),"step_not_found");
  assert.equal(refusal(plan,{ op: "set",steps: [{ id: "s1" },{ id: "s1" }] }),"plan_ids_invalid");
  assert.equal(refusal(plan,{ op: "set",steps: [{ label: "Earlier" },{ id: "s1" },{ id: "s2" }] }),"plan_ids_invalid");
});

test("principle 3: a sealed work refuses revise by labels and readable labels on add",() => {
  const plan = run([{ op: "set",steps: [{},{}] }],true);
  assert.equal(refusal(plan,{ op: "revise",labels: ["Read"] },true),"labels_sealed");
  assert.equal(refusal(plan,{ op: "add",steps: [{ label: "More" }] },true),"labels_sealed");
});

test("principle 4: extending in place appends with the next id and keeps done steps first",() => {
  const plan = run([
    { op: "set",steps: [{ label: "Read" },{ label: "Change" }] },
    { op: "next" },
    { op: "add",steps: [{ label: "Check" }] },
    { op: "set",steps: [{ id: "s3" },{ id: "s2" }] },
  ]);
  assert.equal(shape(plan),"s1:done s3:open s2:current");
});

test("principle 2: applying a command never mutates the producer's previous plan",() => {
  const before = run([{ op: "set",steps: [{ label: "Read" },{ label: "Change" }] }]);
  const copy = JSON.stringify(before);
  applyPlanCommand(before,{ op: "next" },3,{ sealed: false });
  closePlan(before,"failed");
  setCurrentStepProgress(before,{ done: 1,total: 2 });
  assert.equal(JSON.stringify(before),copy);
});

test("principle 2: a failed or dropped finish never claims the current step was done",() => {
  const plan = run([{ op: "set",steps: [{ label: "Read" },{ label: "Change" }] }]);
  assert.equal(shape(closePlan(plan,"failed")),"s1:skipped s2:skipped");
  assert.equal(shape(closePlan(plan,"dropped")),"s1:skipped s2:skipped");
});

test("principle 3: step progress needs a current step and can be cleared",() => {
  const plan = run([{ op: "set",steps: [{ label: "Read" }] }]);
  const withProgress = setCurrentStepProgress(plan,{ done: 1,total: 4 });
  assert.deepEqual(withProgress?.steps[0]?.progress,{ done: 1,total: 4 });
  assert.equal(setCurrentStepProgress(withProgress!,null)?.steps[0]?.progress,undefined);
  assert.equal(setCurrentStepProgress(closePlan(plan,"finished"),{ done: 1,total: 2 }),null);
});
