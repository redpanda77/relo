// Plan trees and rounds, locally (ADR 0012): the --plan parser, the CLI's mirror of the contracts' plan rules,
// the echo of a tree and of folded rounds, and the sealed card text v2.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { MAX_CARD_CONTENT_BYTES, fitCardText } from "../src/crypto/seal-card.mjs";
import { workCardText } from "../src/crypto/seal-work.mjs";
import { cardLine, renderEcho } from "../src/work/echo.mjs";
import { applyChange, deliverPlan, finishPlan, isDelivered, openRoundPlan, parsePlan, planCommands, startPlan } from "../src/work/plan.mjs";
import { idEntries, sealedStart, sealedUpdate } from "../src/work/sealed-form.mjs";

const contracts = new URL("../../contracts/dist/src/works.js", import.meta.url);
const skip = !existsSync(contracts) && "build @relo/notification-contracts first";

test("--plan nests by indentation in a newline list: two spaces or a tab per level, at most three levels", () => {
  const table = [
    ["A,B,C", [{ label: "A" }, { label: "B" }, { label: "C" }]],
    ["A\nB\nC", [{ label: "A" }, { label: "B" }, { label: "C" }]],
    ["A\n  B\n  C\nD", [{ label: "A", children: [{ label: "B" }, { label: "C" }] }, { label: "D" }]],
    ["A\n\tB\n\t\tC", [{ label: "A", children: [{ label: "B", children: [{ label: "C" }] }] }]],
    ["A\n    B\n      C", [{ label: "A", children: [{ label: "B", children: [{ label: "C" }] }] }], "a jump of two levels reads as one"],
    ["  A\n  B", [{ label: "A" }, { label: "B" }], "a first line that is indented is a top-level step"],
    ["A\n B", [{ label: "A" }, { label: "B" }], "one space is not a level"],
    ["Check logs, metrics\n  Read the errors, then the warnings", [{ label: "Check logs, metrics", children: [{ label: "Read the errors, then the warnings" }] }], "commas inside a line stay in it"],
    ["A\r\n  B\r\n", [{ label: "A", children: [{ label: "B" }] }]],
  ];
  for (const [value, expected, why] of table) assert.deepEqual(parsePlan(value), expected, why ?? JSON.stringify(value));
  assert.throws(() => parsePlan("A\n  B\n    C\n      D"), (error) => error.code === "REFUSED_PLAN_DEPTH" && /^step "D" would sit deeper than 3 levels/u.test(error.what) && /three levels/u.test(error.next) && Boolean(error.state));
  assert.throws(() => parsePlan("A\n\tB\n\t\tC\n\t\t\tD"), { code: "REFUSED_PLAN_DEPTH" });
  assert.throws(() => parsePlan("Install (owner, later"), { code: "REFUSED_PLAN_LIST" }, "single-line bracket rules stay");
});

test("a tree starts with ids in pre-order, only leaves are current, next moves from leaf to leaf, parents follow", () => {
  const { plan } = startPlan(parsePlan("Read\nBuild\n  Parse\n  Write\n    Quote\nVerify"));
  assert.deepEqual(plan.steps.map((s) => [s.id, s.parent, s.state]), [["s1", undefined, "current"], ["s2", undefined, "open"], ["s3", "s2", "open"], ["s4", "s2", "open"], ["s5", "s4", "open"], ["s6", undefined, "open"]]);
  let at = plan;
  for (const expected of ["s3", "s5", "s6"]) {
    at = applyChange(at, { nextStep: true }).plan;
    assert.equal(at.steps.find((s) => s.state === "current")?.id, expected);
  }
  at = applyChange(at, { nextStep: true }).plan;
  assert.deepEqual(at.steps.map((s) => s.state), ["done", "done", "done", "done", "done", "done"], "a parent is done when its children are");
  assert.throws(() => applyChange(plan, { step: "s2" }), { code: "REFUSED_STEP_HAS_CHILDREN" });
});

