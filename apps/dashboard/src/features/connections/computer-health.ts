import type { ConnectionComputer } from "@/features/connections/types"

/**
 * What a computer's report says about its health, as plain data (ADR 0011, "observed device facts"). Pure, so
 * the row, the panel and the tests share one rule. Nothing here is stored or sent: it only decides what to show.
 */
type Report = NonNullable<ConnectionComputer["report"]>
type ReportHarness = Report["harnesses"][number]

/** A report older than this is shown with a notice: the computer has not said anything about itself for a week. */
export const REPORT_STALE_DAYS = 7
const DAY_MS = 86_400_000

export type HealthChip = { id: string; label: string }

export function isReportStale(reportedAt: string | null, now: number = Date.now()): boolean {
  if (!reportedAt) return false
  const at = Date.parse(reportedAt)
  return Number.isFinite(at) && now - at > REPORT_STALE_DAYS * DAY_MS
}

/** Hooks that are on but not current, or an older install style. Detected tools only: an unused tool is not a problem. */
function hooksNeedUpdate(harness: ReportHarness): boolean {
  return harness.detected && harness.hooks !== "off" && (harness.hooksOutdated || harness.hooks === "legacy")
}

/**
 * Agents the computer has that Relo does not cover yet (installed after setup): the rule `relo doctor` and the Set up
 * checklist use. Only once some agent there is set up; the shared AGENTS.md row is not an agent.
 */
export function agentsNotSetUp(report: Report | null | undefined): string[] {
  if (!report || !report.harnesses.some((harness) => harness.level !== "none")) return []
  return report.harnesses.filter((harness) => harness.id !== "agents" && harness.detected && harness.level === "none").map((harness) => harness.id)
}

/**
 * Things the owner should look at, most important first. Empty without a report (an old CLI says nothing, and
 * "no news" is not a problem), except for encryption, which the server knows by itself.
 */
export function computerHealth(computer: ConnectionComputer): HealthChip[] {
  const chips: HealthChip[] = []
  if (computer.encryption === "no_keys") chips.push({ id: "encryption", label: "Not encrypting" })
  const report = computer.report
  if (!report) return chips
  if (report.cli.update === "behind") chips.push({ id: "cli", label: "CLI behind" })
  if (agentsNotSetUp(report).length) chips.push({ id: "agents", label: "Agent not set up" })
  if (report.harnesses.some(hooksNeedUpdate)) chips.push({ id: "hooks", label: "Hooks out of date" })
  if (report.doctor && !report.doctor.ok) chips.push({ id: "doctor", label: "Doctor found problems" })
  return chips
}

/** What differs from the account's defaults, as short words for the row. */
export function computerOverrides(computer: ConnectionComputer): string[] {
  const words: string[] = []
  if (computer.liveActivityPolicySource === "client") {
    words.push(computer.effectiveLiveActivityPolicy.colorStrategy === "fixed" ? "One color" : "Per project color")
  }
  if (computer.maxActiveCards !== null) {
    words.push(`Max ${computer.maxActiveCards} card${computer.maxActiveCards === 1 ? "" : "s"}`)
  }
  return words
}

/** The quiet chips at the end of a row: overrides first, then health, at most `max`. */
export function rowChips(computer: ConnectionComputer, max = 2): Array<{ id: string; label: string; kind: "override" | "health" }> {
  return [
    ...computerOverrides(computer).map((label) => ({ id: `override-${label}`, label, kind: "override" as const })),
    ...computerHealth(computer).map((chip) => ({ ...chip, kind: "health" as const })),
  ].slice(0, max)
}

export type PillState = "ok" | "outdated" | "missing"
export type SetupPill = { id: "instructions" | "skill" | "hooks" | "mcp"; label: string; state: PillState; detail: string }

const DEPTHS: Record<ReportHarness["level"], string> = {
  notify: "Notify",
  track: "Track",
  guide: "Guide",
  optimize: "Optimize",
  custom: "Custom",
  none: "Installed",
}

