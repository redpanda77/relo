import { readFileSync } from "node:fs";
import { describe,expect,test } from "vitest";
import { planProgressOf,stepsOf } from "./load.js";

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
