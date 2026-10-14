// ADR 0008 principles 1, 5 and 9 as sweeps over derive(): absence of evidence never reads as running,
// every item eventually leaves the Lock Screen, and declared lifecycle alone decides finished outcomes.
import { readFileSync } from "node:fs";
import { describe,expect,test } from "vitest";
import { WORK_LIFECYCLES,type OwnerStateInput } from "@relo/notification-contracts";
import { deriveOwnerState } from "./owner-state.js";

const fixture = JSON.parse(readFileSync(new URL("../../../../packages/contracts/fixtures/owner-state-v1.json",import.meta.url),"utf8"));
const base = fixture.derive[0].input as OwnerStateInput;
const at = (minutes: number) => new Date(Date.parse(base.work.lastDeclaredAt) + minutes * 60_000).toISOString();
const evidences: OwnerStateInput["evidence"][] = [
  { producer: "agent_session",session: null },
  { producer: "script",leaseUntil: null },
  { producer: "service",leaseUntil: null },
];

describe("ADR 0008 principle invariants over derive()",() => {
  test("principle 9: an open work with no new write leaves Running and the Lock Screen within a day, for every producer type",() => {
    for (const evidence of evidences) {
      const late = deriveOwnerState({ ...base,evidence,now: at(24 * 60) });
      expect(late.now).not.toBe("running");
      expect(["none","dimmed"]).toContain(late.lockScreen);
      expect(late.state).not.toBe("moving");
    }
  });

  test("principle 9: every lifecycle without a question is off the Lock Screen within a day",() => {
    for (const lifecycle of WORK_LIFECYCLES) {
      const finishedAt = lifecycle === "open" || lifecycle === "paused" ? null : base.work.lastDeclaredAt;
      const result = deriveOwnerState({ ...base,work: { ...base.work,lifecycle,finishedAt },now: at(24 * 60) });
      expect(result.lockScreen,lifecycle).toBe("none");
    }
  });

  test("principle 1: a declared outcome maps to its own state; derive never invents success",() => {
    const outcome = (lifecycle: "finished" | "failed" | "dropped") =>
      deriveOwnerState({ ...base,work: { ...base.work,lifecycle,finishedAt: base.work.lastDeclaredAt },now: at(1) }).state;
    expect(outcome("finished")).toBe("done");
    expect(outcome("failed")).toBe("failed");
    expect(outcome("dropped")).toBe("dropped");
  });

  test("principle 5: staleness only moves forward: the state at a later time is never fresher (moving) after it left moving",() => {
    for (const evidence of evidences) {
      let leftMoving = false;
      for (let minutes = 0; minutes <= 48 * 60; minutes += 5) {
        const state = deriveOwnerState({ ...base,evidence,now: at(minutes) }).state;
        if (leftMoving) expect(state,`${evidence.producer} at ${minutes}m`).not.toBe("moving");
        if (state !== "moving") leftMoving = true;
      }
    }
  });
});