test("--add --under puts steps last under a step, after its subtree, in pre-order", () => {
  const { plan } = startPlan(parsePlan("Build\n  Parse\nVerify"));
  const added = applyChange(plan, { add: ["Quote"], under: "s1" });
  assert.deepEqual(added.plan.steps.map((s) => [s.id, s.parent]), [["s1", undefined], ["s2", "s1"], ["s4", "s1"], ["s3", undefined]]);
  assert.equal(added.plan.steps.find((s) => s.state === "current").id, "s2");
  assert.deepEqual(added.trees.add, [{ id: "s4", label: "Quote", isNew: true }]);
  assert.equal(added.moved.under, "s1");
  const byLabel = applyChange(plan, { add: ["Escape"], under: "Build" });
  assert.equal(byLabel.plan.steps.find((s) => s.label === "Escape").parent, "s1", "a step by its label");
});

test("a flat --plan that restates the phases keeps their steps; leaving a phase out skips it with its steps", () => {
  const { plan } = startPlan(parsePlan("Explore\n  Read the code\n  Map the hooks\nBuild\n  Write it\nShip"));
  const kept = applyChange(plan, { plan: parsePlan("Explore,Build,Ship") });
  assert.deepEqual(kept.plan.steps.filter((s) => s.state === "skipped").map((s) => s.id), []);
  assert.deepEqual(kept.plan.steps.map((s) => [s.id, s.parent]), [["s1", undefined], ["s2", "s1"], ["s3", "s1"], ["s4", undefined], ["s5", "s4"], ["s6", undefined]]);
  const dropped = applyChange(plan, { plan: parsePlan("Explore,Ship") });
  assert.deepEqual(dropped.plan.steps.filter((s) => s.state === "skipped").map((s) => s.id), ["s4", "s5"]);
  const relisted = applyChange(plan, { plan: parsePlan("Explore\n  Read the code\nBuild,Ship".replace(",", "\n").replace(",", "\n")) });
  assert.deepEqual(relisted.plan.steps.filter((s) => s.state === "skipped").map((s) => s.id), ["s3"], "listing children changes them");
});

test("a step under the current leaf takes over as the current step; three levels is the limit", () => {
  let { plan } = startPlan(parsePlan("Build\nVerify"));
  plan = applyChange(plan, { add: ["Parse"], under: "s1" }).plan;
  assert.deepEqual(plan.steps.map((s) => [s.id, s.parent, s.state]), [["s1", undefined, "open"], ["s3", "s1", "current"], ["s2", undefined, "open"]]);
  plan = applyChange(plan, { add: ["Quote"], under: "s3" }).plan;
  assert.throws(() => applyChange(plan, { add: ["Escape"], under: "s4" }), { code: "REFUSED_PLAN_DEPTH" });
  assert.throws(() => applyChange(plan, { add: ["Nope"], under: "s77" }), { code: "REFUSED_UNKNOWN_STEP" });
  assert.throws(() => applyChange(plan, { add: ["Parse"], under: "s1" }), { code: "REFUSED_DUPLICATE_STEP" });
});

test("deliver closes the round (rounds array, steps stamped round 1); the next round opens only on a closed one", () => {
  const { plan } = startPlan(["Build it", "Verify it"]);
  const { plan: delivered } = deliverPlan(applyChange(plan, { nextStep: true }).plan, "Built and verified");
  assert.deepEqual(delivered.rounds, [{ n: 1, state: "closed", outcome: "Built and verified" }]);
  assert.deepEqual(delivered.steps.map((s) => [s.state, s.round]), [["done", 1], ["done", 1]], "the current step counts as done");
  assert.equal(isDelivered({ lifecycle: "open", plan: delivered }), true);
  assert.equal(isDelivered({ lifecycle: "finished", plan: delivered }), false);
  assert.throws(() => applyChange(delivered, { nextStep: true }, true, "open"), { code: "REFUSED_ROUND_CLOSED" });
  assert.throws(() => openRoundPlan(plan, "More"), { code: "REFUSED_ROUND_OPEN" });
  const { plan: two, tree } = openRoundPlan(delivered, "Add a retry", parsePlan("Write it\nTest it"));
  assert.deepEqual(two.rounds.map((r) => [r.n, r.state, r.title]), [[1, "closed", undefined], [2, "open", "Add a retry"]]);
  assert.deepEqual(two.steps.map((s) => [s.id, s.round, s.state]), [["s1", 1, "done"], ["s2", 1, "done"], ["s3", 2, "current"], ["s4", 2, "open"]]);
  assert.deepEqual(tree.map((n) => n.id), ["s3", "s4"]);
  const finished = finishPlan(two, "finished", "All of it").plan;
  assert.deepEqual(finished.rounds.map((r) => [r.n, r.state, r.outcome]), [[1, "closed", "Built and verified"], [2, "closed", "All of it"]]);
});

