import { readFileSync } from "node:fs";
import { describe,expect,test } from "vitest";
import { ownerStateInputSchema,sessionRowInputSchema,type OwnerStateInput } from "@relo/notification-contracts";
import { deriveOwnerState } from "./owner-state.js";
import { deriveSessionRow } from "./sessions-view.js";

const fixture = JSON.parse(readFileSync(new URL("../../../../packages/contracts/fixtures/owner-state-v1.json",import.meta.url),"utf8"));

describe("derive() over the shared fixtures",() => {
  for (const row of fixture.derive) {
    test(row.name,() => {
      expect(deriveOwnerState(ownerStateInputSchema.parse(row.input))).toEqual(row.expected);
    });
  }
});

describe("Sessions view rows over the shared fixtures",() => {
  for (const row of fixture.sessions) {
    test(row.name,() => {
      expect(deriveSessionRow(sessionRowInputSchema.parse(row.input))).toEqual(row.expected);
    });
  }
});

describe("derive() invariants",() => {
  const base = fixture.derive[0].input as OwnerStateInput;
  test("a pending question never ends a work: any lifecycle with one is Needs you",() => {
    for (const lifecycle of ["open","paused","finished","failed","dropped"] as const) {
      const result = deriveOwnerState({ ...base,work: { ...base.work,lifecycle,finishedAt: lifecycle === "open" || lifecycle === "paused" ? null : base.work.lastDeclaredAt },
        question: { standing: "pending",askedAt: base.work.lastDeclaredAt,openedAt: null } });
      expect(result.state).toBe("needs_you");
    }
  });

  test("a missed question never needs the owner: the work's own state, opened or not",() => {
    const at = base.work.lastDeclaredAt;
    const finished = { ...base,work: { ...base.work,lifecycle: "finished" as const,finishedAt: at } };
    for (const openedAt of [null,at]) {
      const missed = deriveOwnerState({ ...finished,question: { standing: "missed",askedAt: at,openedAt } });
      expect(missed.needsYou).toBeNull();
      expect(missed.state).toBe("done");
    }
  });

  test("another producer type's evidence never yields observed states",() => {
    for (const minutes of [1,9,15,25,61,200,600]) {
      const now = new Date(Date.parse(base.work.lastDeclaredAt) + minutes * 60_000).toISOString();
      for (const producer of ["script","service"] as const) {
        const state = deriveOwnerState({ ...base,now,evidence: { producer,leaseUntil: null } }).state;
        expect(["waiting_on_you","working_quietly","stopped_responding"]).not.toContain(state);
      }
    }
  });

  test("derive is pure: the same input gives the same output, and nextChangeAt is when it changes",() => {
    for (const row of fixture.derive) {
      const input = ownerStateInputSchema.parse(row.input);
      const result = deriveOwnerState(input);
      expect(deriveOwnerState(input)).toEqual(result);
      if (result.nextChangeAt) {
        const before = deriveOwnerState({ ...input,now: new Date(Date.parse(result.nextChangeAt) - 1).toISOString() });
        const after = deriveOwnerState({ ...input,now: result.nextChangeAt });
        expect([before.state,before.lockScreen,before.now]).toEqual([result.state,result.lockScreen,result.now]);
        expect([after.state,after.lockScreen,after.now,after.needsYou]).not.toEqual([result.state,result.lockScreen,result.now,result.needsYou]);
      }
    }
  });
});
