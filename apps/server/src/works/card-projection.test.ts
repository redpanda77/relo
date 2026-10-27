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

  test("files a work without a project under its source, never a made-up project", () => {
    expect(cardContext(work({ providerName: "Claude Code",threadName: "Storage cleanup" })).project).toBe("Claude Code");
    expect(cardContext(work({ computer: "Build Mac" })).project).toBe("Build Mac");
    expect(cardContext(work(null)).project).toBeUndefined();
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
    expect(cardSteps(plan(5,2))).toEqual({ labels: ["Phase 1","Phase 2","Phase 3","Phase 4","Phase 5"],ids: ["s1","s2","s3","s4","s5"],current: 2,
      states: ["done","current","pending","pending","pending"],
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

// The bar and the caption read one plan: the lit segment is the caption's "Step N", the done segments are `done`.
describe("card bar and caption agree (plan bar regression)", () => {
  const step = (id: string,state: string,round?: number,extra: Record<string,unknown> = {}) => ({ id,label: `Label ${id}`,state,...(round ? { round } : {}),...extra });
  /** What the phone draws: the real states, hidden steps before (done) and after (not started). */
  const bar = (card: NonNullable<ReturnType<typeof cardSteps>>) => [
    ...Array<string>(card.before ?? 0).fill("done"),...card.states,...Array<string>(card.after ?? 0).fill("pending"),
  ];
  const caption = (card: NonNullable<ReturnType<typeof cardSteps>>) => card.plan!;
  const check = (plan: unknown,expected: { total: number; done: number; lit: number | null }) => {
    const card = cardSteps(plan as Parameters<typeof cardSteps>[0])!;
    const segments = bar(card);
    expect(segments).toHaveLength(expected.total);
    expect(segments.filter((state) => state === "done")).toHaveLength(expected.done);
    expect(caption(card)).toMatchObject({ total: expected.total,done: expected.done,current: expected.lit });
    expect(segments.filter((state) => state === "current")).toHaveLength(expected.lit === null ? 0 : 1);
    if (expected.lit !== null) expect(segments.indexOf("current") + 1).toBe(expected.lit);
    return card;
  };

  test("nothing done and nothing current: no segment is lit, none invented (was: the last step)", () => {
    const card = check({ steps: Array.from({ length: 6 },(_,i) => step(`s${i + 1}`,"open")) },{ total: 6,done: 0,lit: null });
    expect(card.states).toEqual(["pending","pending","pending","pending","pending","pending"]);
  });

  test("step 1 current, nothing done: segment 1 is lit and the caption says step 1", () => {
    check({ steps: [step("s1","current"),...Array.from({ length: 5 },(_,i) => step(`s${i + 2}`,"open"))] },{ total: 6,done: 0,lit: 1 });
  });

  test("a step done out of order: the done segment is the done step, not the first one", () => {
    const card = check({ steps: [step("s1","open"),step("s2","done"),step("s3","current"),step("s4","open")] },{ total: 4,done: 1,lit: 3 });
    expect(card.states).toEqual(["pending","done","current","pending"]);
  });

  test("a delivered first round and a second round that carries on: one frame, the whole plan", () => {
    const plan = {
      rounds: [{ n: 1,state: "closed" },{ n: 2,state: "open" }],
      steps: [step("s1","done",1),step("s2","done",1),step("s3","open",1),
        step("s4","open",2,{ carriedFrom: "s3" }),step("s5","current",2),step("s6","open",2)],
    };
    const card = check(plan,{ total: 5,done: 2,lit: 4 });
    expect(card.before).toBe(2);
    expect(card.states).toEqual(["pending","current","pending"]);
  });

  test("a second round with its own plan counts alone", () => {
    const plan = {
      rounds: [{ n: 1,state: "closed" },{ n: 2,state: "open" }],
      steps: [step("s1","done",1),step("s2","done",1),step("s3","current",2),step("s4","open",2)],
    };
    const card = check(plan,{ total: 2,done: 0,lit: 1 });
    expect(card.before).toBeUndefined();
  });

  test("a delivered round marks no current step", () => {
    const plan = { rounds: [{ n: 1,state: "closed" }],steps: [step("s1","done",1),step("s2","done",1)] };
    const card = cardSteps(plan as never)!;
    expect(card.states).not.toContain("current");
    expect(card.plan).toMatchObject({ delivered: true,current: null });
  });

  test("a long plan's window keeps the lit segment at the caption's number", () => {
    const steps = Array.from({ length: 12 },(_,i) => step(`s${i + 1}`,i < 6 ? "done" : i === 6 ? "current" : "open"));
    check({ steps },{ total: 12,done: 6,lit: 7 });
  });

  test("a substep current lights its top-level step", () => {
    const plan = { steps: [step("s1","done"),step("s2","open"),step("s3","current",undefined,{ parent: "s2" })] };
    const card = check(plan,{ total: 2,done: 1,lit: 2 });
    expect(card.states).toEqual(["done","current"]);
  });
});

describe("progress counts top-level steps (plan 14, workstream 7)", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../../packages/contracts/test/fixtures/plan-card.json",import.meta.url),"utf8")) as {
    plan: Parameters<typeof cardSteps>[0]; workProgress: { done: number; total: number };
    card: { labels: string[]; current: number; plan: unknown };
  };
  const stale = () => ({ plan: fixture.plan,progress_n: fixture.workProgress.done,progress_m: fixture.workProgress.total }) as unknown as WorkRow;

  test("4 steps, the first with 3 substeps (2 done): 4 segments, step 1, its segment 2/3 full, no percentage", () => {
    expect(cardSteps(fixture.plan,{ readable: true })).toMatchObject({ labels: fixture.card.labels,current: fixture.card.current,plan: fixture.card.plan });
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