/**
 * ONE plan engine: the CLI applies the very rules the server does (a generated copy of contracts plan-engine.ts).
 * Regression (16 Oct): the old hand port diverged after a revision, so the step ids of a sealed work's labels
 * (sent by id in the sealed card text) landed on the wrong steps ("Step 17" on the phone). A sealed work is the
 * strict case: the server sees ids only, so every id must be the one the CLI predicted.
 */
test("local and server plans stay identical through revisions, nested additions and next-steps (sealed wire)", { skip }, async () => {
  const c = await import(contracts.href);
  const shape = (plan) => JSON.stringify({ next: plan.next, steps: plan.steps.map((s) => [s.id, s.state, s.parent, s.round, s.detail]), rounds: plan.rounds?.map((r) => [r.n, r.state, r.outcome]) });
  const scenario = (start, changes) => {
    const first = startPlan(parsePlan(start));
    let local = first.plan;
    let remote = c.applyPlanCommand(c.EMPTY_WORK_PLAN, sealedStart({ plan: { op: "set", steps: [] } }, first.tree).plan, 1, { sealed: true }).plan;
    assert.equal(shape(local), shape(remote), `start ${JSON.stringify(start)}`);
    let version = 1;
    for (const change of changes) {
      const outcome = applyChange(local, change, true, "x");
      local = outcome.plan;
      const stepId = change.step === undefined ? undefined : /^s\d+$/u.test(change.step) ? change.step : local.steps.find((s) => s.state === "current")?.id;
      for (const command of planCommands(change, stepId, { trees: outcome.trees, sealed: true, under: outcome.moved.under })) {
        version += 1;
        const sent = sealedUpdate({ plan: command }, { trees: outcome.trees }).plan;
        if (!sent) continue;
        const result = c.applyPlanCommand(remote, sent, version, { sealed: true });
        assert.ok(result.ok, `${JSON.stringify(sent)}: ${result.message}`);
        remote = result.plan;
      }
      assert.equal(shape(local), shape(remote), JSON.stringify(change));
    }
    return { local, remote };
  };
  scenario("Read\nBuild\n  Parse\n  Write\n    Quote\nVerify", [{ nextStep: true }, { nextStep: true }, { add: ["Escape"], under: "s4" }, { nextStep: true }, { step: "s6" }]);
  scenario("A one\nB two\nC three", [{ nextStep: true }, { plan: ["B two", "D four", "E five"] }, { add: ["F six"] }]);
  scenario("A one\nB two", [{ plan: [{ label: "A one", children: [{ label: "A child" }] }, { label: "B two" }] }, { nextStep: true }]);
  // The live divergence: a flat plan revised with --plan (a step dropped, nested additions), then next-step x3.
  const { local, remote } = scenario("Audit\nBuild\nCheck\nShip\nTell\nClose", [
    { nextStep: true },
    { plan: parsePlan("Build\n  Write the test\n  Fix the race\nShip\nAnnounce\nClose") },
    { nextStep: true }, { nextStep: true }, { nextStep: true },
  ]);
  const byLabel = (plan, label) => plan.steps.find((s) => s.label === label);
  assert.deepEqual(["Audit", "Build", "Write the test", "Fix the race", "Ship", "Announce", "Close"].map((l) => byLabel(local, l).id), ["s1", "s2", "s7", "s8", "s4", "s9", "s6"], "ids are the server's, in order");
  assert.deepEqual(local.steps.map((s) => `${s.id}:${s.state}`), remote.steps.map((s) => `${s.id}:${s.state}`));
  assert.equal(byLabel(local, "Announce").state, "current");
  assert.equal(byLabel(local, "Ship").state, "done");
  assert.equal(byLabel(local, "Check").state, "skipped");
  // the sealed card text puts each label on the id the server holds
  const card = workCardText({ goal: "G", plan: local });
  const ids = new Map(card.phases[0].steps.map((s) => [s.id, s.label]));
  for (const step of remote.steps.filter((s) => s.state !== "skipped")) assert.equal(ids.get(step.id), byLabel(local, ids.get(step.id)).label);
  // deliver and open round 2
  const delivered = deliverPlan(local, "Done for now", { dropRest: true }).plan;
  const closed = c.applyPlanCommand(remote, { op: "close", dropRest: true }, 20, { sealed: true }).plan;
  assert.equal(shape(delivered).replace(/"Done for now"/u, "null"), shape(closed));
  const opened = openRoundPlan(delivered, "Follow up", parsePlan("Tweak it\n  Test the tweak"));
  const round = c.applyPlanCommand(closed, { op: "round", steps: idEntries(opened.tree) }, 21, { sealed: true }).plan;
  assert.equal(shape(opened.plan).replace(/"Done for now"/gu, "null"), shape(round).replace(/"Done for now"/gu, "null"));
  assert.equal(c.openRound(round).n, 2);
});

