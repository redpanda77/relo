import { describe, expect, it } from "vitest"
import { loadSnapshot } from "../relo/fixtures"
import { EMPTY, presentationOf, type Presentation } from "../relo/presentation"
import {
  checkResultLine,
  doneCount,
  headline,
  INITIAL_HOME,
  localProblemText,
  machineCountLabel,
  moodOf,
  runningCount,
  satellites,
  screenOf,
  sessionCountLabel,
  subline,
  syncLabel,
  updateBanner,
  type HomeState,
} from "./state"

const at = (ms: number) => `t${ms}`
const home = (over: Partial<HomeState>): HomeState => ({ ...INITIAL_HOME, ...over })

describe("headline and subline (ReloHomeView.swift)", () => {
  it("counts what needs you, then what runs", () => {
    expect(headline(0, 0)).toBe("All clear")
    expect(headline(1, 3)).toBe("1 needs you")
    expect(headline(2, 0)).toBe("2 need you")
    expect(headline(0, 1)).toBe("1 running")
    expect(headline(0, 4)).toBe("4 running")
  })

  it("says plainly whether a question waits", () => {
    const p = { ...EMPTY, needsYouCount: 1 }
    expect(subline(p, 0)).toBe("A question is waiting for you.")
    expect(subline(p, 1)).toBe("A question is waiting for you. One more is running.")
    expect(subline({ ...EMPTY, needsYouCount: 2 }, 3)).toBe("Questions are waiting for you. 3 more are running.")
  })

  it("names the leading running work and its step", () => {
    const focus = { title: "Migrate users", tone: "working", stepsDone: 1, stepsTotal: 4 } as unknown as NonNullable<Presentation["focus"]>
    expect(subline({ ...EMPTY, focus }, 1)).toBe("Migrate users is on step 2 of 4. Nothing needs you.")
    expect(subline({ ...EMPTY, focus: { ...focus, stepsDone: null, stepsTotal: null } }, 1)).toBe("Migrate users is running. Nothing needs you.")
    expect(subline(EMPTY, 0)).toBe("Work from your sessions and scripts shows up here and in the notch.")
  })
})

describe("fixtures", () => {
  it("the question fixture leads with a waiting question", () => {
    const p = presentationOf(loadSnapshot("question")!.summary)
    expect(p.needsYouCount).toBeGreaterThan(0)
    expect(moodOf(p)).toBe("needsYou")
    expect(headline(p.needsYouCount, runningCount(p))).toMatch(/needs? you/)
    expect(satellites(p).length).toBeGreaterThan(0)
    expect(satellites(p).length).toBeLessThanOrEqual(6)
    expect(doneCount(p)).toBeGreaterThanOrEqual(0)
  })

  it("the empty fixture is clear", () => {
    const p = presentationOf(loadSnapshot("empty")!.summary)
    expect(moodOf(p)).toBe("clear")
    expect(satellites(p)).toEqual([])
  })
})

describe("screens and labels", () => {
  it("signed in shows the work; signed out hands over to onboarding", () => {
    expect(screenOf(home({ connection: "live" }))).toBe("work")
    expect(screenOf(home({ connection: "offline" }))).toBe("work")
    expect(screenOf(home({ connection: "signedOut" }))).toBe("needsSetup")
    expect(screenOf(home({ connection: "starting" }))).toBe("needsSetup")
    expect(screenOf(home({ connection: "live", local: true, localProblem: "failed" }))).toBe("localProblem")
    expect(screenOf(home({ connection: "live", local: true, localProblem: null }))).toBe("work")
  })

  it("the sync chip", () => {
    expect(syncLabel(home({ connection: "live", lastUpdated: 5 }), at)).toBe("Live · t5")
    expect(syncLabel(home({ connection: "offline", lastUpdated: 5 }), at)).toBe("Offline · as of t5")
    expect(syncLabel(home({ connection: "starting" }), at)).toBe("Connecting")
    expect(syncLabel(home({ connection: "starting", local: true }), at)).toBe("Starting Relo…")
    expect(syncLabel(home({ connection: "offline", local: true }), at)).toBe("Relo isn't answering on this PC")
  })

  it("counts", () => {
    expect(machineCountLabel(1)).toBe("1 computer")
    expect(machineCountLabel(3)).toBe("3 computers")
    expect(sessionCountLabel(1)).toBe("1 session")
    expect(sessionCountLabel(2)).toBe("2 sessions")
    expect(localProblemText("failed").title).toBe("Relo couldn't start on this PC")
  })
})

describe("update banner (ReloUpdater.swift:192-208)", () => {
  it("says available or ready, with the button that installs", () => {
    expect(updateBanner({ update: { version: "0.2.1", ready: false } })).toEqual({ text: "Relo 0.2.1 is available", action: "Update", critical: false })
    expect(updateBanner({ update: { version: "0.2.1", ready: true } })).toEqual({ text: "Relo 0.2.1 is ready", action: "Restart now", critical: false })
  })
  it("a critical update is Important update", () => {
    expect(updateBanner({ update: { version: "0.2.1", ready: true, critical: true } })?.text).toBe("Important update")
  })
  it("falls back to the older updateVersion as available, and is null with nothing waiting", () => {
    expect(updateBanner({ updateVersion: "0.3.0" })?.text).toBe("Relo 0.3.0 is available")
    expect(updateBanner({ update: null, updateVersion: null })).toBeNull()
  })
})

describe("check for updates result", () => {
  it("speaks the outcomes that need a line; found updates show as the banner", () => {
    expect(checkResultLine("none")).toBe("Relo is up to date")
    expect(checkResultLine("off")).toBe("Updates are off in this build")
    expect(checkResultLine("error", "offline")).toBe("Couldn't check for updates: offline")
    expect(checkResultLine("available")).toBeNull()
  })
})
