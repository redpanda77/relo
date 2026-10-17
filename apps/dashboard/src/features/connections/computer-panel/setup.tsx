import { sourceLogo, toolLabel } from "@/components/atoms/source-logo"
import { SourceMark } from "@/components/atoms/source-mark"
import { StatusChip } from "@/components/atoms/status-chip"
import { CopyButton } from "@/components/molecules/copy-button"
import { agentsNotSetUp, doctorLine, setupPills, visibleHarnesses, type PillState } from "@/features/connections/computer-health"
import { NoReport, ReportAge } from "@/features/connections/computer-panel/report"
import { PanelBox } from "@/features/connections/computer-panel/shared"
import type { ConnectionComputer } from "@/features/connections/types"
import { relativeTime } from "@/lib/format"

const PILL_TONE: Record<PillState, "mint" | "yellow" | "neutral"> = { ok: "mint", outdated: "yellow", missing: "neutral" }

/** Per tool on this machine: whether Relo's instructions, skill, hooks and MCP are installed and current. */
export function Setup({ computer }: { computer: ConnectionComputer }) {
  const report = computer.report
  if (!report) return <NoReport />
  const harnesses = visibleHarnesses(report)
  const waiting = agentsNotSetUp(report)
  const doctor = doctorLine(report, relativeTime)
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span>CLI {report.cli.version}</span>
        {report.cli.update === "behind" && report.cli.latest ? (
          <span className="inline-flex flex-wrap items-center gap-2 text-muted-foreground">
            {report.cli.latest} available
            <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-xs">relo update</code>
            <CopyButton value="relo update" label="Copy command" size="xs" />
          </span>
        ) : report.cli.update === "current" ? (
          <span className="text-muted-foreground">Up to date</span>
        ) : null}
      </div>
      {harnesses.length ? (
        <PanelBox>
          <ul className="divide-y divide-[var(--divider)]" aria-label="Tools on this computer">
            {harnesses.map((harness) => (
              <li key={harness.id} className="grid gap-2 px-4 py-3">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {sourceLogo(harness.id) ? <SourceMark name={harness.id} size={16} /> : null}
                  <span aria-hidden={sourceLogo(harness.id) ? true : undefined}>{toolLabel(harness.id)}</span>
                  {!harness.detected ? <span className="text-xs font-normal text-muted-foreground">not found on this computer</span> : null}
                </p>
                <ul className="flex flex-wrap gap-1.5" aria-label={`${toolLabel(harness.id)} setup`}>
                  {setupPills(harness).map((pill) => (
                    <li key={pill.id}>
                      <StatusChip tone={PILL_TONE[pill.state]} variant="hairline" label={`${pill.label}: ${pill.detail}`}>
                        {pill.label} · {pill.detail}
                      </StatusChip>
                    </li>
                  ))}
                </ul>
                {waiting.includes(harness.id) ? (
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    Relo does not cover it yet. On this computer:
                    <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono">relo setup --agent {harness.id}</code>
                    <CopyButton value={`relo setup --agent ${harness.id}`} label="Copy command" size="xs" />
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </PanelBox>
      ) : (
        <p className="text-sm text-muted-foreground">No coding tool was found on this computer.</p>
      )}
      {doctor ? <p className="text-xs text-muted-foreground">{doctor}</p> : null}
      <ReportAge computer={computer} />
    </div>
  )
}
