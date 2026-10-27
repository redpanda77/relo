import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { ownerSees, renderEcho } from "../src/work/echo.mjs";

// A local account (or one with no phone) has one screen: the notch (Relo for Mac's, or Relo for Windows'). The owner line never names the Lock Screen or Now.
const open = { id: "wrk_12345678", goal: "Ship it", lifecycle: "open", status: "Building" };
const NEVER = /Lock Screen|Now ›|\(Now\)|Dynamic Island|iPhone/u;

test("the owner line names the notch for a local account, in every state", () => {
  const states = [
    open,
    { ...open, waiting: "the deploy" },
    { ...open, owner: { state: "needs_you" } },
    { ...open, owner: { state: "stale", since: "2026-10-23T10:00:00Z" } },
    { ...open, owner: { state: "no_signal" } },
    { ...open, lifecycle: "paused", status: "Out to lunch" },
    { ...open, lifecycle: "finished", result: "dropped", outcome: "not needed" },
  ];
  for (const work of states) assert.doesNotMatch(ownerSees(work, new Date(), undefined, true), NEVER, JSON.stringify(work));
  assert.equal(ownerSees(open, new Date(), undefined, true), `Owner sees: in ${process.platform === "darwin" ? "your Mac's notch" : "the Relo notch"}, "Building"`);
  assert.equal(ownerSees({ ...open, owner: { state: "needs_you" } }, new Date(), undefined, true), "Owner sees: the notch opens with your question");
  assert.match(ownerSees({ ...open, lifecycle: "paused" }, new Date(), undefined, true), process.platform === "darwin" ? /^Owner sees: nothing in your Mac's notch/u : /^Owner sees: nothing in the Relo notch/u);
});

test("without the notch flag the Lock Screen words are unchanged", () => {
  assert.equal(ownerSees(open), 'Owner sees: on the Lock Screen, "Building"');
  assert.equal(ownerSees({ ...open, owner: { state: "needs_you" } }), "Owner sees: your question on top of the Lock Screen, as a time-sensitive alert");
  assert.match(ownerSees({ ...open, lifecycle: "paused" }), /Now › Paused/u);
});

test("renderEcho passes the notch flag to the owner line", () => {
  assert.match(renderEcho({ work: open, notch: true }), process.platform === "darwin" ? /Owner sees: in your Mac's notch/u : /Owner sees: in the Relo notch/u);
  assert.match(renderEcho({ work: open }), /Owner sees: on the Lock Screen/u);
});
