import { describe, expect, it } from "vitest"

import {
  agentsNotSetUp,
  computerHealth,
  computerOverrides,
  doctorLine,
  isReportStale,
  rowChips,
  settingRows,
  setupPills,
  visibleHarnesses,
} from "@/features/connections/computer-health"
import { computer, report } from "@/features/connections/computers-fixtures"
import { systemPresentationPolicy } from "@/features/presentation-policy/types"

describe("computer health", () => {
  it("says nothing without a report, except what the server knows by itself", () => {
    expect(computerHealth(computer())).toEqual([])
    expect(computerHealth(computer({ encryption: "no_keys" })).map((chip) => chip.label)).toEqual(["Not encrypting"])
  })

  it("names a CLI that is behind, hooks that are out of date and a failing doctor, in that order after encryption", () => {
    const sick = computer({
      encryption: "no_keys",
      report: report({
        cli: { version: "0.17.10", latest: "0.17.12", update: "behind" },
        harnesses: [{ id: "codex", detected: true, instructions: "set", level: "guide", modules: ["notify", "reporting", "planning"], skill: "current", hooks: "presence", hooksOutdated: true, mcp: "none" }],
        doctor: { at: "2026-10-16T10:00:00.000Z", ok: false, failing: ["server"] },
      }),
    })
    expect(computerHealth(sick).map((chip) => chip.label)).toEqual(["Not encrypting", "CLI behind", "Hooks out of date", "Doctor found problems"])
  })

  it("does not call hooks out of date on a tool that is not on the machine or has hooks off", () => {
    const quiet = computer({
      report: report({
        harnesses: [
          { id: "codex", detected: false, instructions: "none", level: "none", modules: [], skill: "none", hooks: "presence", hooksOutdated: true, mcp: "none" },
          { id: "claude-code", detected: true, instructions: "set", level: "guide", modules: ["notify", "reporting", "planning"], skill: "current", hooks: "off", hooksOutdated: true, mcp: "none" },
        ],
      }),
    })
    expect(computerHealth(quiet)).toEqual([])
  })

  it("lists what differs from the account, and the row keeps two chips: overrides first", () => {
    const set = computer({
      liveActivityPolicySource: "client",
      effectiveLiveActivityPolicy: { ...systemPresentationPolicy, colorStrategy: "fixed" },
      maxActiveCards: 1,
      encryption: "no_keys",
    })
    expect(computerOverrides(set)).toEqual(["One color", "Max 1 card"])
    expect(rowChips(set).map((chip) => chip.label)).toEqual(["One color", "Max 1 card"])
    expect(rowChips(computer({ encryption: "no_keys", maxActiveCards: 3 })).map((chip) => [chip.label, chip.kind])).toEqual([
      ["Max 3 cards", "override"],
      ["Not encrypting", "health"],
    ])
  })

  it("calls a report stale after a week", () => {
    const now = Date.parse("2026-10-16T12:00:00.000Z")
    expect(isReportStale(null, now)).toBe(false)
    expect(isReportStale("2026-10-10T12:00:00.000Z", now)).toBe(false)
    expect(isReportStale("2026-10-08T12:00:00.000Z", now)).toBe(true)
  })
})

describe("computer setup and settings", () => {
  it("turns a tool's install facts into four pills", () => {
    const pills = setupPills({ id: "claude-code", detected: true, instructions: "stale", level: "track", modules: ["notify", "reporting"], skill: "none", hooks: "presence", hooksOutdated: true, mcp: "set" })
    expect(pills.map((pill) => [pill.id, pill.state, pill.detail])).toEqual([
      ["instructions", "outdated", "Track, out of date"],
      ["skill", "missing", "Not installed"],
      ["hooks", "outdated", "Presence, out of date"],
      ["mcp", "ok", "Installed"],
    ])
    expect(setupPills({ id: "codex", detected: true, instructions: "kept", level: "none", modules: [], skill: "current", hooks: "off", hooksOutdated: false, mcp: "none" })
      .map((pill) => pill.state)).toEqual(["ok", "ok", "missing", "missing"])
  })

  it("shows tools that are detected or have something of Relo's installed", () => {
    const shown = visibleHarnesses(report({
      harnesses: [
        { id: "a", detected: false, instructions: "none", level: "none", modules: [], skill: "none", hooks: "off", hooksOutdated: false, mcp: "none" },
        { id: "b", detected: true, instructions: "none", level: "none", modules: [], skill: "none", hooks: "off", hooksOutdated: false, mcp: "none" },
        { id: "c", detected: false, instructions: "none", level: "none", modules: [], skill: "current", hooks: "off", hooksOutdated: false, mcp: "none" },
      ],
    }))
    expect(shown.map((harness) => harness.id)).toEqual(["b", "c"])
  })

  it("reads a name setting as Set and says where each value comes from", () => {
    expect(settingRows(report())).toEqual([
      { key: "server", label: "Server", value: "relo.example.test", from: "Config file" },
      { key: "project", label: "Project", value: "Set", from: "Environment (RELO_PROJECT)" },
      { key: "computer", label: "Computer name", value: "Set", from: "Config file" },
      { key: "updateCheck", label: "Update checks", value: "on", from: "Default" },
    ])
  })

  it("words the last doctor run", () => {
    expect(doctorLine(report(), () => "2 h ago")).toBe("Last checked by relo doctor 2 h ago: all good")
    expect(doctorLine(report({ doctor: { at: "x", ok: false, failing: ["server", "hooks"] } }), () => "now")).toBe("Last checked by relo doctor now: server, hooks")
    expect(doctorLine(report({ doctor: null }), () => "now")).toBeNull()
  })
  it("names an agent installed after setup, once some agent there is set up", () => {
    const row = (id: string, detected: boolean, level: "guide" | "none") =>
      ({ id, detected, instructions: level === "none" ? "none" : "set", level, modules: [], skill: "none", hooks: "off", hooksOutdated: false, mcp: "none" }) as const
    const report = (harnesses: ReturnType<typeof row>[]) => ({ harnesses }) as unknown as Parameters<typeof agentsNotSetUp>[0]
    expect(agentsNotSetUp(report([row("claude-code", true, "guide"), row("codex", true, "none"), row("gemini", false, "none"), row("agents", true, "none")]))).toEqual(["codex"])
    expect(agentsNotSetUp(report([row("claude-code", true, "none"), row("codex", true, "none")]))).toEqual([])
  })
})