test("the echo indents a tree, marks the path to the current step, and folds closed rounds to one line", () => {
  const { plan } = startPlan(parsePlan("Read the spec\nBuild it\n  Parse the rows\n  Write the rows\nVerify it"));
  const work = { id: "wrk_00000001", goal: "Ship the importer", lifecycle: "open", plan: applyChange(plan, { nextStep: true }).plan };
  assert.equal(renderEcho({ work, disposition: "updated", now: new Date(0) }), [
    'Work wrk_00000001 "Ship the importer" (open, updated)',
    "  [x] s1 Read the spec",
    "  [>] s2 Build it",
    "    [>] s3 Parse the rows",
    "    [ ] s4 Write the rows",
    "  [ ] s5 Verify it",
    'Owner sees: on the Lock Screen, "Step 2 of 3 · Build it · 0/2"',
    'Next: relo work update --next-step',
  ].join("\n"));

  const delivered = deliverPlan(work.plan, "Importer reads every row", { dropRest: true }).plan;
  const one = { ...work, plan: delivered };
  assert.equal(renderEcho({ work: one, disposition: "delivered" }), [
    'Work wrk_00000001 "Ship the importer" (open, delivered)',
    '  [✓] Round 1 "Ship the importer": Importer reads every row',
    `Owner sees: the round's final card and one quiet notification: "Importer reads every row"; then it's the owner's turn`,
    'Next: the round is delivered. A follow-up on this goal: relo work start --round "<the request in a few words>" --plan "…"  |  goal done: relo work finish --outcome "…"',
  ].join("\n"));

  const two = { ...work, plan: openRoundPlan(delivered, "Handle the quotes", parsePlan("Find the cases\nFix them")).plan };
  assert.equal(renderEcho({ work: two, disposition: "round_opened" }), [
    'Work wrk_00000001 "Ship the importer" (open, round_opened)',
    '  [✓] Round 1 "Ship the importer": Importer reads every row',
    '  Round 2 "Handle the quotes"',
    "    [>] s6 Find the cases",
    "    [ ] s7 Fix them",
    'Owner sees: on the Lock Screen, "Step 1 of 2 · Find the cases"',
    'Next: relo work update --next-step',
  ].join("\n"));
  // an unknown round title (a sealed work with no local copy) reads "Round 2"
  const unnamed = { ...two, goal: undefined, plan: { ...two.plan, rounds: two.plan.rounds.map((r) => ({ ...r, title: undefined })) } };
  assert.match(renderEcho({ work: unnamed }), /^ {2}\[✓\] Round 1: Importer reads every row\n {2}Round 2\n/mu);
  // a refused finish rides first
  const refused = renderEcho({ work: two, pendingRefusal: { verb: "finish", what: "--outcome is 230 characters; the limit is 200", at: new Date(2026, 9, 16, 14, 2).toISOString(), next: 'relo work finish --outcome "Importer reads every…"' }, now: new Date(2026, 9, 16, 15, 0) });
  assert.equal(refused.split("\n")[0], 'Refused earlier: --outcome is 230 characters; the limit is 200 (relo work finish, 14:02). The card is still open. Next: relo work finish --outcome "Importer reads every…"');
});

