/**
 * Plans for tests and for the preview page (`plan-preview.html`): the shapes plan 12b names, in the form the
 * server returns them (`activity.plan` and `activity.rounds`). Times are fixed so durations read the same.
 */
import type { PlanEntry, PlanRoundInput } from "@/features/inbox/plan-outline"

export type PlanFixture = { name: string; entries: PlanEntry[]; rounds?: PlanRoundInput[]; standing?: "moving" | "done" | "stopped" | "paused" }

const at = (minute: number) => new Date(Date.UTC(2026, 9, 16, 14, minute)).toISOString()

function step(id: string, state: PlanEntry["state"], label: string | undefined, extra: Partial<PlanEntry> = {}): PlanEntry {
  return { id, state, ...(label !== undefined ? { label } : {}), ...extra }
}

export const flatPlan: PlanFixture = {
  name: "Flat, one round",
  entries: [
    step("s1", "done", "Reproduce the crash", { startedAt: at(0), doneAt: at(4) }),
    step("s2", "done", "Find the cause", { startedAt: at(4), doneAt: at(15) }),
    step("s3", "current", "Patch token refresh", { startedAt: at(15), detail: "The refresh raced the logout; one lock now guards both." }),
    step("s4", "open", "Run the tests"),
    step("s5", "open", "Ship"),
  ],
}

export const nestedPlan: PlanFixture = {
  name: "Nested, current step opened",
  entries: [
    step("s1", "done", "Audit the plan model", { startedAt: at(0), doneAt: at(12) }),
    step("s2", "current", "Patch token refresh", { startedAt: at(12) }),
    step("s3", "done", "Write the failing test", { parent: "s2", startedAt: at(12), doneAt: at(15) }),
    step("s4", "current", "Fix the refresh race", { parent: "s2", startedAt: at(15) }),
    step("s5", "open", "Cover the offline case", { parent: "s2" }),
    step("s6", "open", "Run the tests"),
    step("s7", "open", "Cover the unit suites", { parent: "s6" }),
    step("s8", "open", "Cover the end to end suites", { parent: "s6" }),
    step("s9", "open", "Ship"),
  ],
}

/** Three levels: a step, its child, its grandchild (the deepest the plan allows). */
export const deepPlan: PlanFixture = {
  name: "Three levels deep",
  entries: [
    step("a", "current", "Cover offline mode"),
    step("b", "current", "Queue refreshes while offline", { parent: "a" }),
    step("c", "current", "Store the pending refresh", { parent: "b" }),
    step("d", "open", "Replay on reconnect", { parent: "b" }),
    step("e", "open", "Ship", { parent: "a" }),
    step("f", "open", "Announce it"),
  ],
}

export const roundsPlan: PlanFixture = {
  name: "Three rounds",
  rounds: [
    { n: 1, state: "closed", title: "Fix the login crash", outcome: "Login fixed: token refresh patched and tested", openedAt: at(0), closedAt: at(120) },
    { n: 2, state: "closed", title: "Expand to iOS", outcome: "iOS login uses the same refresh path", openedAt: at(125), closedAt: at(165) },
    { n: 3, state: "open", title: "Cover offline mode", openedAt: at(170) },
  ],
  entries: [
    step("r1a", "done", "Reproduce the crash", { round: 1, startedAt: at(0), doneAt: at(30) }),
    step("r1b", "done", "Patch the refresh", { round: 1, startedAt: at(30), doneAt: at(120) }),
    step("r2a", "done", "Port the fix to iOS", { round: 2, startedAt: at(125), doneAt: at(165) }),
    step("r3a", "done", "Map the offline paths", { round: 3, startedAt: at(170), doneAt: at(174) }),
    step("r3b", "current", "Queue refreshes while offline", { round: 3, startedAt: at(174) }),
    step("r3c", "current", "Store the pending refresh", { round: 3, parent: "r3b" }),
    step("r3d", "open", "Replay on reconnect", { round: 3, parent: "r3b" }),
    step("r3e", "open", "Ship", { round: 3 }),
  ],
}

