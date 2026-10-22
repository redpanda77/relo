// ADR 0015: the spoken frame "<Kind>: <name>. <gist>", held to the golden file Relo for Mac's tests read too.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkText } from "../src/work/content-filter.mjs";
import { checkSpoken, outcomeGist, questionGist, saidGist, SPOKEN_KINDS, spokenLine } from "../src/work/spoken.mjs";

const checked = (field, text, flag) => checkSpoken(field, checkText(field, text, { flag }), flag);

const { cases } = JSON.parse(readFileSync(new URL("./fixtures/spoken-lines.json", import.meta.url), "utf8"));

const gistOf = (c) => (c.kind === "question" ? questionGist(c.prompt)
  : c.say ? saidGist(c.say) : c.outcome ? outcomeGist(c.outcome, { urgent: c.kind === "failed" }) : c.step ? outcomeGist(c.step) : null);

for (const c of cases) {
  test(`golden: ${c.label}`, () => {
    const gist = gistOf(c);
    assert.equal(gist, c.gist);
    assert.equal(spokenLine(c.kind, { goal: c.goal, name: c.name, gist }), c.line);
  });
}

test("every golden line starts with a kind word, fits one breath and carries no inventory", () => {
  const kinds = Object.values(SPOKEN_KINDS);
  for (const { line } of cases) {
    assert.ok(kinds.some((kind) => line.startsWith(`${kind}:`) || line === `${kind}.`), line);
    assert.ok(line.split(" ").length <= 28 && Array.from(line).length <= 180, line);
    assert.doesNotMatch(line, /\d+\.\d+|\b[0-9a-f]{7,}\b|\/|\(/u, line);
    assert.match(line, /[.?]$/u, line);
  }
});

test("long and noisy outcomes still give a short line", () => {
  const noisy = [
    "Shipped: server 0.18.101, CLI 0.17.50, iPhone 0.10.40 (95), Relo for Mac 0.2.9; see https://relo.example.com/now and apps/notch/README.md",
    "a".repeat(5) + " " + "word ".repeat(80),
    "Fixed it (finally) — 3 suites, 12 files, commit 4f2a9c1e, wrk_123abc, ses_9",
  ];
  for (const outcome of noisy) {
    const line = spokenLine("finished", { goal: "A goal that goes on for a long while about many things at once", gist: outcomeGist(outcome) });
    assert.ok(line.split(" ").length <= 28 && Array.from(line).length <= 180, line);
    assert.doesNotMatch(line, /\d+\.\d+|https?|\/|wrk_|ses_|4f2a9c1e/u, line);
  }
});

test("--say and --spoken-name are refused when they carry what a voice never reads, or run long", () => {
  assert.equal(checked("spoken", "The iPhone app is on TestFlight.", "--say"), "The iPhone app is on TestFlight.");
  assert.throws(() => checked("spoken", "Version 0.17 is on TestFlight.", "--say"), /--say contains a version number/u);
  assert.throws(() => checked("spoken", "Deployed fea6d51 to production.", "--say"), /a commit hash/u);
  assert.throws(() => checked("spoken", "See relo.example.com for it.", "--say"), /a link/u);
  assert.throws(() => checked("spoken", "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty more", "--say"), /21 words; it is said aloud, so at most 20/u);
  assert.throws(() => checked("spoken", "x".repeat(161), "--say"), /the limit is 160/u);
  assert.equal(checked("name", "Notch redesign", "--spoken-name"), "Notch redesign");
  assert.throws(() => checked("name", "The redesign of the open notch", "--spoken-name"), /6 words; it is said aloud, so at most 4/u);
  assert.throws(() => checked("name", "Release 0.7.57", "--spoken-name"), /a version number/u);
});
