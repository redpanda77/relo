import { readFileSync } from "node:fs";
import { describe,expect,test } from "vitest";
import { nowItemSchema } from "@relo/notification-contracts";
import { planDigestOf,planProgressOf,stepsOf } from "./load.js";

const fixture = JSON.parse(readFileSync(new URL("../../../../packages/contracts/test/fixtures/plan-card.json",import.meta.url),"utf8")) as { plan: unknown };
const row = (extra: Record<string,unknown> = {}) => ({ work_plan: fixture.plan,privacy: "standard",work_sealed_text: false,work_lifecycle: "open",...extra }) as unknown as Parameters<typeof stepsOf>[0];

describe("Now item steps count top-level steps (plan 14, workstream 7)", () => {
  test("4 steps with 3 substeps under the first read 0 of 4, never 2 of 7", () => {
    expect(stepsOf(row())).toEqual({ done: 0,total: 4,current: "Migrate the batches" });
    expect(planProgressOf(row())).toMatchObject({ done: 0,total: 4,current: 1 });
  });

  test("a sealed or private work carries no label; no plan carries no steps", () => {
    expect(stepsOf(row({ work_sealed_text: true }))?.current).toBeNull();
    expect(stepsOf(row({ privacy: "private" }))?.current).toBeNull();
    expect(stepsOf(row({ work_plan: null }))).toBeNull();
  });
});

describe("Now items carry the whole plan so devices draw rounds and nested steps", () => {
  test("each step keeps its state, parent and times; labels only for readable work", () => {
    const digest = planDigestOf(row());
    expect(digest?.plan.map((step) => [step.id,step.state,step.parent ?? null])).toEqual(
      (fixture.plan as { steps: Array<{ id: string; state: string; parent?: string }> }).steps.map((step) => [step.id,step.state,step.parent ?? null]));
    expect(digest?.plan[1]).toMatchObject({ label: "Batch 1",parent: "s1",doneAt: "2026-10-17T10:02:00.000Z" });
    expect(planDigestOf(row({ work_sealed_text: true }))?.plan.every((step) => step.label === null && !step.detail)).toBe(true);
    expect(planDigestOf(row({ privacy: "private" }))?.plan.every((step) => step.label === null)).toBe(true);
    expect(planDigestOf(row({ work_plan: null }))).toBeNull();
  });

  test("rounds keep title and outcome only for readable work, and the digest fits the Now item contract", () => {
    const plan = { v: 1,next: 3,steps: [{ id: "s1",state: "done",addedIn: 1,label: "Draft",round: 1 },
      { id: "s2",state: "current",addedIn: 2,label: "Build",round: 2 }],
      rounds: [{ n: 1,state: "closed",title: "Propose",outcome: "Draft committed",openedAt: "2026-10-17T10:00:00.000Z",closedAt: "2026-10-17T10:30:00.000Z" },
        { n: 2,state: "open",title: "Implement" }] };
    expect(planDigestOf(row({ work_plan: plan }))?.rounds).toEqual([
      { n: 1,state: "closed",title: "Propose",outcome: "Draft committed",openedAt: "2026-10-17T10:00:00.000Z",closedAt: "2026-10-17T10:30:00.000Z" },
      { n: 2,state: "open",title: "Implement" }]);
    expect(planDigestOf(row({ work_plan: plan,work_sealed_text: true }))?.rounds?.[0]).toEqual(
      { n: 1,state: "closed",openedAt: "2026-10-17T10:00:00.000Z",closedAt: "2026-10-17T10:30:00.000Z" });
    const shape = nowItemSchema.pick({ plan: true,rounds: true });
    expect(shape.safeParse(planDigestOf(row({ work_plan: plan }))).success).toBe(true);
    expect(shape.safeParse(planDigestOf(row())).success).toBe(true);
  });
});
