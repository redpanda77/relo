import * as React from "react"

import { COMPUTER_ICON_META } from "@/components/atoms/computer-icon-meta"
import { IconTile } from "@/components/atoms/icon-tile"
import { sourceLogo, toolLabel } from "@/components/atoms/source-logo"
import { SourceMark } from "@/components/atoms/source-mark"
import { Badge } from "@/components/card"
import { Row } from "@/components/list"
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
 * One computer in the list: its icon, its name, then who ran there, when it was last seen and how many cards are
 * open, with quiet chips for what differs from the account (Badge) and for anything that needs a look (a state
 * chip). The whole row opens the panel (`SheetTrigger`, so closing it hands focus back to the row).
 */
export function ComputerRow({ computer, children }: { computer: ConnectionComputer; children?: React.ReactNode }) {
  const meta: React.ReactNode[] = []
  if (computer.tools.length) {
    meta.push(
      <span key="tools" className="inline-flex items-center gap-2">
        <ToolMarks tools={computer.tools} />
      </span>
    )
  }
  meta.push(<span key="seen">{computer.lastSeenAt ? `seen ${relativeTime(computer.lastSeenAt)}` : "not used yet"}</span>)
  if (computer.openCards > 0) meta.push(<span key="cards">{computer.openCards} open {computer.openCards === 1 ? "card" : "cards"}</span>)
  const chips = rowChips(computer)
  return (
    <Row
      leading={<IconTile icon={COMPUTER_ICON_META[computer.icon].glyph} size="md" />}
      title={computer.name}
      meta={meta.map((part, index) => (
        <React.Fragment key={index}>
          {index > 0 ? <span aria-hidden="true"> · </span> : null}
          {part}
        </React.Fragment>
      ))}
      trailing={
        chips.length
          ? chips.map((chip) =>
              chip.kind === "override" ? (
                <Badge key={chip.id} tone="neutral" variant="hairline" icon={null}>{chip.label}</Badge>
              ) : (
                <Badge key={chip.id} tone="yellow" variant="hairline">{chip.label}</Badge>
              )
            )
          : undefined
      }
      wrap
      onClick={() => undefined}
      hit={(element) => <SheetTrigger asChild>{element}</SheetTrigger>}
    >
      {children}
    </Row>
  )
}