test("the Lock Screen line is the one plan line (U2): the top-level step, its substep count, never cut to fit chrome", () => {
  const { plan } = startPlan(parsePlan("Migrate the whole billing database to the new region\n  Copy the invoices table\nVerify"));
  assert.equal(cardLine({ plan }), "Step 1 of 2 · Migrate the whole billing database to the new region · 0/1");
  assert.equal(cardLine({ plan, lifecycle: "paused" }), "Paused at 0 of 2");
  assert.equal(cardLine({ plan: finishPlan(plan, "failed", "x").plan, result: "failed", lifecycle: "finished" }), "Stopped at 0 of 2");
  const unreadable = { steps: plan.steps.map(({ label, ...s }) => s), next: plan.next, version: 1 };
  assert.equal(cardLine({ plan: unreadable }), "Step 1 of 2 · Not readable · 0/1");
});

test("sealed card text v2: phases per round with outcome and step details by id; fitCardText trims earlier rounds first", () => {
  const { plan } = startPlan(parsePlan("Rotate\nVerify\n  Check staging"));
  const one = { goal: "Rotate the keys", status: "Checking staging", plan: applyChange(plan, { detail: "Staging first" }).plan };
  assert.deepEqual(workCardText(one), {
    title: "Rotate the keys", status: "Checking staging", stepId: "s1",
    phases: [{ id: "r1", steps: [{ id: "s1", label: "Rotate", detail: "Staging first" }, { id: "s2", label: "Verify" }, { id: "s3", label: "Check staging" }] }],
  });
  const delivered = deliverPlan(one.plan, "Staging key rotated", { dropRest: true }).plan;
  const two = openRoundPlan(delivered, "Rotate production", parsePlan("Rotate prod\nVerify prod"));
  const card = workCardText({ ...one, plan: two.plan }, { status: "Rotating production" });
  assert.deepEqual(card.phases.map((p) => [p.id, p.title, p.outcome, p.steps.map((s) => s.id)]), [["r1", undefined, "Staging key rotated", ["s1", "s2", "s3"]], ["r2", "Rotate production", undefined, ["s4", "s5"]]]);
  assert.equal(card.steps, undefined, "v2 only: the labels travel in phases");

  // trimming order: earlier rounds' details, then their labels, then the oldest rounds whole, then the current one
  const step = (id, extra = {}) => ({ id, label: `Step label ${id} with words`, detail: `Detail for ${id} with plenty of words in it`, ...extra });
  const big = {
    title: "T", status: "S",
    phases: [
      { id: "r1", title: "First", outcome: "Outcome one", steps: [step("s1"), step("s2"), step("s3")] },
      { id: "r2", title: "Second", outcome: "Outcome two", steps: [step("s4"), step("s5"), step("s6")] },
      { id: "r3", title: "Third", steps: [step("s7"), step("s8")] },
    ],
  };
  const size = (text) => Buffer.byteLength(JSON.stringify(text));
  const full = size(big);
  assert.deepEqual(fitCardText(big, full + 10), big, "fits: untouched");
  const noDetails = fitCardText(big, full - 10);
  assert.deepEqual(noDetails.phases.map((p) => p.steps?.map((s) => s.detail)), [[undefined, undefined, undefined], [undefined, undefined, undefined], ["Detail for s7 with plenty of words in it", "Detail for s8 with plenty of words in it"]], "closed rounds lose their details first");
  const noLabels = fitCardText(big, size({ ...big, phases: [{ id: "r1", title: "First", outcome: "Outcome one" }, { id: "r2", title: "Second", outcome: "Outcome two" }, big.phases[2]] }) + 2);
  assert.deepEqual(noLabels.phases.slice(0, 2).map((p) => [p.title, p.outcome, p.steps]), [["First", "Outcome one", undefined], ["Second", "Outcome two", undefined]], "then their step labels");
  assert.equal(noLabels.phases[2].steps.length, 2);
  const onlyCurrent = fitCardText(big, size({ title: "T", status: "S", phases: [big.phases[2]] }) + 2);
  assert.deepEqual(onlyCurrent.phases.map((p) => p.id), ["r3"], "then the oldest rounds go whole; the current round stays");
  assert.equal(onlyCurrent.phases[0].steps[0].detail, "Detail for s7 with plenty of words in it");
  assert.ok(size(fitCardText(big, 300)) <= 300);
});

