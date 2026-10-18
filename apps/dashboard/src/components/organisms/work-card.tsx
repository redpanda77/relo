/**
 * WorkCard, WorkRow: a work (or a log line) on the card set (components/card/). Display only: every
 * word, tone and meter comes from the caller (the server's derived state, named by
 * lib/work-outcome.ts). iOS parity: ReloWorkCard.swift, HistoryRowView.swift, LogRow.
 *
 * ## API
 *
 * <WorkCard
 *   variant="live" | "row"           // live: framed glass card; row: the one compact row, inside a CardList
 *   tone={WorkTone}                   // meaning colour (lib/work-outcome.ts): meter, state word, tint; crossfades on change
 *   title="…"  encrypted={bool}       // encrypted: title becomes EncryptedText, summary is dropped
 *   origin={{ source, project, projectColor, topic, showSource }}   // "Claude Code · relo › Release review"
 *   eyebrow="QUESTION"                // mono eyebrow before the origin on the header line: needs-you cards only
 *   summary="…"  summaryLines={2|4}  // status in the producer's words (needs you: 4 lines)
 *   note="…"                          // a footnote under the status (what a late answer means)
 *   extra={node}                      // a Strip under the status: the answered-question strip
 *   meter={{ steps: {done,total,current}, progress, live, finished }}   // StepTrack docked on the bottom edge (live only)
 *   state={{ label, icon }}           // "Running", "Your turn", "Done" in the tone, 12px icon
 *   facts={[node, …]}                 // muted parts: "2 of 6 · Run migrations", "33m", "updated 3m ago"
 *   runningSince="ISO"                // "running 12:40", ticking (display only); else
 *   at="ISO"                          // a clock time ("12:40")
 *   computer="Studio Mac"             // its icon (computerIcon, laptop when unknown) + name
 *   glyph={node}                      // leading 28px glyph (hidden on a narrow card)
 *   tint  live                        // needs you washes the glass; moving work shimmers its state
 *   deadline="ISO"                    // the countdown, in the header's corner (needs you)
 *   actions={node}                    // buttons in the footer, beside the metadata, outside the open target
 *   onOpen={() => …}  openLabel="Open …"   // the card (minus the footer) opens the detail
 *   attrs  open  className
 * />
 *
 * Where a field goes (never a row of its own): eyebrow and origin share the header line; the
 * header's one corner is the countdown, else "running 12:40", else the clock time; the state, the
 * facts and the computer share the footer line with the buttons. When that is all one short field
 * and there are no buttons, it joins the header's corner and the footer is not drawn.
 *
 * <WorkRow glyph={{ icon, color, mark }} title="…" encrypted detail="Done · 33m" at="ISO" onOpen label arrived />
 *   The compact log row: the same row as WorkCard's row variant. Inside a CardList.
 */
import type { LucideIcon } from "lucide-react"
import * as React from "react"

import type { ComputerIcon as ComputerIconName } from "@relo/notification-contracts"

import { ComputerIcon } from "@/components/atoms/computer-icon"
import { EncryptedText } from "@/components/atoms/encrypted-text"
import { SignalGlyph } from "@/components/atoms/signal-glyph"
import { StepTrack } from "@/components/atoms/step-track"
import {
  Card,
  CardCorner,
  CardFooter,
  CardHeader,
  CardHit,
  CardLead,
  CardMain,
  CardMeta,
  CardNote,
  CardProgress,
  CardState,
  CardStatus,
  CardTitle,
  Countdown,
  Origin,
  RunningFor,
  type DataAttributes,
  type OriginParts,
} from "@/components/card"
import { type WorkTone } from "@/lib/work-outcome"

export type { WorkTone }
export type WorkOrigin = OriginParts

export type WorkMeter = {
  /** `currentIndex` (from 1) and `fill` (0...1) are the server's: which top-level step is current and how far it is. */
  steps?: { done: number; total: number; current?: string | null; currentIndex?: number | null; fill?: number | null } | null
  progress?: number | null
  /** Moving work: the sweep runs through the filled part. */
  live?: boolean
  /** Finished work fills every step. */
  finished?: boolean
}

export type WorkState = { label: string; icon?: LucideIcon | null }

export type WorkCardProps = {
  variant?: "live" | "row"
  tone: WorkTone
  title: string
  encrypted?: boolean
  origin?: WorkOrigin | null
  summary?: string | null
  summaryLines?: 2 | 4
  eyebrow?: string | null
  note?: string | null
  extra?: React.ReactNode
  meter?: WorkMeter | null
  state?: WorkState | null
  facts?: readonly React.ReactNode[]
  runningSince?: string | null
  at?: string | null
  computer?: string | null
  /** The computer's icon (laptop when unknown). */
  computerIcon?: ComputerIconName | null
  glyph?: React.ReactNode
  tint?: boolean
  live?: boolean
  deadline?: string | null
  actions?: React.ReactNode
  onOpen?: () => void
  openLabel?: string
  attrs?: DataAttributes
  open?: boolean
  className?: string
}

/** "12:40" in the owner's locale; empty for an invalid instant. */
function clockTime(value: string | null | undefined): string {
  if (!value) return ""
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return ""
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)
}

function ClockTime({ at }: { at: string }) {
  return <time className="tabular-nums" dateTime={at}>{clockTime(at)}</time>
}

