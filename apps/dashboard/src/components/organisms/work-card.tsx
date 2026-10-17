/**
 * WorkCard, WorkList, WorkRow: the one work card for Now and History (iOS ReloWorkCard.swift,
 * HistoryRowView.swift, CurrentAttentionView.swift LogRow). Display only: every word, tone and
 * meter comes from the caller (the server's derived state, named by lib/work-outcome.ts).
 *
 * ## API (stable; History and Now both build on it)
 *
 * <WorkCard
 *   variant="live" | "row"           // live: framed glass card (padding 16, radius 20); row: unframed, inside a WorkList
 *   tone={WorkTone}                   // meaning colour (lib/work-outcome.ts): meter, state word, tint; crossfades on change
 *   title="…"  encrypted={bool}       // encrypted: title becomes EncryptedText, summary is dropped
 *   origin={{ source, project, projectColor, topic, showSource }}   // "Claude Code · relo › Release review"
 *   summary="…"  summaryLines={2|4}  // status in the producer's words (needs you: 4 lines)
 *   chip="MISSED 18:40"               // mono chip above the title: needs-you cards only
 *   extra={node}                      // under the summary: answered-question strip, answer controls
 *   meter={{ steps: {done,total,current}, progress, live, finished }}   // StepTrack; omit for none
 *   state={{ label, icon }}           // "Running", "Your turn", "Done" in the tone, 12px icon
 *   facts={[node, …]}                 // muted parts: "2 of 6 · Run migrations", "33m", "updated 3m ago"
 *   runningSince="ISO"                // "running 12:40", ticking (display only); else
 *   at="ISO"                          // a clock time ("12:40")
 *   computer="Studio Mac"             // its icon (computerIcon, laptop when unknown) + name, last on the line
 *   glyph={node}                      // leading 40px glyph (needs you), gap 14
 *   tint                              // the tone washes the glass: needs you only
 *   live                              // a highlight travels the top hairline (moving work)
 *   deadline="ISO"                    // countdown under the card (needs you)
 *   actions={node}                    // buttons under the card, outside the open target
 *   onOpen={() => …}  openLabel="Open …"   // the card (minus actions) opens the detail
 *   attrs={{ "data-owner-state": … }} // data-* on the open target (tests, styling)
 *   open                              // ringed while its detail sheet is open
 *   className
 * />
 *
 * <WorkList label="Quiet" items={…} getKey={…} layoutId={…} …PresenceList props>
 *   {(item, state) => <WorkCard variant="row" … />}
 * </WorkList>
 *   One glass container (radius 20), 1px white 6% dividers inset 16px on the left; items arrive,
 *   leave and travel (PresenceList). `children` as nodes instead of a function renders a static
 *   list of <li>s (wrap each in <WorkListItem>). Never put a live card in a list.
 *
 * <WorkRow glyph={{ icon, color, mark }} title="…" encrypted detail="Done · 33m" at="ISO"
 *          onOpen={…} label="Open …" arrived />
 *   The compact log row (iOS LogRow): 28px glyph at 14%, padding 10px 12px, min-height 52, one-line
 *   title, a detail line, the time trailing. Inside a WorkList.
 */
import { ChevronRight, Timer } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import * as React from "react"

import type { ComputerIcon as ComputerIconName } from "@relo/notification-contracts"

import { ComputerIcon } from "@/components/atoms/computer-icon"
import { EncryptedText } from "@/components/atoms/encrypted-text"
import { SignalGlyph } from "@/components/atoms/signal-glyph"
import { StepTrack } from "@/components/atoms/step-track"
import { PresenceList, type PresenceItemState } from "@/components/molecules/presence-list"
import { useTicker } from "@/lib/ticker"
import { cn } from "@/lib/utils"
import { SourceMark } from "@/components/atoms/source-mark"
import { toneClass, type WorkTone } from "@/lib/work-outcome"

export type { WorkTone }

export type WorkOrigin = {
  source?: string | null
  project?: string | null
  /** The project's palette colour (lib/project-palette.ts). */
  projectColor?: string | null
  /** The session or thread name; shrinks first. */
  topic?: string | null
  /** False when a filter already pins the source (shown anyway when there is no project). */
  showSource?: boolean
}

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

type DataAttributes = Record<`data-${string}`, string | undefined>

