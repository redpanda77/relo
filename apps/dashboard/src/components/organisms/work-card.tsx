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
 *   eyebrow="QUESTION"                // mono eyebrow before the origin on the header line (plain list cards)
 *   asked                             // a question: orange wash, answers in the content, "ASKED 6:42 PM" in the footer
 *   answers={node}                    // the answer buttons: a two-column grid under the status (.card-answers)
 *   caption="Step 3 of 3 · Deploy"    // the footer's left on a live card (defaults to the meter's)
 *   summary="…"  summaryLines={2|4}  // status in the producer's words (needs you: 4 lines)
 *   note="…"                          // a footnote under the status (what a late answer means)
 *   extra={node}                      // a Strip under the status: the answered-question strip
 *   meter={{ steps: {done,total,current}, progress, live, finished }}   // StepTrack in the progress row, with the step caption
 *   state={{ label, icon, dot, quietSince }}   // the header's trailing chip: "NEEDS YOU · 4:12", "YOUR TURN", "RUNNING", "QUIET 14 MIN", "DONE"
 *   facts={[node, …]}                 // muted parts: "33m", "updated 3m ago"
 *   runningSince="ISO"                // footer trailing: the elapsed timer in the tone, ticking (display only); else
 *   at="ISO"                          // footer trailing: a clock time ("12:40")
 *   computer="Studio Mac"             // its icon (computerIcon, laptop when unknown) + name
 *   glyph={node}                      // leading 28px glyph (hidden on a narrow card)
 *   tint  live                        // needs you washes the glass; moving work shimmers its state
 *   deadline="ISO"                    // the countdown, inside the state chip ("NEEDS YOU · 4:12")
 *   actions={node}                    // buttons in the footer, trailing, outside the open target
 *   end={node}                        // the owner's small End at the footer's end, beside the time (Now's quiet, paused and your-turn work)
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
import { Badge, type BadgeTone } from "@/components/card/badge"
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
  CountdownText,
  Origin,
  QuietFor,
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

export type WorkState = {
  label: string
  icon?: LucideIcon | null
  /** The chip leads with the meaning dot instead of its icon (needs you, running, quiet work). */
  dot?: boolean
  /** Quiet work: the chip counts the minutes since this instant ("QUIET 14 MIN"). */
  quietSince?: string | null
}

/** A work tone as the chip's palette tone. */
function chipTone(tone: WorkTone): BadgeTone {
  return tone === "cyanQuiet" ? "cyan" : tone === "neutral" ? "slate" : tone
}

export type WorkCardProps = {
  variant?: "live" | "row"
  tone: WorkTone
  title: string
  encrypted?: boolean
  origin?: WorkOrigin | null
  summary?: string | null
  summaryLines?: 2 | 4
  /** The step caption for the footer's left ("Step 3 of 3 · Deploy"); defaults to the meter's. */
  caption?: string | null
  /** A question or permission: the orange card with its breathing wash, the answers in the content, "ASKED 6:42 PM" in the footer. */
  asked?: boolean
  /** The answer buttons (two-column grid under the status). */
  answers?: React.ReactNode
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
  end?: React.ReactNode
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
  caption: givenCaption,
  asked = false,
  answers,
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
  end,
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
  const time = runningSince ? <RunningFor since={runningSince} prefix="running " /> : at && clockTime(at) ? <ClockTime at={at} /> : null
  const computerNode = computer ? (
    <span className="card-computer" data-part="origin">
      <ComputerIcon icon={computerIcon ?? "laptop"} />
      {computer}
    </span>
  ) : null
  const stateNode = state ? <CardState label={state.label} icon={state.icon} /> : null
  const caption = givenCaption !== undefined ? givenCaption : meter ? (meter.caption ?? stepsCaption(steps, { finished: meter.finished })) : null
  const facing = (facts ?? []).filter((fact) => fact != null && fact !== "")
  const parts: React.ReactNode[] = [...(variant === "row" ? [caption] : []), ...facing, computerNode]
  const meta = parts.some((part) => part != null && part !== "") ? <CardMeta parts={parts} /> : null
  // The row's one trailing thing: the countdown, else the state badge.
  const trailing = deadline ? <Countdown deadline={deadline} /> : stateNode ? <CardCorner>{stateNode}</CardCorner> : null

  // The live card's header chip: the state as a mono chip (needs you with its countdown, your turn with a
  // return arrow, running with the glowing dot and the sweep, quiet with a moon, done and failed with their marks).
  const StateIcon = state?.icon
  const chip = state ? (
    <Badge
      tone={chipTone(tone)}
      part="state"
      icon={state.dot ? undefined : StateIcon ? <StateIcon aria-hidden="true" /> : null}
      dot={state.dot && tone === "orange"}
      live={live && tone === "cyan"}
      value={state.quietSince ? "quiet" : state.label}
    >
      {state.quietSince ? <QuietFor since={state.quietSince} /> : state.label}
      {deadline ? (
        <>
          {" · "}
          <CountdownText deadline={deadline} />
        </>
      ) : null}
    </Badge>
  ) : deadline ? (
    <Countdown deadline={deadline} />
  ) : null

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

  const header = chip ?? null
  const hasHeader = Boolean(eyebrow || originNode || header)
  const progressRow = meter && (steps || meter.progress != null) ? (
    <CardProgressRow>
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
  // The footer: a question has the computer on the left and "ASKED 6:42 PM" on the right; other work has the
  // step caption (and facts) on the left, the computer and the time (the elapsed timer in the tone while running) on the right.
  const clock = asked && at && clockTime(at) ? <time className="card-time" dateTime={at}>{`Asked ${clockTime(at)}`}</time> : null
  const stamp = asked ? clock : runningSince ? <RunningFor since={runningSince} className="card-time" /> : at && clockTime(at) ? <time className="card-time" dateTime={at}>{clockTime(at)}</time> : null
  const leftParts = asked ? [computerNode, ...facing] : [caption, ...facing]
  const left = leftParts.some((part) => part != null && part !== "") ? <CardMeta parts={leftParts} /> : null
  const trail = asked ? stamp : computerNode || stamp ? (
    <>
      {computerNode}
      {computerNode && stamp ? <span className="card-sep" aria-hidden="true"> · </span> : null}
      {stamp}
    </>
  ) : null
  return (
    <Card variant="live" tone={tone} tint={tint} live={live} wash={asked && tint} open={open} className={className} data-asked={asked || undefined}>
      <CardHit onOpen={onOpen} label={label} attrs={attrs}>
        {glyph ? <CardLead>{glyph}</CardLead> : null}
        <CardMain>
          {hasHeader ? <CardHeader eyebrow={eyebrow} origin={originNode} trailing={header} /> : null}
          <CardTitle encrypted={encrypted}>{title}</CardTitle>
          {shownSummary ? <CardStatus lines={summaryLines}>{shownSummary}</CardStatus> : null}
          {progressRow}
          {extra}
          {note ? <CardNote>{note}</CardNote> : null}
        </CardMain>
      </CardHit>
      {answers ? <div className="card-answers-slot">{answers}</div> : null}
      <CardFooter meta={left} actions={actions} trail={trail} end={end} onOpenMeta={onOpen} />
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
