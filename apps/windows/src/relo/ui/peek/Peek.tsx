// The expanded closed notch: the closed notch grown into a card for an update (ReloPeekPill and ReloExpandedCard,
// ReloClosedActivity.swift:404-621) or a notice line (ReloNoticePill). Driven by PeekController (./controller.ts); the
// host sizes the notch to the height this reports. The shapes follow the Mac: 440 wide, padding 18 / 6 / 14 (pill 12),
// the origin and the state's badge on top, the title in up to two lines, one line, then the answer or the plan bar, over
// the state's light rising from the bottom edge. Each piece arrives in turn.

import type { OwnerNotice } from "@relo/owner-client"
import { AnimatePresence, motion } from "motion/react"
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react"
import type { NotchEvent } from "../../events"
import type { AnswerPhase, OnAnswer, QuestionSpec } from "../../answers"
import { rowBar, type Row } from "../../presentation"
import { AnswerBar, Origin, PlanBarView, StateBadge } from "../Card"
import { Elapsed } from "../open/time"
import { readableName } from "../open/logic"
import { COLORS, toneLabel } from "../theme"
import { cardDetail, cardShowsBar, detailLines, isPill, liveRow, openKindColor, openKindOf, pillBadge, pillBar, pillLine, titleOf, type OpenKind } from "./logic"
import type { PeekSnapshot } from "./controller"
import "./peek.css"

const arrive = (delay: number): CSSProperties => ({ ["--d" as string]: `${delay}s` })

function Light({ kind }: { kind: OpenKind }) {
  return <div className="pk-light" data-kind={kind} aria-hidden />
}

function Badge({ kind, children }: { kind: OpenKind; children: ReactNode }) {
  return (
    <span className="pk-badge" data-kind={kind}>
      {children}
    </span>
  )
}

/** A start or a finish under the notch, a short card (ReloPeekPill). */
export function PeekPill({ event, row, reduceMotion = false }: { event: NotchEvent; row: Row; reduceMotion?: boolean }) {
  const kind = openKindOf(event, row)
  const line = pillLine(event, row)
  const bar = pillBar(kind, row)
  const color = kind === "done" ? COLORS.running : openKindColor(kind)
  return (
    <div className="pk" data-pill="" data-kind={kind} data-reduced={reduceMotion || undefined} data-testid="peek-pill">
      <Light kind={kind} />
      <div className="pk-top">
        <div className="pk-in" style={arrive(0.16)}>
          <Origin row={row} />
        </div>
        {/* A finish is said once: the word in mint and the bar sweeping full; no check on top of them. */}
        <Badge kind={kind}>
          <span style={{ fontSize: 10, fontWeight: 600, color: openKindColor(kind), whiteSpace: "nowrap" }}>{pillBadge(kind, toneLabel(row.tone))}</span>
        </Badge>
      </div>
      <div className="pk-title pk-in" style={arrive(0.22)}>{titleOf(row)}</div>
      {line && (
        <div className="pk-line pk-in" style={arrive(0.28)}>
          {line}
        </div>
      )}
      {bar && (
        <div className="pk-bar pk-in" data-kind={kind} style={{ ...arrive(0.32), paddingTop: 4 }}>
          <PlanBarView bar={bar} color={kind === "done" ? COLORS.done : color} />
        </div>
      )}
    </div>
  )
}

export interface ExpandedCardProps {
  event: NotchEvent
  row: Row
  questions: Record<string, QuestionSpec>
  answers: Record<string, AnswerPhase>
  onAnswer: OnAnswer
  offline: boolean
  reduceMotion?: boolean
}