export type WorkCardProps = {
  variant?: "live" | "row"
  tone: WorkTone
  title: string
  encrypted?: boolean
  origin?: WorkOrigin | null
  summary?: string | null
  summaryLines?: 2 | 4
  chip?: string | null
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

const two = (value: number) => String(value).padStart(2, "0")

/** 754 -> "12:34", 4_330 -> "1:12:10". */
function clockOf(totalSeconds: number) {
  const total = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return hours > 0 ? `${hours}:${two(minutes)}:${two(total % 60)}` : `${two(minutes)}:${two(total % 60)}`
}

/** "12:40" in the owner's locale; empty for an invalid instant. */
function clockTime(value: string | null | undefined): string {
  if (!value) return ""
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return ""
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)
}

/** "running 12:40", ticking on the page's one clock (a leaf: only these words re-render). Display only. */
function RunningFor({ since }: { since: string }) {
  const now = useTicker(true)
  const started = new Date(since).valueOf()
  if (!Number.isFinite(started)) return null
  return <time className="tabular-nums" dateTime={since}>{`running ${clockOf(((now || started) - started) / 1000)}`}</time>
}

/** "Expires in 4:32" under a needs-you card; "Expired" once past. Display only. */
function Countdown({ deadline }: { deadline: string }) {
  const now = useTicker(true)
  const end = new Date(deadline).valueOf()
  if (!Number.isFinite(end)) return null
  const left = (end - (now || end)) / 1000
  return (
    <p className="work-countdown">
      <Timer aria-hidden="true" />
      <time className="tabular-nums" dateTime={deadline}>{left > 0 ? `Expires in ${clockOf(left)}` : "Expired"}</time>
    </p>
  )
}

/** source · project › topic on one line: the topic shrinks first, then the project. */
function OriginRow({ origin }: { origin: WorkOrigin }) {
  const project = origin.project?.trim() || null
  const source = origin.source?.trim() || null
  const showsSource = Boolean(source) && (origin.showSource !== false || !project)
  const topic = origin.topic?.trim() || null
  if (!showsSource && !project && !topic) return null
  const spoken = [showsSource ? source : null, project, topic].filter(Boolean).join(", ")
  return (
    <p className="work-origin" aria-label={spoken}>
      {showsSource ? <span className="work-origin-source" data-part="source">{source ? <SourceMark name={source} /> : null}</span> : null}
      {project ? (
        <>
          {showsSource ? <span className="work-sep" aria-hidden="true">·</span> : null}
          <span className="work-origin-project" data-part="project" style={origin.projectColor ? { color: origin.projectColor } : undefined}>
            {project}
          </span>
        </>
      ) : null}
      {topic ? (
        <>
          {showsSource || project ? <span className="work-sep" aria-hidden="true">›</span> : null}
          <span className="work-origin-topic" data-part="topic">{topic}</span>
        </>
      ) : null}
    </p>
  )
}

/** "Running · 2 of 6 · Run migrations · running 12:40 · Studio Mac": one wrapping line. */
function Standing({
  state,
  facts,
  runningSince,
  at,
  computer,
  computerIcon,
}: Pick<WorkCardProps, "state" | "facts" | "runningSince" | "at" | "computer" | "computerIcon">) {
  const parts: React.ReactNode[] = []
  if (state) {
    const Icon = state.icon
    parts.push(
      <span key="state" className="work-state" data-part="state">
        {Icon ? <Icon aria-hidden="true" /> : null}
        <span className="work-state-label">{state.label}</span>
      </span>
    )
  }
  facts?.forEach((fact, index) => {
    if (fact != null && fact !== "") parts.push(<span key={`fact-${index}`}>{fact}</span>)
  })
  if (runningSince) parts.push(<RunningFor key="running" since={runningSince} />)
  else if (at && clockTime(at)) {
    parts.push(
      <time key="at" className="tabular-nums" dateTime={at}>
        {clockTime(at)}
      </time>
    )
  }
  if (computer) {
    parts.push(
      <span key="computer" className="work-computer" data-part="origin">
        <ComputerIcon icon={computerIcon ?? "laptop"} />
        {computer}
      </span>
    )
  }
  if (!parts.length) return null
  return (
    <p className="work-standing">
      {parts.map((part, index) => (
        <React.Fragment key={index}>
          {index > 0 ? <span className="work-sep" aria-hidden="true"> · </span> : null}
          {part}
        </React.Fragment>
      ))}
    </p>
  )
}