/** The row's words: title and its time on the first line, an optional status, then metadata with the origin trailing. */
function RowText({
  title,
  encrypted,
  corner,
  status,
  meta,
  origin,
  extra,
}: {
  title: string
  encrypted: boolean
  corner?: React.ReactNode
  status?: string | null
  meta?: React.ReactNode
  origin?: React.ReactNode
  extra?: React.ReactNode
}) {
  return (
    <div className="card-row-text">
      <div className="card-row-top">
        {encrypted ? <EncryptedText className="card-row-title text-muted-foreground" /> : <h3 className="card-row-title">{title}</h3>}
        {corner}
      </div>
      {status ? <p className="card-row-status">{status}</p> : null}
      {meta || origin ? (
        <div className="card-row-sub">
          {meta}
          {origin}
        </div>
      ) : null}
      {extra}
    </div>
  )
}

/** The work card. See the API at the top of this file. */
export const WorkCard = React.memo(function WorkCard({
  variant = "live",
  tone,
  title,
  encrypted = false,
  origin,
  summary,
  summaryLines = 2,
  eyebrow,
  note,
  extra,
  meter,
  state,
  facts,
  runningSince,
  at,
  computer,
  computerIcon,
  glyph,
  tint = false,
  live = false,
  deadline,
  actions,
  onOpen,
  openLabel,
  attrs,
  open = false,
  className,
}: WorkCardProps) {
  const shownSummary = encrypted ? null : summary?.trim() || null
  const steps = meter?.steps && meter.steps.total > 0 ? meter.steps : null
  const label = openLabel ?? (encrypted ? "Open encrypted item" : `Open ${title}`)
  const originNode = origin ? <Origin {...origin} /> : null
  const time = runningSince ? <RunningFor since={runningSince} /> : at && clockTime(at) ? <ClockTime at={at} /> : null
  const computerNode = computer ? (
    <span className="card-computer" data-part="origin">
      <ComputerIcon icon={computerIcon ?? "laptop"} />
      {computer}
    </span>
  ) : null
  const stateNode = state ? <CardState label={state.label} icon={state.icon} /> : null
  const parts: React.ReactNode[] = [stateNode, ...(facts ?? []).filter((fact) => fact != null && fact !== ""), computerNode]

  if (variant === "row") {
    return (
      <Card variant="row" tone={tone} live={live} open={open} className={className}>
        <CardHit onOpen={onOpen} label={label} attrs={attrs} chevron>
          {glyph ? <CardLead>{glyph}</CardLead> : null}
          <RowText
            title={title}
            encrypted={encrypted}
            corner={time ? <CardCorner>{time}</CardCorner> : null}
            status={shownSummary}
            meta={<CardMeta parts={parts} />}
            origin={originNode}
            extra={extra}
          />
        </CardHit>
      </Card>
    )
  }

  // The header's one corner: the countdown, else the running time, else the clock time.
  const when = deadline ? <Countdown deadline={deadline} /> : time ? <CardCorner>{time}</CardCorner> : null
  let corner: React.ReactNode = when
  let footParts = parts.filter((part) => part != null && part !== false)
  // No buttons and one short field: it joins the corner, so the footer is not drawn.
  if (!actions && footParts.length <= 1 && (originNode || eyebrow)) {
    if (footParts.length === 1) {
      corner = (
        <>
          <CardCorner>{footParts[0]}</CardCorner>
          {when}
        </>
      )
    }
    footParts = []
  }
  const hasHeader = Boolean(eyebrow || originNode || corner)
  return (
    <Card variant="live" tone={tone} tint={tint} live={live} open={open} className={className}>
      <CardHit onOpen={onOpen} label={label} attrs={attrs}>
        {glyph ? <CardLead>{glyph}</CardLead> : null}
        <CardMain>
          {hasHeader ? <CardHeader eyebrow={eyebrow} origin={originNode} trailing={corner} /> : null}
          <CardTitle encrypted={encrypted}>{title}</CardTitle>
          {shownSummary ? <CardStatus lines={summaryLines}>{shownSummary}</CardStatus> : null}
          {extra}
          {note ? <CardNote>{note}</CardNote> : null}
        </CardMain>
      </CardHit>
      <CardFooter meta={footParts.length ? <CardMeta parts={footParts} /> : null} actions={actions} onOpenMeta={onOpen} />
      {meter && (steps || meter.progress != null) ? (
        <CardProgress>
          <StepTrack
            done={steps?.done}
            total={steps?.total}
            current={encrypted ? null : steps?.current}
            currentIndex={steps?.currentIndex}
            fill={steps?.fill}
            progress={steps ? null : meter.progress}
            live={meter.live}
            finished={meter.finished}
          />
        </CardProgress>
      ) : null}
    </Card>
  )
})

/** The compact log row. See the API at the top of this file. */
export function WorkRow({
  glyph,
  title,
  encrypted = false,
  detail,
  at,
  onOpen,
  label,
  arrived = false,
  open = false,
  attrs,
}: {
  glyph: { icon?: LucideIcon; color: string; mark?: string }
  title: string
  encrypted?: boolean
  detail?: React.ReactNode
  at?: string | null
  onOpen?: () => void
  label?: string
  /** It just arrived: its glyph pops and the row washes in its colour once. */
  arrived?: boolean
  open?: boolean
  attrs?: DataAttributes
}) {
  const style = { ["--tone" as string]: glyph.color } as React.CSSProperties
  return (
    <Card variant="row" open={open} style={style}>
      <CardHit
        onOpen={onOpen}
        label={label ?? (encrypted ? "Open encrypted item" : `Open ${title}`)}
        attrs={{ ...attrs, "data-arrived": arrived ? "true" : undefined }}
        chevron
      >
        <CardLead>
          <SignalGlyph {...glyph} />
        </CardLead>
        <RowText
          title={title}
          encrypted={encrypted}
          corner={at && clockTime(at) ? <CardCorner><ClockTime at={at} /></CardCorner> : null}
          meta={detail ? <CardMeta parts={[detail]} /> : null}
        />
      </CardHit>
    </Card>
  )
}