const HOOK_LEVELS: Record<ReportHarness["hooks"], string> = {
  off: "Off",
  presence: "Presence",
  approvals: "Approvals",
  custom: "Custom",
  legacy: "Older install",
}

/** The four install facts of one tool as pills: Instructions, Skill, Hooks (with its level), MCP. */
export function setupPills(harness: ReportHarness): SetupPill[] {
  const instructions: SetupPill =
    harness.instructions === "set" ? { id: "instructions", label: "Instructions", state: "ok", detail: DEPTHS[harness.level] }
    : harness.instructions === "kept" ? { id: "instructions", label: "Instructions", state: "ok", detail: "Kept by you" }
    : harness.instructions === "stale" ? { id: "instructions", label: "Instructions", state: "outdated", detail: harness.level === "none" ? "Out of date" : `${DEPTHS[harness.level]}, out of date` }
    : harness.instructions === "hidden" ? { id: "instructions", label: "Instructions", state: "outdated", detail: "Hidden from the agent" }
    : { id: "instructions", label: "Instructions", state: "missing", detail: "Not installed" }
  const skill: SetupPill =
    harness.skill === "current" ? { id: "skill", label: "Skill", state: "ok", detail: "Installed" }
    : harness.skill === "outdated" ? { id: "skill", label: "Skill", state: "outdated", detail: "Out of date" }
    : { id: "skill", label: "Skill", state: "missing", detail: "Not installed" }
  const hooks: SetupPill =
    harness.hooks === "off" ? { id: "hooks", label: "Hooks", state: "missing", detail: "Off" }
    : harness.hooks === "legacy" || harness.hooksOutdated
      ? { id: "hooks", label: "Hooks", state: "outdated", detail: `${HOOK_LEVELS[harness.hooks]}, out of date` }
      : { id: "hooks", label: "Hooks", state: "ok", detail: HOOK_LEVELS[harness.hooks] }
  const mcp: SetupPill =
    harness.mcp === "set" ? { id: "mcp", label: "MCP", state: "ok", detail: "Installed" }
    : harness.mcp === "stale" ? { id: "mcp", label: "MCP", state: "outdated", detail: "Out of date" }
    : { id: "mcp", label: "MCP", state: "missing", detail: "Not installed" }
  return [instructions, skill, hooks, mcp]
}

/** Tools worth a row on Setup: detected on the machine or with something of Relo's installed. */
export function visibleHarnesses(report: Report): ReportHarness[] {
  return report.harnesses.filter(
    (harness) => harness.detected || harness.instructions !== "none" || harness.skill !== "none" || harness.hooks !== "off" || harness.mcp !== "none"
  )
}

const SETTING_LABELS: Record<string, string> = {
  server: "Server",
  profile: "Profile",
  computer: "Computer name",
  account: "Account",
  project: "Project",
  topic: "Topic",
  source: "Source",
  updateCheck: "Update checks",
  stateDir: "State folder",
  configPath: "Config file location",
}

export type SettingRow = { key: string; label: string; value: string; from: string }

/** The Settings table: name, value, and where the value comes from. A name or path is never sent, so it reads "Set". */
export function settingRows(report: Report): SettingRow[] {
  return report.settings.map((setting) => ({
    key: setting.key,
    label: SETTING_LABELS[setting.key] ?? setting.key,
    value: setting.value ?? (setting.source === "default" ? "Default" : "Set"),
    from:
      setting.source === "env" ? (setting.env ? `Environment (${setting.env})` : "Environment")
      : setting.source === "config" ? "Config file"
      : setting.source === "detected" ? "Detected"
      : "Default",
  }))
}

/** One line for the last `relo doctor` on the machine, or null when it never ran. */
export function doctorLine(report: Report, relative: (iso: string) => string): string | null {
  if (!report.doctor) return null
  const when = relative(report.doctor.at)
  return report.doctor.ok
    ? `Last checked by relo doctor ${when}: all good`
    : `Last checked by relo doctor ${when}: ${report.doctor.failing.join(", ") || "something failed"}`
}
