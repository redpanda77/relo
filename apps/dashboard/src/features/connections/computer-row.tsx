import * as React from "react"

import { COMPUTER_ICON_META } from "@/components/atoms/computer-icon-meta"
import { sourceLogo, toolLabel } from "@/components/atoms/source-logo"
import { SourceMark } from "@/components/atoms/source-mark"
import { Badge } from "@/components/card"
import { seenDot } from "@/lib/machine-seen"
import { MachineCard, MachineChip } from "@/components/molecules/machine-card"
import { SheetTrigger } from "@/components/ui/sheet"
import { rowChips } from "@/features/connections/computer-health"
import type { ConnectionComputer } from "@/features/connections/types"
import { relativeTime } from "@/lib/format"

const MAX_TOOLS = 3

/** The tools that ran on a computer: logos for the ones Relo knows (the name stays for assistive technology), names for the rest. */
export function ToolMarks({ tools, max = MAX_TOOLS }: { tools: readonly string[]; max?: number }) {
  const shown = tools.slice(0, max)
  const more = tools.length - shown.length
  return (
    <>
      {shown.map((tool) => (
        <span key={tool} className="inline-flex items-center gap-1 align-middle" title={toolLabel(tool)}>
          {sourceLogo(tool) ? <SourceMark name={tool} size={14} /> : toolLabel(tool)}
        </span>
      ))}
      {more > 0 ? <span className="align-middle">+{more}</span> : null}
    </>
  )
}

/**
 * One computer as a machine card (board C3): its glyph with a status dot (mint when seen within ten minutes),
 * its name, "Last seen 4 min ago · 2 harnesses · 1 open card" and a chip per harness that ran there, with quiet
 * chips under it for what differs from the account (Badge) and for anything that needs a look. The head opens
 * the panel (`SheetTrigger`, so closing it hands focus back to the card).
 */
export function ComputerRow({ computer, children }: { computer: ConnectionComputer; children?: React.ReactNode }) {
  const summary = [
    computer.lastSeenAt ? `Last seen ${relativeTime(computer.lastSeenAt)}` : "Not used yet",
    computer.tools.length ? `${computer.tools.length} ${computer.tools.length === 1 ? "harness" : "harnesses"}` : null,
    computer.openCards > 0 ? `${computer.openCards} open ${computer.openCards === 1 ? "card" : "cards"}` : null,
  ]
    .filter(Boolean)
    .join(" \u00b7 ")
  const chips = rowChips(computer)
  const tools = computer.tools.slice(0, MAX_TOOLS)
  return (
    <MachineCard
      glyph={COMPUTER_ICON_META[computer.icon].glyph}
      name={computer.name}
      summary={summary}
      dot={seenDot(computer.lastSeenAt)}
      chips={tools.map((tool) => (
        <MachineChip key={tool}>
          {sourceLogo(tool) ? <SourceMark name={tool} size={10} /> : toolLabel(tool)}
        </MachineChip>
      ))}
      note={
        chips.length ? (
          <span className="flex flex-wrap items-center gap-1.5">
            {chips.map((chip) =>
              chip.kind === "override" ? (
                <Badge key={chip.id} tone="neutral" variant="hairline" icon={null} sentence>{chip.label}</Badge>
              ) : (
                <Badge key={chip.id} tone="yellow" variant="hairline" sentence>{chip.label}</Badge>
              )
            )}
          </span>
        ) : undefined
      }
      onClick={() => undefined}
      hit={(element) => <SheetTrigger asChild>{element}</SheetTrigger>}
    >
      {children}
    </MachineCard>
  )
}
