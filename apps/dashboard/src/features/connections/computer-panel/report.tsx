import { Terminal } from "lucide-react"

import { Notice } from "@/components/molecules/notice"
import { CopyButton } from "@/components/molecules/copy-button"
import { isReportStale } from "@/features/connections/computer-health"
import type { ConnectionComputer } from "@/features/connections/types"
import { relativeTime } from "@/lib/format"

/** Shown in Setup and Settings until this computer's CLI sends a report (an older CLI never does). */
export function NoReport() {
  return (
    <Notice variant="quiet" tone="neutral" icon={<Terminal />} action={<CopyButton value="relo update" label="Copy command" size="sm" />}>
      Update the CLI on this computer to see its setup here. Run <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-xs">relo update</code> on it.
    </Notice>
  )
}

/** "Reported 5 min ago", and a notice when the report is older than a week. */
export function ReportAge({ computer }: { computer: ConnectionComputer }) {
  if (!computer.reportedAt) return null
  return (
    <div className="grid gap-2">
      <p className="text-xs text-muted-foreground">Reported {relativeTime(computer.reportedAt)}</p>
      {isReportStale(computer.reportedAt) ? (
        <Notice tone="yellow" variant="quiet" role="status">
          This computer has not reported in over a week, so what you see may be out of date. Run relo doctor on it to refresh.
        </Notice>
      ) : null}
    </div>
  )
}
