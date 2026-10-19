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
 *   meter={{ steps: {done,total,current}, progress, live, finished }}   // StepTrack in the progress row, with the step caption
 *   state={{ label, icon }}           // "Running", "Your turn", "Done" in the tone, 12px icon: the header's trailing badge
 *   facts={[node, …]}                 // muted parts: "33m", "updated 3m ago"
 *   runningSince="ISO"                // footer trailing: "running 12:40", ticking (display only); else
 *   at="ISO"                          // footer trailing: a clock time ("12:40")
 *   computer="Studio Mac"             // its icon (computerIcon, laptop when unknown) + name
 *   glyph={node}                      // leading 28px glyph (hidden on a narrow card)
 *   tint  live                        // needs you washes the glass; moving work shimmers its state
 *   deadline="ISO"                    // the countdown, in the header's trailing slot (replaces the state badge)
 *   actions={node}                    // buttons in the footer, trailing, outside the open target
 *   onOpen={() => …}  openLabel="Open …"   // the card (minus the footer) opens the detail
 *   attrs  open  className
 * />
 *
 * ## The standard: Header / Content / Footer, a plain top-to-bottom stack
 *
 *   HEADER  one small line. Leading: eyebrow (needs-you only) + origin. Trailing: ONE thing, the
 *           countdown (a pending question) else the state badge. Never the clock, never the computer.
 *   CONTENT title, status, the progress bar across the full width with the step line under it, then
 *           extra and note.
 *   FOOTER  one small line, omitted when empty. Leading: facts and the computer joined by " · "
 *           (they truncate). Trailing: the actions, else the running timer or the clock time.
 *
 * No side columns, no measuring, no field moves between slots, the same layout at every width (a
 * wider card has longer lines; only the buttons drop under the facts on a narrow card).
 *
 * The row variant keeps the same slots, compact: header = origin + state, content = title (+ status),
 * footer = facts + time.
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
  CardProgressRow,
  CardState,
  CardStatus,
  CardTitle,
  Countdown,
  Origin,
  RunningFor,
  type DataAttributes,
  type OriginParts,
} from "@/components/card"
import { stepsCaption, type WorkTone } from "@/lib/work-outcome"

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
  /** The progress row's words; defaults to the steps caption ("Step 3 of 5 · Run local gates"). */
  caption?: string | null
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

/** The row's words, same slots as the card: header (origin, state), title and status, footer (facts, time). */
function RowText({
  title,
  encrypted,
  origin,
  trailing,
  status,
  meta,
  time,
  extra,
}: {
  title: string
  encrypted: boolean
  origin?: React.ReactNode
  trailing?: React.ReactNode
  status?: string | null
  meta?: React.ReactNode
  time?: React.ReactNode
  extra?: React.ReactNode
}) {
  return (
    <div className="card-row-text">
      {origin || trailing ? (
        <div className="card-row-top">
          {origin}
          {trailing}
        </div>
      ) : null}
      {encrypted ? <EncryptedText className="card-row-title text-muted-foreground" /> : <h3 className="card-row-title">{title}</h3>}
      {status ? <p className="card-row-status">{status}</p> : null}
      {extra}
      {meta || time ? (
        <div className="card-row-sub">
          {meta}
          {time ? <span className="card-row-time">{time}</span> : null}
        </div>
      ) : null}
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
  const caption = meter ? (meter.caption ?? stepsCaption(steps, { finished: meter.finished })) : null
  const facing = (facts ?? []).filter((fact) => fact != null && fact !== "")
  const parts: React.ReactNode[] = [...(variant === "row" ? [caption] : []), ...facing, computerNode]
  const meta = parts.some((part) => part != null && part !== "") ? <CardMeta parts={parts} /> : null
  // The header's one trailing thing: the countdown, else the state badge.
  const trailing = deadline ? <Countdown deadline={deadline} /> : stateNode ? <CardCorner>{stateNode}</CardCorner> : null

  if (variant === "row") {
    return (
      <Card variant="row" tone={tone} live={live} open={open} className={className}>
        <CardHit onOpen={onOpen} label={label} attrs={attrs} chevron>
          {glyph ? <CardLead>{glyph}</CardLead> : null}
          <RowText
            title={title}
            encrypted={encrypted}
            origin={originNode}
            trailing={trailing}
            status={shownSummary}
            extra={extra}
            meta={meta}
            time={time}
          />
        </CardHit>
      </Card>
    )
  }

  const hasHeader = Boolean(eyebrow || originNode || trailing)
  const progressRow = meter && (steps || meter.progress != null) ? (
    <CardProgressRow caption={caption}>
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
    </CardProgressRow>
  ) : null
  return (
    <Card variant="live" tone={tone} tint={tint} live={live} open={open} className={className}>
      <CardHit onOpen={onOpen} label={label} attrs={attrs}>
        {glyph ? <CardLead>{glyph}</CardLead> : null}
        <CardMain>
          {hasHeader ? <CardHeader eyebrow={eyebrow} origin={originNode} trailing={trailing} /> : null}
          <CardTitle encrypted={encrypted}>{title}</CardTitle>
          {shownSummary ? <CardStatus lines={summaryLines}>{shownSummary}</CardStatus> : null}
          {progressRow}
          {extra}
          {note ? <CardNote>{note}</CardNote> : null}
        </CardMain>
      </CardHit>
      <CardFooter meta={meta} actions={actions} time={time} onOpenMeta={onOpen} />
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
          meta={detail ? <CardMeta parts={[detail]} /> : null}
          time={at && clockTime(at) ? <ClockTime at={at} /> : null}
        />
      </CardHit>
    </Card>
  )
}