/** The expanded notch for one update: the closed notch grown taller (ReloExpandedCard). */
export function ExpandedCard({ event, row, questions, answers, onAnswer, offline, reduceMotion = false }: ExpandedCardProps) {
  const kind = openKindOf(event, row)
  const spec = row.questionId ? questions[row.questionId] : undefined
  const detail = cardDetail(row, spec, toneLabel(row.tone))
  const bar = rowBar(row)
  const showsBar = cardShowsBar(kind, row)
  return (
    <div className="pk" data-kind={kind} data-reduced={reduceMotion || undefined} data-testid="peek-card">
      <Light kind={kind} />
      <div className="pk-top">
        <div className="pk-in" style={arrive(0.16)}>
          <Origin row={row} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {row.tone === "working" && !row.questionPending && (
            <span className="pk-meta pk-in" style={arrive(0.16)}>
              <Elapsed since={row.startedAt} />
            </span>
          )}
          {/* One shimmer per card: the bar's when it has one, else the running badge's. */}
          <Badge kind={kind}>
            <StateBadge row={row} label={row.questionMissed ? "Missed" : toneLabel(row.tone)} live={kind === "running" && !showsBar} />
          </Badge>
        </div>
      </div>
      <div className="pk-title pk-in" style={{ ...arrive(0.22), color: row.unreadable ? COLORS.secondaryText : "#fff" }}>{titleOf(row)}</div>
      <div className="pk-line pk-in" style={{ ...arrive(0.28), ["--lines" as string]: detailLines(kind, row) }}>
        {detail}
      </div>
      {row.questionPending && row.questionId ? (
        <div className="pk-floor pk-in" style={arrive(0.36)}>
          <AnswerBar interactionId={row.questionId} spec={spec} phase={answers[row.questionId]} offline={offline} onAnswer={onAnswer} />
        </div>
      ) : showsBar && bar ? (
        <div className="pk-in" style={{ ...arrive(0.36), paddingTop: 6, opacity: kind === "turn" ? 0.6 : undefined }}>
          <PlanBarView bar={bar} color={openKindColor(kind)} />
        </div>
      ) : null}
    </div>
  )
}

/** A plain notice under the notch (`relo notify`): where it came from, its title and its first line (ReloNoticePill). */
export function NoticePill({ notice, reduceMotion = false }: { notice: OwnerNotice; reduceMotion?: boolean }) {
  return (
    <div className="pk" data-pill="" data-kind="started" data-reduced={reduceMotion || undefined} data-testid="peek-notice">
      <Light kind="started" />
      <div className="pk-top">
        <span className="pk-source pk-in" style={arrive(0.16)}>{readableName(notice.source) ?? "Relo"}</span>
        <Badge kind="started">
          <span style={{ fontSize: 10, fontWeight: 600, color: COLORS.running, whiteSpace: "nowrap" }}>Notice</span>
        </Badge>
      </div>
      <div className="pk-title pk-in" style={arrive(0.22)}>{readableName(notice.title) ?? notice.title}</div>
      {notice.summary && (
        <div className="pk-line pk-in" style={arrive(0.28)}>
          {notice.summary}
        </div>
      )}
    </div>
  )
}

export interface PeekHostProps {
  snapshot: PeekSnapshot
  /** The rows of the live summary, to show the work as it is now. */
  rows: Row[]
  questions: Record<string, QuestionSpec>
  answers: Record<string, AnswerPhase>
  onAnswer: OnAnswer
  offline: boolean
  reduceMotion?: boolean
  /** The height the content needs (0 when nothing shows), so the notch can grow to it. */
  onHeight: (height: number) => void
}

/** Renders whichever of the card, the pill or the notice is up, and reports its height. */
export function PeekHost({ snapshot, rows, questions, answers, onAnswer, offline, reduceMotion = false, onHeight }: PeekHostProps) {
  const box = useRef<HTMLDivElement>(null)
  const { expanded, notice } = snapshot
  const showing = expanded !== null || notice !== null

  useLayoutEffect(() => {
    const el = box.current
    if (!showing || !el) {
      onHeight(0)
      return
    }
    const measure = () => onHeight(Math.ceil(el.offsetHeight))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [showing, expanded?.openedAt, notice?.openedAt, onHeight])

  const content = expanded ? (
    isPill(expanded.event) ? (
      <PeekPill key={`e${expanded.openedAt}`} event={expanded.event} row={liveRow(expanded.event.row, rows)} reduceMotion={reduceMotion} />
    ) : (
      <ExpandedCard key={`e${expanded.openedAt}`} event={expanded.event} row={liveRow(expanded.event.row, rows)} questions={questions} answers={answers} onAnswer={onAnswer} offline={offline} reduceMotion={reduceMotion} />
    )
  ) : notice ? (
    <NoticePill key={`n${notice.openedAt}`} notice={notice.notice} reduceMotion={reduceMotion} />
  ) : null

  return (
    <div ref={box} style={{ width: 440, pointerEvents: showing ? "auto" : "none" }}>
      <AnimatePresence initial={false}>
        {content && (
          // Leaving, it all fades at once and lifts 4 px (`.opacity.combined(with: .offset(y: -4))` on easeOut 0.14).
          <motion.div key={content.key} exit={{ opacity: 0, y: -4, transition: { duration: 0.14, ease: "easeOut" } }}>
            {content}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
