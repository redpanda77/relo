// Workstream 6: every quiet, stopped or failed item carries one derived reason.
import { readFileSync } from "node:fs";
import { describe,expect,test } from "vitest";
import type { OwnerStateInput } from "@relo/notification-contracts";
import { deriveOwnerState } from "./owner-state.js";

const fixture = JSON.parse(readFileSync(new URL("../../../../packages/contracts/fixtures/owner-state-v1.json",import.meta.url),"utf8"));
const base = fixture.derive[0].input as OwnerStateInput;
const at = (minutes: number) => new Date(Date.parse(base.work.lastDeclaredAt) + minutes * 60_000).toISOString();
const open = (evidence: OwnerStateInput["evidence"],minutes: number): OwnerStateInput =>
  ({ ...base,work: { ...base.work,lifecycle: "open",finishedAt: null,waitingSince: null },question: null,evidence,now: at(minutes) });

describe("absence reason",() => {
  test("a quiet work without hooks says no update since its last write",() => {
    const result = deriveOwnerState(open({ producer: "agent_session",session: null },30));
    expect(result.state).toBe("stale");
    expect(result.absence).toEqual({ reason: "no_update",since: base.work.lastDeclaredAt });
  });

  test("a quiet work whose computer was silent over 10 minutes is computer_offline since its last-seen time",() => {
    const result = deriveOwnerState(open({ producer: "agent_session",session: null,computerLastSeenAt: at(5) },30));
    expect(result.absence).toEqual({ reason: "computer_offline",since: at(5) });
  });

  test("a recently seen computer does not make it offline",() => {
    const result = deriveOwnerState(open({ producer: "agent_session",session: null,computerLastSeenAt: at(25) },30));
    expect(result.absence?.reason).toBe("no_update");
  });

  test("a failed work says failed; a moving or finished one needs no reason",() => {
    const failed = deriveOwnerState({ ...base,work: { ...base.work,lifecycle: "failed",finishedAt: base.work.lastDeclaredAt },question: null,now: at(1) });
    expect(failed.absence).toEqual({ reason: "failed",since: base.work.lastDeclaredAt });
    const done = deriveOwnerState({ ...base,work: { ...base.work,lifecycle: "finished",finishedAt: base.work.lastDeclaredAt },question: null,now: at(1) });
    expect(done.absence).toBeUndefined();
    expect(deriveOwnerState(open({ producer: "script",leaseUntil: null },0)).absence).toBeUndefined();
  });

  test("an open work left for the history window reads left_unfinished",() => {
    const result = deriveOwnerState(open({ producer: "script",leaseUntil: null },24 * 60));
    expect(result.state).toBe("left_unfinished");
    expect(result.absence?.reason).toBe("left_unfinished");
  });
});