test("a sealed start names predicted ids in pre-order; a sealed update names the ids it listed or added", () => {
  const first = startPlan(parsePlan("Rotate\nVerify\n  Check staging\n  Check production"));
  const body = { goal: { readable: "G" }, plan: { op: "set", steps: [] } };
  assert.deepEqual(sealedStart(body, first.tree).plan, { op: "set", steps: [{ id: "s1" }, { id: "s2", children: [{ id: "s3" }, { id: "s4" }] }] });
  const added = applyChange(first.plan, { add: parsePlan("Ship\n  Tag it"), under: "s2" });
  const sealedAdd = sealedUpdate({ plan: { op: "add", steps: [], under: "s2" } }, { trees: added.trees });
  assert.deepEqual(sealedAdd.plan, { op: "add", steps: [{ id: "s5", children: [{ id: "s6" }] }], under: "s2" });
  const detail = sealedUpdate({ plan: { op: "detail", detail: "x" } }, { trees: {} });
  assert.equal(detail.plan, undefined, "a sealed detail never travels readable");
  const round = sealedStart({ goal: { readable: "G" }, round: { readable: "Title" }, plan: { op: "set", steps: [] } }, openRoundPlan(deliverPlan(first.plan, "Done", { dropRest: true }).plan, "Title", [{ label: "Next" }]).tree);
  assert.deepEqual([round.round, round.goal, round.plan.steps], [{ sealed: true }, { sealed: true }, [{ id: "s5" }]]);
});

test("the sealed card text names the current step id next to the status; none once delivered", () => {
  const { plan } = startPlan(parsePlan("Rotate\nVerify\n  Check staging\n  Check production"));
  assert.equal(workCardText({ goal: "G", status: "Starting", plan }).stepId, "s1");
  const second = applyChange(plan, { nextStep: true }).plan;
  assert.equal(workCardText({ goal: "G", status: "Checking", plan: second }).stepId, "s3", "the current leaf, not its parent");
  assert.deepEqual(Object.keys(workCardText({ goal: "G", status: "S", plan: second })).slice(0, 3), ["title", "status", "stepId"]);
  assert.equal("stepId" in workCardText({ goal: "G", plan: deliverPlan(second, "Done", { dropRest: true }).plan }), false);
  assert.equal("stepId" in workCardText({ goal: "G" }), false);
});

test("a sealed work's echo keeps what the server cannot read: the waiting reason, and the labels of skipped steps by id", async () => {
  const { withLocalLabels } = await import("../src/agent/work.mjs");
  const local = applyChange(startPlan(parsePlan("Audit\nBuild\n  Compile\n  Link\nShip")).plan, { plan: parsePlan("Audit\nShip") });
  const served = { id: "wrk_00000001", lifecycle: "open", waiting: { reason: null, since: "2026-10-16T10:00:00.000Z" },
    plan: { version: 3, next: 6, steps: local.plan.steps.map(({ label, ...step }) => step) } };
  const work = withLocalLabels(served, { id: "wrk_00000001", goal: "G", waiting: "CI run", plan: local.plan });
  assert.equal(work.waiting.reason, "CI run");
  const echo = renderEcho({ work: { ...work, goal: "G" } });
  assert.match(echo, /Waiting on: CI run since/u);
  assert.match(echo, /\[-\] 3 skipped: s2 Build, s3 Compile, s4 Link/u, "the skipped parent keeps its label");
  assert.doesNotMatch(echo, /something/u);
});

