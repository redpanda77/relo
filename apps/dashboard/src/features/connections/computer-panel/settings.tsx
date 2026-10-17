import { NoReport, ReportAge } from "@/features/connections/computer-panel/report"
import { PanelBox } from "@/features/connections/computer-panel/shared"
import { settingRows } from "@/features/connections/computer-health"
import type { ConnectionComputer } from "@/features/connections/types"

/** Each setting's effective value and where it comes from. A name or a path is never sent, so it reads "Set". */
export function Settings({ computer }: { computer: ConnectionComputer }) {
  const report = computer.report
  if (!report) return <NoReport />
  const rows = settingRows(report)
  return (
    <div className="grid gap-4">
      <PanelBox className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Settings on this computer</caption>
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b border-[var(--divider)]">
              <th scope="col" className="px-4 py-2 font-medium">Setting</th>
              <th scope="col" className="px-2 py-2 font-medium">Value</th>
              <th scope="col" className="px-4 py-2 font-medium">From</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--divider)]">
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" className="px-4 py-2.5 align-top font-medium">{row.label}</th>
                <td className="px-2 py-2.5 align-top text-muted-foreground">{row.value}</td>
                <td className="px-4 py-2.5 align-top break-words text-muted-foreground">{row.from}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </PanelBox>
      <p className="text-xs text-muted-foreground">
        Shown as this computer reports it; <code className="font-mono">relo config</code> prints the same table on the computer. Names and paths
        are never sent here.
      </p>
      <ReportAge computer={computer} />
    </div>
  )
}
