// The output contract (shared/output.mjs printOutcome / printFailure) for every kind of outcome in each
// mode: --json, piped (agents and scripts) and a person at a terminal.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { UsageError } from "../src/shared/errors.mjs";
import { outputMode, printFailure, printOutcome } from "../src/shared/output.mjs";
import { result } from "../src/shared/outcome.mjs";
import { WorkRefusal } from "../src/work/refusal.mjs";

const MODES = { json: outputMode(["x", "--json"], true), piped: outputMode(["x"], false), tty: outputMode(["x"], true) };

function capture(print) {
  const out = { stdout: [], stderr: [] };
  const exitCode = print({ stdout: (line) => out.stdout.push(line), stderr: (line) => out.stderr.push(line) });
  return { ...out, exitCode };
}
const isJsonLine = (lines) => lines.length === 1 && typeof JSON.parse(lines[0]) === "object";

test("--json prints exactly one JSON line for every outcome", () => {
  const outcomes = [result("help", { help: "Guide" }), result("version", { version: "1.0.0" }),
    { ...result("work.update", { ok: true }), echo: "Work: …" }, { ...result("keys.status", {}), text: "Table" },
    result("notify", { id: "ntf_1" }, { message: "Queued" })];
  for (const output of outcomes) {
    const printed = capture((io) => printOutcome(output, MODES.json, io));
    assert.ok(isJsonLine(printed.stdout), `${output.command}: ${printed.stdout}`);
    assert.deepEqual(printed.stderr, []);
  }
  for (const cause of [new UsageError("Bad flag"), new WorkRefusal("REFUSED_FLAG", { what: "x", state: "y", next: "z" })]) {
    const printed = capture((io) => printFailure(cause, MODES.json, io, "work"));
    assert.ok(isJsonLine(printed.stdout));
    assert.equal(JSON.parse(printed.stdout[0]).ok, false);
  }
});

test("piped: echo and refusals stay text for the agent; everything else is one JSON line with its notices", () => {
  const echo = capture((io) => printOutcome({ ...result("work.update", {}), echo: "Work: Fix login" }, MODES.piped, io));
  assert.deepEqual(echo.stdout, ["Work: Fix login"]);
  const refusal = capture((io) => printFailure(new WorkRefusal("REFUSED_FLAG", { what: "--topic is retired", state: "open work", next: "relo work update" }), MODES.piped, io, "work"));
  assert.equal(refusal.stdout.length, 1);
  assert.match(refusal.stdout[0], /^Refused:/u);
  const notice = capture((io) => printOutcome(result("notify", { id: "ntf_1" }, { message: "Queued" }), MODES.piped, io));
  assert.ok(isJsonLine(notice.stdout));
  assert.deepEqual(notice.stderr, [], "piped notices ride in the line; nobody reads stderr");
  const error = capture((io) => printFailure(new UsageError("Bad flag"), MODES.piped, io, "notify"));
  assert.ok(isJsonLine(error.stdout));
  assert.equal(error.exitCode, 2);
});

test("a terminal gets readable views, notices on stderr and errors as text on stderr", () => {
  const view = capture((io) => printOutcome({ ...result("keys.status", {}), text: "Table", message: "1 phone" }, MODES.tty, io));
  assert.deepEqual([view.stdout, view.stderr], [["Table"], ["1 phone"]]);
  const notice = capture((io) => printOutcome(result("notify", { id: "ntf_1" }, { message: "Queued" }), MODES.tty, io));
  assert.ok(isJsonLine(notice.stdout));
  assert.deepEqual(notice.stderr, ["Queued"]);
  const error = capture((io) => printFailure(new UsageError("Bad flag", { hint: "relo help" }), MODES.tty, io, "notify"));
  assert.deepEqual([error.stdout, error.stderr], [[], ["Bad flag\nhint: relo help"]]);
});

test("flags after -- are the caller's text, not output flags", () => {
  assert.deepEqual(outputMode(["notify", "--", "--json"], true), { json: false, full: false, structured: false });
});
