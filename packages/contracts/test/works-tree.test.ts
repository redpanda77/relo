import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPlanCommand,closePlan,currentPath,EMPTY_WORK_PLAN,lastRound,openRound,planComplete,stepDepth,workPlanSchema,
  type PlanCommand,type WorkPlan,
} from "../src/works.js";

function run(commands: PlanCommand[],sealed = false,start: WorkPlan = EMPTY_WORK_PLAN): WorkPlan {
  let plan = start;
  commands.forEach((command,index) => {
    const result = applyPlanCommand(plan,command,index + 2,{ sealed,now: "2026-10-16T10:00:00Z" });
    assert.ok(result.ok,JSON.stringify(result));
    plan = result.plan;
  });
  return plan;
}
const refused = (plan: WorkPlan,command: PlanCommand,sealed = false) => {
  const result = applyPlanCommand(plan,command,9,{ sealed });
  return result.ok ? "ok" : result.code;
};
const shape = (plan: WorkPlan) => plan.steps.map((step) => `${step.id}${step.parent ? `<${step.parent}` : ""}:${step.state}`).join(" ");
const tree: PlanCommand = { op: "set",steps: [
  { label: "A",children: [{ label: "A1" },{ label: "A2",children: [{ label: "A2a" }] }] },
  { label: "B" },
] };

test("nested entries get pre-order ids; parents are never current and derive their state",() => {
  const plan = run([tree]);
  assert.equal(shape(plan),"s1:open s2<s1:current s3<s1:open s4<s3:open s5:open");
  assert.deepEqual(currentPath(plan).map((step) => step.id),["s1","s2"]);
  assert.equal(stepDepth(plan,"s4"),3);
  assert.equal(workPlanSchema.safeParse(plan).success,true);
});

test("depth 4 is refused",() => {
  const deep: PlanCommand = { op: "add",steps: [{ label: "a",children: [{ label: "b",children: [{ label: "c",children: [{ label: "d" }] }] }] }] };
  assert.equal(refused(EMPTY_WORK_PLAN,deep),"plan_too_deep");
  const plan = run([tree]);
  assert.equal(refused(plan,{ op: "add",under: "s4",steps: [{ label: "x" }] }),"plan_too_deep");
});

test("next moves leaf to leaf across subtrees and parents turn done",() => {
  let plan = run([tree]);
  plan = run([{ op: "next" }],false,plan);
  assert.equal(shape(plan),"s1:open s2<s1:done s3<s1:open s4<s3:current s5:open");
  plan = run([{ op: "next" }],false,plan);
  assert.equal(shape(plan),"s1:done s2<s1:done s3<s1:done s4<s3:done s5:current");
  assert.equal(planComplete(plan),false);
  assert.equal(planComplete(run([{ op: "next" }],false,plan)),true);
});

test("step needs a leaf",() => {
  const plan = run([tree]);
  assert.equal(refused(plan,{ op: "step",id: "s1" }),"plan_invalid");
  assert.equal(refused(plan,{ op: "step",id: "s5" }),"ok");
});

test("add under puts children last in the subtree and keeps pre-order",() => {
  const plan = run([tree,{ op: "add",under: "s1",steps: [{ label: "A3",children: [{ label: "A3a" }] }] },{ op: "add",steps: [{ label: "C" }] }]);
  assert.equal(shape(plan),"s1:open s2<s1:current s3<s1:open s4<s3:open s6<s1:open s7<s6:open s5:open s8:open");
  assert.equal(refused(plan,{ op: "add",under: "s99",steps: [{ label: "x" }] }),"step_not_found");
});

test("sealed works predict ids in pre-order and refuse text",() => {
  const plan = run([{ op: "set",steps: [{ id: "s1",children: [{ id: "s2" },{ id: "s3" }] }] }],true);
  assert.equal(shape(plan),"s1:open s2<s1:current s3<s1:open");
  assert.equal(refused(plan,{ op: "add",steps: [{ id: "s5" }] },true),"plan_ids_invalid");
  assert.equal(refused(plan,{ op: "detail",detail: "x" },true),"labels_sealed");
  assert.equal(refused(plan,{ op: "add",steps: [{ detail: "x" }] },true),"labels_sealed");
  assert.equal(refused(plan,{ op: "close",outcome: "done" },true),"labels_sealed");
  assert.equal(refused(plan,{ op: "close" },true),"open_steps");
  assert.equal(refused(plan,{ op: "close",dropRest: true },true),"ok");
});