function openOnKey(event: React.KeyboardEvent, open: () => void) {
  if (event.target !== event.currentTarget) return
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault()
    open()
  }
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
  chip,
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
  const body = (
    <div className="work-card-body">
      {/* The chip and where it runs share one line, so a needs-you card stays compact. */}
      {chip && origin ? (
        <div className="work-head">
          <p className="work-chip">{chip}</p>
          <span className="work-sep" aria-hidden="true">·</span>
          <OriginRow origin={origin} />
        </div>
      ) : (
        <>
          {chip ? <p className="work-chip">{chip}</p> : null}
          {origin ? <OriginRow origin={origin} /> : null}
        </>
      )}
      {encrypted ? (
        <EncryptedText className="work-title-encrypted" />
      ) : (
        <h3 className="work-title">{title}</h3>
      )}
      {shownSummary ? (
        <p className="work-summary" data-lines={summaryLines}>
          {shownSummary}
        </p>
      ) : null}
      {extra}
      {meter && (steps || meter.progress != null) ? (
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
      ) : null}
      <Standing state={state} facts={facts} runningSince={runningSince} at={at} computer={computer} computerIcon={computerIcon} />
    </div>
  )
  const content = glyph ? (
    <div className="work-card-lead">
      {glyph}
      {body}
    </div>
  ) : (
    body
  )
  return (
    <div
      className={cn("work-card tint", toneClass(tone), variant === "live" && "glass", className)}
      data-variant={variant}
      data-tint={tint || undefined}
      data-live={live || undefined}
      data-open={open || undefined}
    >
      {onOpen ? (
        <div
          role="button"
          tabIndex={0}
          className="work-card-hit"
          onClick={onOpen}
          onKeyDown={(event) => openOnKey(event, onOpen)}
          aria-label={openLabel ?? (encrypted ? "Open encrypted item" : `Open ${title}`)}
          {...attrs}
        >
          {content}
          {variant === "row" ? <ChevronRight className="work-chevron" aria-hidden="true" /> : null}
        </div>
      ) : (
        <div className="work-card-hit" {...attrs}>
          {content}
        </div>
      )}
      {deadline || actions ? (
        <div className="work-card-foot">
          {deadline ? <Countdown deadline={deadline} /> : null}
          {actions ? <div className="work-actions">{actions}</div> : null}
        </div>
      ) : null}
    </div>
  )
})

const LIST_CLASS = "work-list glass"

/** A static list item for `<WorkList>` with node children. */
export function WorkListItem(props: React.ComponentProps<"li">) {
  return <li {...props} />
}

/**
 * One glass list of work rows: dividers inset 16px, never a card inside a card. With `items` it is
 * a PresenceList (rows arrive, leave and travel); with node children, a static <ul>.
 */
export function WorkList<T>(
  props:
    | {
        label: string
        className?: string
        items?: undefined
        children: React.ReactNode
      }
    | {
        label: string
        className?: string
        items: readonly T[]
        getKey: (item: T) => string
        layoutId?: (item: T) => string | undefined
        itemAttributes?: (item: T) => DataAttributes
        animateFirst?: boolean
        enterDelay?: number
        exitFor?: React.ComponentProps<typeof PresenceList<T>>["exitFor"]
        children: (item: T, state: PresenceItemState) => React.ReactNode
      }
) {
  if (props.items === undefined) {
    return (
      <ul aria-label={props.label} className={cn(LIST_CLASS, props.className)}>
        {props.children}
      </ul>
    )
  }
  const { label, className, items, getKey, layoutId, itemAttributes, animateFirst, enterDelay, exitFor, children } = props
  return (
    <PresenceList
      label={label}
      items={items}
      getKey={getKey}
      layoutId={layoutId}
      itemAttributes={itemAttributes}
      animateFirst={animateFirst}
      enterDelay={enterDelay}
      exitFor={exitFor}
      className={cn(LIST_CLASS, className)}
    >
      {children}
    </PresenceList>
  )
}

/** The compact log row (iOS LogRow). See the API at the top of this file. */
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
  const inner = (
    <>
      <SignalGlyph {...glyph} />
      <span className="work-row-text">
        {encrypted ? (
          <EncryptedText className="work-row-title text-muted-foreground" />
        ) : (
          <span className="work-row-title">{title}</span>
        )}
        {detail ? <span className="work-row-detail">{detail}</span> : null}
      </span>
      {at && clockTime(at) ? (
        <time className="work-row-time" dateTime={at}>
          {clockTime(at)}
        </time>
      ) : null}
      {onOpen ? <ChevronRight className="work-chevron" aria-hidden="true" /> : null}
    </>
  )
  const style = { ["--tone" as string]: glyph.color } as React.CSSProperties
  return onOpen ? (
    <button
      type="button"
      className="work-row"
      onClick={onOpen}
      aria-label={label ?? (encrypted ? "Open encrypted item" : `Open ${title}`)}
      style={style}
      data-arrived={arrived || undefined}
      data-open={open || undefined}
      {...attrs}
    >
      {inner}
    </button>
  ) : (
    <div className="work-row" style={style} {...attrs}>
      {inner}
    </div>
  )
}