test("a long sealed plan keeps every label whole in the fetched content; only the push alert is trimmed", () => {
  const steps = Array.from({ length: 30 }, (_, index) => ({ id: `s${index + 1}`, label: `Check readiness of part ${index + 1} of the CLI` }));
  const text = { title: "Test relo itself end to end", status: "Updating", phases: [{ id: "r1", steps }] };
  assert.deepEqual(fitCardText(text, MAX_CARD_CONTENT_BYTES).phases[0].steps.map((step) => step.label), steps.map((step) => step.label));
  assert.ok(fitCardText(text).phases[0].steps.every((step) => step.label.endsWith("…")), "the alert still fits its push budget");
});

test("the sealed card text keeps skipped steps' labels, so the phone names them behind its skipped row", () => {
  const work = { goal: "Ship", plan: { steps: [{ id: "s1", label: "Build", state: "done" }, { id: "s2", label: "Fix the check", state: "skipped" }, { id: "s3", label: "Ship", state: "current" }] } };
  assert.deepEqual(workCardText(work).phases[0].steps.map((step) => step.label), ["Build", "Fix the check", "Ship"]);
});

test("--plan matches an entry only among steps at its own place in the tree", () => {
  const { plan } = startPlan(parsePlan("Build\n  Verify\nShip"));
  const out = applyChange(plan, { plan: parsePlan("Build\n  Verify\nShip\nVerify") }).plan;
  const open = out.steps.filter((s) => s.state !== "skipped");
  const verifyTop = open.find((s) => s.label === "Verify" && s.parent === undefined);
  assert.ok(verifyTop, "a new top-level Verify is not the sub-step");
  assert.equal(verifyTop.id, "s4");
  assert.equal(open.find((s) => s.id === "s2").parent, "s1", "the sub-step stays under Build");
  const flat = applyChange(plan, { plan: parsePlan("Build\nShip") }).plan;
  assert.equal(flat.steps.find((s) => s.id === "s2").state !== "skipped", true, "a listed step without children keeps its children");
});

test("17 October replay: plan B1..B4, finish B1, deliver is refused and names s2 to s4; --drop-rest names the skips", () => {
  const { plan } = startPlan(["B1", "B2", "B3", "B4"]);
  const afterB1 = applyChange(plan, { nextStep: true }).plan;
  let refused;
  try { deliverPlan(afterB1, "Batch 1 done"); } catch (error) { refused = error; }
  assert.equal(refused?.code, "REFUSED_OPEN_STEPS");
  assert.equal(refused.exitCode, 2);
  assert.match(refused.what, /open steps: s3 B3, s4 B4/u);
  assert.match(refused.next, /relo ask "…" --approval/u);
  assert.match(refused.next, /relo work update --waiting "…"/u);
  assert.match(refused.next, /relo work update --plan "<what's left>" then deliver/u);
  assert.match(refused.next, /--drop-rest/u);
  const dropped = deliverPlan(afterB1, "Batch 1 done", { dropRest: true });
  assert.deepEqual(dropped.moved.skipped, ["s3", "s4"]);
  assert.match(dropped.notes[0], /skipped 2 open steps \(--drop-rest\): s3 B3, s4 B4/u);
  assert.equal(dropped.plan.rounds[0].state, "closed");
  // The last step only: nothing is left behind, so no flag is needed.
  const last = applyChange(applyChange(afterB1, { nextStep: true }).plan, { nextStep: true }).plan;
  assert.equal(deliverPlan(last, "All four").notes.length, 0);
});