test("rounds: refused while open; close then round; set leaves closed rounds alone",() => {
  let plan = run([{ op: "set",steps: [{ label: "A" },{ label: "B" }] }]);
  assert.equal(refused(plan,{ op: "round",title: "Two" }),"round_open");
  assert.equal(refused(plan,{ op: "close" }),"open_steps");
  assert.equal(refused(plan,{ op: "close",dropRest: true }),"ok");
  plan = run([{ op: "next" },{ op: "close",outcome: "Shipped A" }],false,plan);
  assert.equal(shape(plan),"s1:done s2:done");
  assert.deepEqual(plan.rounds,[{ n: 1,state: "closed",outcome: "Shipped A",closedAt: "2026-10-16T10:00:00Z" }]);
  assert.equal(openRound(plan),undefined);
  assert.equal(refused(plan,{ op: "close" }),"no_open_round");
  assert.equal(refused(plan,{ op: "add",steps: [{ label: "x" }] }),"no_open_round");
  assert.equal(refused(plan,{ op: "next" }),"no_open_round");
  plan = run([{ op: "round",title: "Second",steps: [{ label: "C" },{ label: "D",children: [{ label: "D1" }] }] }],false,plan);
  assert.equal(plan.rounds?.length,2);
  assert.deepEqual(openRound(plan),{ n: 2,state: "open",title: "Second",openedAt: "2026-10-16T10:00:00Z" });
  assert.equal(shape(plan),"s1:done s2:done s3:current s4:open s5<s4:open");
  assert.deepEqual(plan.steps.map((step) => step.round),[1,1,2,2,2]);
  plan = run([{ op: "set",steps: [{ id: "s4",children: [{ id: "s5" }] }] }],false,plan);
  assert.equal(shape(plan),"s1:done s2:done s4:open s5<s4:current s3:skipped");
  assert.equal(refused(plan,{ op: "set",steps: [{ id: "s2" }] }),"plan_ids_invalid");
  assert.equal(refused(plan,{ op: "step",id: "s1" }),"plan_invalid");
  assert.equal(lastRound(plan).n,2);
});

test("closePlan closes the open round only when rounds exist",() => {
  const flat = run([{ op: "set",steps: [{ label: "A" },{ label: "B" }] }]);
  assert.equal(closePlan(flat,"finished").rounds,undefined);
  const withRounds = run([{ op: "close",dropRest: true },{ op: "round",steps: [{ label: "C" },{ label: "D" }] }],false,flat);
  const closed = closePlan(withRounds,"finished","2026-10-16T11:00:00Z");
  assert.deepEqual(closed.rounds?.[1],{ n: 2,state: "closed",openedAt: "2026-10-16T10:00:00Z",closedAt: "2026-10-16T11:00:00Z" });
  assert.equal(shape(closed),"s1:done s2:skipped s3:done s4:skipped");
  const nested = closePlan(run([tree]),"finished");
  assert.equal(shape(nested),"s1:done s2<s1:done s3<s1:skipped s4<s3:skipped s5:skipped");
});

test("detail op targets the current step or an id",() => {
  let plan = run([{ op: "set",steps: [{ label: "A" },{ label: "B" }] },{ op: "detail",detail: "why A" },{ op: "detail",id: "s2",detail: "why B" }]);
  assert.deepEqual(plan.steps.map((step) => step.detail),["why A","why B"]);
  plan = run([{ op: "detail",detail: "" }],false,plan);
  assert.equal(plan.steps[0]!.detail,undefined);
  assert.equal(refused(plan,{ op: "detail",id: "s9",detail: "x" }),"step_not_found");
});

test("caps: 30 per round, 120 in all",() => {
  const many = (count: number) => Array.from({ length: count },(_,index) => ({ label: `L${index}` }));
  let plan = run([{ op: "set",steps: many(30) }]);
  assert.equal(refused(plan,{ op: "add",steps: [{ label: "one more" }] }),"plan_too_long");
  for (let round = 2; round <= 4; round += 1) plan = run([{ op: "close",dropRest: true },{ op: "round",steps: many(30) }],false,plan);
  assert.equal(plan.steps.length,120);
});

