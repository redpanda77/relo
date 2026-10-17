import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { cardContext,cardProgress,cardSteps } from "./card-projection.js";
import { applyProgress } from "./declared.js";
import type { WorkRow } from "./store.js";

const work = (context: Record<string,unknown> | null) =>
  ({ id: "ba35b0ed-1111-4222-8333-444455556666",context } as unknown as WorkRow);

describe("work card context", () => {
  test("never makes a topic from the work id", () => {
    for (const context of [null,{},{ project: "relo",providerName: "Claude Code" },{ project: "relo",threadName: 42 }]) {
      const card = cardContext(work(context));
      expect(card.threadName).toBeUndefined();
      expect(JSON.stringify(card)).not.toMatch(/work-[0-9a-f]{8}/);
    }
  });

  test("carries the session's own name as the topic", () => {
    expect(cardContext(work({ providerName: "Claude Code",project: "relo",threadName: "Release review" })))
      .toEqual({ providerName: "Claude Code",project: "relo",threadName: "Release review" });
  });
});

describe("work card steps", () => {
  const plan = (count: number,current: number) => ({ steps: Array.from({ length: count },(_,index) => ({
    id: `s${index + 1}`,label: `Phase ${index + 1}`,
    state: index + 1 < current ? "done" : index + 1 === current ? "current" : "open",
  })) }) as unknown as Parameters<typeof cardSteps>[0];

  test("a short plan is shown whole, with nothing hidden", () => {
    expect(cardSteps(plan(5,2))).toEqual({ labels: ["Phase 1","Phase 2","Phase 3","Phase 4","Phase 5"],current: 2,
      plan: { done: 1,total: 5,currentId: "s2",sub: null,round: 1,rounds: 1,delivered: false,current: 2,fill: null } });
  });

  test("the plan count carries labels only for a readable work, clipped to the card's 40",() => {
    const steps = plan(3,2);
    expect(cardSteps(steps,{ readable: true })?.plan).toMatchObject({ currentId: "s2",stepLabel: "Phase 2" });
    expect(cardSteps(steps,{ readable: false })?.plan?.stepLabel).toBeUndefined();
    const long = { steps: [{ id: "s1",label: "x".repeat(60),state: "current" }] } as unknown as Parameters<typeof cardSteps>[0];
    expect(cardSteps(long,{ readable: true })?.plan?.stepLabel).toHaveLength(40);
  });

  // A 10-step plan read "Step 1 · 7 to go" and "0 of 8": the window was counted as the whole plan.
  test("a long plan's window counts the steps hidden around it", () => {
    expect(cardSteps(plan(10,1))).toMatchObject({ current: 1,after: 2 });
    expect(cardSteps(plan(10,1))?.before).toBeUndefined();
    const middle = cardSteps(plan(10,5))!;
    expect(middle).toMatchObject({ current: 3,before: 2 });
    expect(middle.labels[0]).toBe("Phase 3");
    expect((middle.before ?? 0) + middle.labels.length + (middle.after ?? 0)).toBe(10);
    expect(cardSteps(plan(10,10))).toMatchObject({ current: 8,before: 2 });
  });
});

describe("progress counts top-level steps (plan 14, workstream 7)", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../../packages/contracts/test/fixtures/plan-card.json",import.meta.url),"utf8")) as {
    plan: Parameters<typeof cardSteps>[0]; workProgress: { done: number; total: number };
    card: { labels: string[]; current: number; plan: unknown };
  };
  const stale = () => ({ plan: fixture.plan,progress_n: fixture.workProgress.done,progress_m: fixture.workProgress.total }) as unknown as WorkRow;

  test("4 steps, the first with 3 substeps (2 done): 4 segments, step 1, its segment 2/3 full, no percentage", () => {
    expect(cardSteps(fixture.plan,{ readable: true })).toEqual({ labels: fixture.card.labels,current: fixture.card.current,plan: fixture.card.plan });
    expect(cardSteps(fixture.plan)?.plan).toMatchObject({ done: 0,total: 4,current: 1 });
    // The stale 3 of 4 on the work never becomes the card's 75%.
    expect(cardProgress(stale())).toBeUndefined();
  });

  test("a work without a plan shows a percentage only when the producer sent one", () => {
    const bare = (n: number | null,m: number | null) => ({ plan: null,progress_n: n,progress_m: m }) as unknown as WorkRow;
    expect(cardProgress(bare(1,4))).toBe(0.25);
    expect(cardProgress(bare(null,null))).toBeUndefined();
  });

  test("a step's own progress refines the current step; the work-level count is dropped", () => {
    const row = stale();
    applyProgress(row,{ done: 1,total: 4 });
    expect(row.progress_n).toBeNull();
    expect(row.progress_m).toBeNull();
    const flat = { ...fixture.plan,steps: [{ id: "s1",label: "A",state: "current" },{ id: "s2",label: "B",state: "open" }] } as Parameters<typeof cardSteps>[0];
    const refined = { plan: flat } as unknown as WorkRow;
    applyProgress(refined,{ done: 1,total: 4 });
    expect(cardSteps(refined.plan)?.plan).toMatchObject({ current: 1,fill: 0.25 });
  });
});

describe("sealed card placeholders", () => {
  // The iPhone swaps only its own exact placeholder strings for the opened text; a different wording
  // ("Encrypted work") was shown to the owner as if it were the card's text.
  test("server, CLI and iPhone use the same strings", async () => {
    const { readFile } = await import("node:fs/promises");
    const { SEALED_CARD_PLACEHOLDERS } = await import("@relo/notification-contracts");
    const root = new URL("../../../../",import.meta.url);
    const swift = await readFile(new URL("apps/ios/Sources/ReloCore/E2EE/ReloSealedCards.swift",root),"utf8");
    const cli = await readFile(new URL("packages/cli/src/crypto/seal-card.mjs",root),"utf8");
    expect(swift).toContain(`titlePlaceholder = "${SEALED_CARD_PLACEHOLDERS.title}"`);
    expect(swift).toContain(`statusPlaceholder = "${SEALED_CARD_PLACEHOLDERS.status}"`);
    expect(cli).toContain(`SEALED_CARD_TITLE = "${SEALED_CARD_PLACEHOLDERS.title}"`);
    expect(cli).toContain(`SEALED_CARD_STATUS = "${SEALED_CARD_PLACEHOLDERS.status}"`);
    const projection = await readFile(new URL("apps/server/src/works/card-projection.ts",root),"utf8");
    expect(projection).not.toMatch(/"Encrypted work"|"Open Relo to read"/u);
  });
});