export const manyRoundsPlan: PlanFixture = {
  name: "Five rounds (earlier rounds fold)",
  rounds: [1, 2, 3, 4, 5].map((n) => ({
    n,
    state: n === 5 ? ("open" as const) : ("closed" as const),
    title: `Request number ${n}`,
    ...(n === 5 ? {} : { outcome: `Request ${n} delivered` }),
    openedAt: at(n * 10),
    ...(n === 5 ? {} : { closedAt: at(n * 10 + 8) }),
  })),
  entries: [1, 2, 3, 4, 5].flatMap((n) => [
    step(`q${n}a`, n === 5 ? "current" : "done", `Do the first part of request ${n}`, { round: n }),
    step(`q${n}b`, "open", `Finish request ${n}`, { round: n }),
  ]),
}

const LONG = [
  "Migrate the notification delivery queue to the new retry policy and keep the old counters readable",
  "Rewrite the sealed card opener so labels match by step id and never by position in the list",
  "Port the plan folding rules to the Dashboard and prove them with fixtures of every shape",
]

/** 10 phases with 2 substeps each (30 steps in all), long labels, the fourth phase current. */
export const longPlan: PlanFixture = {
  name: "30 steps: 10 phases of 2 substeps, long labels",
  entries: Array.from({ length: 10 }, (_, phase) => {
    const state: PlanEntry["state"] = phase < 3 ? "done" : phase === 3 ? "current" : "open"
    const label = (part: number) => `Phase ${phase + 1}, part ${part}: ${LONG[(phase + part) % LONG.length]}`
    return [
      step(`p${phase}`, state, label(0), { ...(state === "done" ? { startedAt: at(phase * 10), doneAt: at(phase * 10 + 9) } : {}) }),
      step(`p${phase}a`, state === "done" ? "done" : state === "current" ? "done" : "open", label(1), { parent: `p${phase}` }),
      step(`p${phase}b`, state === "done" ? "done" : state === "current" ? "current" : "open", label(2), { parent: `p${phase}` }),
    ]
  }).flat(),
}

/** 12 top-level steps: windowed around the current one ("5 done", "4 to go"). */
export const windowedPlan: PlanFixture = {
  name: "12 steps, windowed",
  entries: Array.from({ length: 12 }, (_, i) => step(`w${i}`, i < 6 ? "done" : i === 6 ? "current" : "open", `Step of the migration, number ${i + 1}`)),
}

export const skippedPlan: PlanFixture = {
  name: "Skipped steps",
  entries: [
    step("k1", "done", "Collect the logs", { startedAt: at(0), doneAt: at(6) }),
    step("k2", "skipped", "Ask for the old build"),
    step("k3", "current", "Bisect the regression"),
    step("k4", "skipped", "Write a postmortem"),
    step("k5", "open", "Ship the fix"),
  ],
}

/** A sealed work whose labels this browser could not open: no placeholder is shown as if real. */
export const sealedPlan: PlanFixture = {
  name: "Sealed, not readable",
  entries: [
    step("s1", "done", undefined),
    step("s2", "current", "Step 2"),
    step("s3", "open", undefined),
  ],
}

export const stoppedPlan: PlanFixture = {
  name: "Stopped (failed)",
  standing: "stopped",
  entries: [
    step("f1", "done", "Build the app"),
    step("f2", "current", "Run the migration"),
    step("f3", "skipped", "Verify the data", { doneAt: at(30) }),
    step("f4", "skipped", "Ship", { doneAt: at(30) }),
  ],
}

export const doneFixture: PlanFixture = {
  name: "Finished",
  standing: "done",
  entries: [step("d1", "done", "Draft the change"), step("d2", "done", "Review it"), step("d3", "done", "Ship it")],
}

export const planFixtures: PlanFixture[] = [
  flatPlan, nestedPlan, deepPlan, roundsPlan, manyRoundsPlan, longPlan, windowedPlan, skippedPlan, sealedPlan, stoppedPlan, doneFixture,
]
