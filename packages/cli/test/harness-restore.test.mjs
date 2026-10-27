import "./hermetic-env.mjs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import claudeCode from "../src/harness/adapters/claude-code/index.mjs";
import { restore, restoreText } from "../src/harness/core/restore.mjs";

const NOW = Date.parse("2026-10-14T10:45:00");
const at = (h, m) => new Date(2026, 9, 14, h, m).toISOString();
const state = (extra = {}) => ({ v: 1, writtenAt: at(10, 42), parked: [],
  open: { id: "wrk_8f2", goal: "Ship the 0.17 release", lifecycle: "open", plan: { steps: [
    { id: "s1", label: "Bump versions", state: "done" },
    { id: "s2", label: "Run local gates", state: "current", progress: { done: 3, total: 5 } },
    { id: "s3", label: "Tag and publish", state: "pending" }] } }, ...extra });

test("compact with an open work injects the echo", () => {
  const out = restore({ event: { source: "compact" }, now: NOW, state: state({ parked: [{ id: "wrk_7a1", goal: "Fix login crash", lifecycle: "paused" }] }) });
  assert.deepEqual(claudeCode.render({ role: "restore", context: out.context }), { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: out.context } },
    "the Claude Code adapter renders the neutral outcome as today's JSON");
  assert.equal(out.context, [
    `Relo: this session has open work (as of 10:42; Relo keeps it on the owner's screen).`,
    `Work wrk_8f2 "Ship the 0.17 release" (open)`,
    `  [x] s1 Bump versions`,
    `  [>] s2 Run local gates   (3/5)`,
    `  [ ] s3 Tag and publish`,
    `Parked: wrk_7a1 "Fix login crash" (paused)`,
    `Next: relo work update --next-step  |  relo work finish --outcome "…"  (deliver instead when this request is done and more of the goal is to come)`].join("\n"));
  assert.ok(restore({ event: { source: "resume" }, now: NOW, state: state() }));
});

test("clear and fork inject nothing; startup only when a file exists; subagent nothing", () => {
  for (const source of ["clear", "fork", undefined]) assert.equal(restore({ event: { source }, now: NOW, state: state() }), undefined);
  assert.equal(restore({ event: { source: "startup" }, now: NOW, state: undefined }), undefined);
  assert.ok(restore({ event: { source: "startup" }, now: NOW, state: state() }));
  assert.equal(restore({ event: { source: "compact", subagent: true }, now: NOW, state: state() }), undefined);
});

test("nothing open or parked → no output", () => {
  assert.equal(restore({ event: { source: "compact" }, now: NOW, state: state({ open: null }) }), undefined);
  assert.equal(restore({ event: { source: "compact" }, now: NOW, state: state({ open: { id: "w", lifecycle: "finished" } }) }), undefined);
});

test("stale file → the possibly-out-of-date line", () => {
  const text = restoreText(state({ writtenAt: at(9, 12) }), NOW);
  assert.match(text.split("\n")[0], /\(as of 09:12, possibly out of date: relo state --sync;/u);
});

test("long plan truncated under 1,500 characters around the current step", () => {
  const steps = Array.from({ length: 60 }, (_, i) => ({ id: `s${i + 1}`, label: `A fairly long step label number ${i + 1}`, state: i < 30 ? "done" : i === 30 ? "current" : "pending" }));
  const text = restoreText(state({ open: { id: "w", goal: "G", lifecycle: "open", plan: { steps } } }), NOW);
  assert.ok(text.length <= 1500);
  assert.match(text, /… 27 more done/u);
  assert.match(text, /… 26 more ahead/u);
});

test("a pending question is shown", () => {
  const text = restoreText(state({ question: { prompt: "Deploy to production?", askedAt: at(10, 31) } }), NOW);
  assert.match(text, /Question pending: "Deploy to production\?" asked 10:31, no answer yet\./u);
});

test("rounds: one line per closed round and the delivered state; the Next line survives the size budget", () => {
  const rounds = Array.from({ length: 6 }, (_, i) => ({ n: i + 1, state: "closed", ...(i ? { title: `Request number ${i + 1}` } : {}), outcome: `Outcome of round ${i + 1} with some words in it` }));
  const steps = [{ id: "s1", label: "Old", state: "done", round: 1 }];
  const delivered = restoreText(state({ open: { id: "wrk_8f2", goal: "Ship the 0.17 release", lifecycle: "open", plan: { steps, rounds } } }), NOW);
  assert.match(delivered, /^Work wrk_8f2 "Ship the 0.17 release" \(open, round 6 delivered\)$/mu);
  assert.match(delivered, /^ {2}… 1 earlier rounds$/mu);
  assert.match(delivered, /^ {2}Round 2 "Request number 2": Outcome of round 2 with some words in it$/mu);
  assert.doesNotMatch(delivered, /\[x\] s1/u, "a delivered work has no steps to show");
  assert.match(delivered, /Next: a follow-up on this goal: relo work start --round .*goal done: relo work finish/u);
  const first = restoreText(state({ open: { id: "w", goal: "Ship it", lifecycle: "open", plan: { steps, rounds: [{ n: 1, state: "closed", outcome: "Shipped the first part" }, { n: 2, state: "open", title: "More" }] } } }), NOW);
  assert.match(first, /^ {2}Round 1 "Ship it": Shipped the first part$/mu, "round 1 is titled by the goal");
  const long = Array.from({ length: 5 }, (_, i) => ({ n: i + 1, state: "closed", title: "T".repeat(80), outcome: "O".repeat(300) }));
  const crowded = restoreText(state({ open: { id: "w", goal: "G", lifecycle: "open", plan: { steps: Array.from({ length: 12 }, (_, i) => ({ id: `s${i + 1}`, label: "L".repeat(70), state: i === 3 ? "current" : "open", round: 6 })), rounds: [...long, { n: 6, state: "open" }] } } }), NOW);
  assert.ok(crowded.length <= 1500);
  assert.match(crowded, /Next: .*relo work finish/u, "round lines give way before the Next line");
});

test("a paused work suggests resume, never --next-step", () => {
  const text = restoreText(state({ open: { id: "w", goal: "G", lifecycle: "paused", plan: { steps: [{ id: "s1", label: "A", state: "open" }, { id: "s2", label: "B", state: "open" }] } } }), NOW);
  assert.match(text, /Next: relo work resume/u);
  assert.doesNotMatch(text, /--next-step/u);
});