test("over the 120 cap, closed rounds are pruned oldest first; ids are never reused; the open round alone can still be too long",() => {
  const many = (count: number) => Array.from({ length: count },(_,index) => ({ label: `L${index}` }));
  let plan = run([{ op: "set",steps: many(30) }]);
  for (let round = 2; round <= 4; round += 1) plan = run([{ op: "close",dropRest: true },{ op: "round",title: `R${round}`,steps: many(30) }],false,plan);
  assert.equal(plan.steps.length,120);
  const next = plan.next;
  plan = run([{ op: "close",outcome: "four done",dropRest: true },{ op: "round",steps: [{ label: "x" },{ label: "y" }] }],false,plan);
  // Only the oldest round gave up steps, and its skipped ones first: the one step it finished stays.
  assert.equal(plan.steps.length,93);
  assert.deepEqual(plan.steps.filter((step) => step.round === 1).map((step) => step.state),["done"]);
  assert.equal(plan.steps.filter((step) => step.round === 4).length,30);
  assert.equal(plan.rounds?.length,5);
  assert.equal(plan.rounds?.[0]?.state,"closed");
  assert.equal(plan.rounds?.[3]?.outcome,"four done");
  assert.deepEqual(plan.steps.slice(-2).map((step) => step.id),[`s${next}`,`s${next + 1}`]);
  plan = run([{ op: "add",steps: [{ label: "z" }] }],false,plan);
  assert.equal(plan.steps.at(-1)?.id,`s${next + 2}`);
  assert.equal(plan.next,next + 3);
  plan = run([{ op: "close",dropRest: true },{ op: "round",steps: many(30) }],false,plan);
  assert.equal(plan.steps.length <= 120,true);
  assert.equal(plan.next,next + 33);
  assert.equal(plan.steps.at(-1)?.id,`s${next + 32}`);
  assert.equal(refused(run([{ op: "set",steps: many(30) }]),{ op: "add",steps: [{ label: "one more" }] }),"plan_too_long");
});

test("old plans without the new fields parse and behave as before",() => {
  const old = { v: 1,next: 4,steps: [{ id: "s1",state: "done",addedIn: 1,label: "A" },{ id: "s2",state: "current",addedIn: 1,label: "B" },{ id: "s3",state: "open",addedIn: 1 }] };
  const parsed = workPlanSchema.parse(old);
  assert.equal(openRound(parsed)?.n,1);
  const next = run([{ op: "next" }],false,parsed);
  assert.equal(shape(next),"s1:done s2:done s3:current");
  assert.equal(next.rounds,undefined);
  assert.equal(next.steps.every((step) => step.round === undefined),true);
});

test("schema invariants: parent order, rounds, current parent",() => {
  const base = { v: 1 as const,next: 5 };
  const step = (id: string,extra: object = {}) => ({ id,state: "open" as const,addedIn: 1,...extra });
  assert.equal(workPlanSchema.safeParse({ ...base,steps: [step("s1",{ parent: "s2" }),step("s2")] }).success,false);
  assert.equal(workPlanSchema.safeParse({ ...base,steps: [step("s1"),step("s2",{ parent: "s1",round: 2 })],rounds: [{ n: 1,state: "closed" },{ n: 2,state: "open" }] }).success,false);
  assert.equal(workPlanSchema.safeParse({ ...base,steps: [step("s1",{ state: "current" }),step("s2",{ parent: "s1" })] }).success,false);
  assert.equal(workPlanSchema.safeParse({ ...base,steps: [],rounds: [{ n: 1,state: "open" },{ n: 2,state: "open" }] }).success,false);
  assert.equal(workPlanSchema.safeParse({ ...base,steps: [],rounds: [{ n: 2,state: "open" }] }).success,false);
  assert.equal(workPlanSchema.safeParse({ ...base,steps: [step("s1",{ round: 3 })] }).success,false);
});

test("close refuses open top-level steps unless dropRest; the last current step is finished by the close",() => {
  const four = run([{ op: "set",steps: [{ label: "B1" },{ label: "B2" },{ label: "B3" },{ label: "B4" }] },{ op: "next" }]);
  const result = applyPlanCommand(four,{ op: "close",outcome: "B1 done" },9,{ sealed: false });
  assert.equal(result.ok,false);
  if (!result.ok) { assert.equal(result.code,"open_steps"); assert.match(result.message,/open steps: s3 B3, s4 B4$/u); }
  const last = run([{ op: "next" },{ op: "next" }],false,four);
  assert.equal(refused(last,{ op: "close" }),"ok");
  assert.equal(refused(run([tree]),{ op: "close" }),"open_steps");
  const dropped = run([{ op: "close",dropRest: true }],false,four);
  // The current step counts as done; the open ones are skipped and marked as dropped by the close.
  assert.equal(shape(dropped),"s1:done s2:done s3:skipped s4:skipped");
  assert.deepEqual(dropped.steps.map((step) => step.dropped),[undefined,undefined,true,true]);
});

