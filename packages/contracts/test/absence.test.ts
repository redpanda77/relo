import assert from "node:assert/strict";
import test from "node:test";
import { ABSENCE_REASONS,absenceText } from "../src/owner-state.js";

const since = "2026-10-17T18:40:00.000Z";
const options = { locale: "en-GB",timeZone: "UTC" };
const expected: Record<(typeof ABSENCE_REASONS)[number],string> = {
  session_ended: "Session ended",
  computer_offline: "Computer offline since 18:40",
  session_idle: "Session idle",
  no_update: "No update since 18:40",
  stopped_responding: "Stopped responding",
  left_unfinished: "Left unfinished",
  failed: "Failed",
};

test("absenceText words every reason",() => {
  for (const reason of ABSENCE_REASONS) assert.equal(absenceText({ reason,since },options),expected[reason],reason);
});

test("absenceText names the computer",() => {
  assert.equal(absenceText({ reason: "computer_offline",since },{ ...options,computer: "Mac" }),"Mac offline since 18:40");
});