test("a round without --plan carries the unfinished steps; with --plan it says how many were not carried", () => {
  const { plan } = startPlan(["B1", "B2", "B3", "B4"]);
  const delivered = deliverPlan(applyChange(plan, { nextStep: true }).plan, "Batch 1", { dropRest: true }).plan;
  const carried = openRoundPlan(delivered, "Go on");
  assert.deepEqual(carried.plan.steps.filter((s) => s.round === 2).map((s) => [s.id, s.label, s.state, s.carriedFrom]), [["s5", "B3", "current", 1], ["s6", "B4", "open", 1]]);
  assert.equal(carried.carried, 2);
  assert.deepEqual(carried.tree.map((n) => [n.id, n.label]), [["s5", "B3"], ["s6", "B4"]], "the sealed form names the carried ids");
  assert.deepEqual(carried.plan.steps.slice(0, 4).map((s) => s.state), ["done", "done", "skipped", "skipped"], "the closed round stays as it was");
  const own = openRoundPlan(delivered, "Other", [{ label: "Something else" }]);
  assert.equal(own.notCarried, 2);
  assert.equal(own.carried, 0);
  assert.deepEqual(own.plan.steps.filter((s) => s.round === 2).map((s) => s.label), ["Something else"]);
});

test("--add --after puts siblings after a step and its subtree; --under and --after together are refused", () => {
  const { plan } = startPlan(parsePlan("Build\n  Parse\nVerify"));
  const added = applyChange(plan, { add: ["Quote", "Escape"], after: "s1" });
  assert.deepEqual(added.plan.steps.map((s) => [s.id, s.parent]), [["s1", undefined], ["s2", "s1"], ["s4", undefined], ["s5", undefined], ["s3", undefined]]);
  assert.equal(added.moved.after, "s1");
  assert.deepEqual(planCommands({ add: ["Quote", "Escape"], after: "s1" }, undefined, { trees: added.trees, after: added.moved.after })[0].after, "s1");
  const nested = applyChange(plan, { add: ["Quote"], after: "Parse" });
  assert.deepEqual(nested.plan.steps.map((s) => [s.id, s.parent]), [["s1", undefined], ["s2", "s1"], ["s4", "s1"], ["s3", undefined]]);
  assert.throws(() => applyChange(plan, { add: ["x"], after: "s1", under: "s1" }), { code: "REFUSED_CONTRADICTION" });
  assert.throws(() => applyChange(plan, { add: ["x"], after: "s9" }), { code: "REFUSED_UNKNOWN_STEP" });
});

test("--step on the current step says it is current and points at --next-step", () => {
  const { plan } = startPlan(["A", "B"]);
  const same = applyChange(plan, { step: "s1" });
  assert.deepEqual(same.notes, ["s1 is already current. Done with it: `--next-step`."]);
});

test("--next-step goes to the next open step after the current one, not back to the first open one", () => {
  const { plan } = startPlan(["A", "B", "C", "D"]);
  const back = applyChange(applyChange(plan, { step: "s3" }).plan, { step: "s1" }).plan;
  assert.deepEqual(back.steps.map((s) => s.state), ["current", "done", "open", "open"]);
  assert.equal(applyChange(back, { nextStep: true }).plan.steps.find((s) => s.state === "current").id, "s3");
  const before = applyChange(applyChange(plan, { step: "s3" }).plan, { add: ["X"], after: "s1" }).plan;
  const ahead = applyChange(before, { nextStep: true }).plan;
  assert.equal(ahead.steps.find((s) => s.state === "current").id, "s4", "the open step behind waits until none follows");
  assert.equal(applyChange(ahead, { nextStep: true }).plan.steps.find((s) => s.state === "current").id, "s5");
});

test("--add --under a done step reopens it and says so; --progress says what it fills", () => {
  const { plan } = startPlan(["A", "B"]);
  const moved = applyChange(plan, { nextStep: true }).plan;
  const reopened = applyChange(moved, { add: ["A2"], under: "s1" });
  assert.ok(reopened.notes.includes("s1 reopened: 1 new substep (it counted as done)"), reopened.notes.join("|"));
  assert.equal(reopened.plan.steps[0].state, "open");
  const progress = applyChange(startPlan(["Batch 1", "Batch 2"]).plan, { progress: { done: 3, total: 4 } });
  assert.ok(progress.notes.includes("3/4 fills s1 (Batch 1); it clears when s1 ends."), progress.notes.join("|"));
});