test("a round without steps carries the unfinished steps as new steps; with steps it carries nothing",() => {
  const closed = run([{ op: "set",steps: [{ label: "B1" },{ label: "B2",children: [{ label: "B2a" },{ label: "B2b" }] },{ label: "B3" }] },{ op: "close",outcome: "B1",dropRest: true }]);
  assert.equal(shape(closed),"s1:done s2:skipped s3<s2:skipped s4<s2:skipped s5:skipped");
  const carried = run([{ op: "round",title: "Go on" }],false,closed);
  assert.equal(carried.steps.slice(0,5).every((step) => step.round === 1),true);
  assert.deepEqual(carried.steps.slice(5).map((step) => [step.label,step.parent,step.state,step.round,step.carriedFrom]),
    [["B2",undefined,"open",2,1],["B2a","s6","current",2,1],["B2b","s6","open",2,1],["B3",undefined,"open",2,1]]);
  assert.equal(workPlanSchema.safeParse(carried).success,true);
  const finished = run([{ op: "set",steps: [{ label: "A",children: [{ label: "A1" },{ label: "A2" },{ label: "A3" }] },{ label: "B" }] },{ op: "next" },{ op: "close",dropRest: true }]);
  const nested = run([{ op: "round" }],false,finished);
  assert.deepEqual(nested.steps.filter((step) => step.round === 2).map((step) => [step.label,step.parent,step.state]),[["A",undefined,"open"],["A3","s6","current"],["B",undefined,"open"]]);
  const own = run([{ op: "round",steps: [{ label: "Fresh" }] }],false,closed);
  assert.deepEqual(own.steps.filter((step) => step.round === 2).map((step) => [step.label,step.carriedFrom]),[["Fresh",undefined]]);
  const none = run([{ op: "set",steps: [{ label: "A" }] },{ op: "close" },{ op: "round",title: "Next" }]);
  assert.equal(none.steps.length,1);
});

test("a step the agent skipped is not carried",() => {
  const closed = run([{ op: "set",steps: [{ label: "A" },{ label: "B" },{ label: "C" },{ label: "D" }] },{ op: "set",steps: [{ id: "s1" },{ id: "s3" }] },{ op: "close",dropRest: true }]);
  const carried = run([{ op: "round" }],false,closed);
  assert.deepEqual(carried.steps.filter((step) => step.round === 2).map((step) => step.label),["C"]);
});

test("next advances to the next open leaf after the current one, wrapping only when none follows",() => {
  const four = run([{ op: "set",steps: [{ label: "A" },{ label: "B" },{ label: "C" },{ label: "D" }] }]);
  // Back to s1 from s3 leaves s3 open: next goes on to s3 (the one after), and nothing is revisited.
  const back = run([{ op: "step",id: "s3" },{ op: "step",id: "s1" }],false,four);
  assert.equal(shape(back),"s1:current s2:done s3:open s4:open");
  assert.equal(shape(run([{ op: "next" }],false,back)),"s1:done s2:done s3:current s4:open");
  // An open step before the current one is passed over until none follows.
  const before = run([{ op: "step",id: "s3" },{ op: "add",after: "s1",steps: [{ label: "X" }] }],false,four);
  assert.equal(shape(before),"s1:done s5:open s2:done s3:current s4:open");
  const ahead = run([{ op: "next" }],false,before);
  assert.equal(shape(ahead),"s1:done s5:open s2:done s3:done s4:current");
  assert.equal(shape(run([{ op: "next" }],false,ahead)),"s1:done s5:current s2:done s3:done s4:done");
});

test("add after a step lands as its sibling past its children",() => {
  const plan = run([tree,{ op: "add",after: "s1",steps: [{ label: "A+" }] }]);
  assert.equal(shape(plan),"s1:open s2<s1:current s3<s1:open s4<s3:open s6:open s5:open");
  assert.equal(refused(plan,{ op: "add",after: "s2",under: "s1",steps: [{ label: "x" }] }),"plan_invalid");
  assert.equal(refused(plan,{ op: "add",after: "s99",steps: [{ label: "x" }] }),"step_not_found");
  const nested = run([{ op: "add",after: "s3",steps: [{ label: "A3b" }] }],false,run([tree]));
  assert.equal(shape(nested),"s1:open s2<s1:current s3<s1:open s4<s3:open s6<s1:open s5:open");
  assert.equal(refused(run([tree]),{ op: "add",after: "s4",steps: [{ label: "x",children: [{ label: "y" }] }] }),"plan_too_deep");
});
