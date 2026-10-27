// The open notch's Relo tab (ReloNotchView.swift ReloWorkList / ReloQuietLine / ReloSummaryBar / ReloAllClear and
// ReloCards.swift ReloCardGroup / ReloMachineRow): the one-line summary on top, then every card full width in the
// server's order. Live cards (needs you, your turn, running) are one keyed run, so a card that changes state slides to
// its new place; finished work is compact rows; quiet and paused work stays folded under one line; the computers at
// work close the list. A click opens a card in place. It reports the height it needs (`onFit`) so the notch opens to
// fit, and scrolls past the tallest it opens.

import { AnimatePresence, motion } from "motion/react"
import { useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react"
import type { AnswerPhase, OnAnswer, QuestionSpec } from "../answers"
import { isEmpty, machinesOf, tallyOf, type Machine, type Presentation, type Row, type Section, type TallyEntry } from "../presentation"
import { SUMMARY_H } from "../../geometry"
import { CompactRow, SourceMark, WorkCard, type CardVoice } from "./Card"
import { Check, Chevron, ComputerIcon, Lock, OfflineIcon, ToneIcon } from "./icons"
import { useReloMode } from "./mode"
import { allClearWords, moreLine, offlineLabel, privateEarlierLine } from "./words"
import { ago, cap, foldCounts, foldedRows, foldedSections, foldIsOnlyPaused, liveCards, readableName, SUMMARY_VARIANTS, summaryShown, toggleCue, type SummaryVariant } from "./open/logic"
import { NEW_PLAN_STATE, type PlanState } from "./open/PlanDeck"
import { NumericText } from "./open/NumericText"
import { EASES, METRICS, SPRINGS } from "./open/tokens"
import { COLORS, toneColor } from "./theme"

export { ago, cap, liveCards }

export interface PanelProps {
  presentation: Presentation
  /** A Now summary has arrived (or a snapshot is shown). */
  hasData: boolean
  offline?: boolean
  questions: Record<string, QuestionSpec>
  answers: Record<string, AnswerPhase>
  onAnswer: OnAnswer
  /** Dismisses a missed question: POST /api/devices/self/questions/:id/dismiss. */
  onDismiss?: (questionId: string) => void | boolean | Promise<void | boolean>
  /** The last Now is shown until the server answers: a touch quieter, then full strength as it swaps to live (ReloNotchView.content). */
  cached?: boolean
  /** The height the Relo list needs (summary line included, the notch's own chrome not), and whether it is a list. */
  onFit: (height: number, showsList: boolean) => void
  reduceMotion?: boolean
  /** The card's play button (shown when Settings > Voice > "Show a play button on cards" is on). */
  voice?: CardVoice
  /** A card opened or closed in place: the interface cue to play (ReloNotchView.toggle). */
  onCue?: (cue: "expand" | "collapse") => void
}

export function Panel({ presentation, hasData, offline = false, questions, answers, onAnswer, onDismiss, onFit, cached = false, reduceMotion = false, voice, onCue }: PanelProps) {
  const { local, openDashboard, openHome } = useReloMode()
  const body = useRef<HTMLDivElement>(null)
  const first = useRef(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showsFolded, setShowsFolded] = useState(false)
  const [plans, setPlans] = useState<Record<string, PlanState>>({})
  const showsList = hasData && !isEmpty(presentation)

  useLayoutEffect(() => {
    first.current = false
  }, [])

  useLayoutEffect(() => {
    const measure = () => onFit(Math.ceil((body.current?.offsetHeight ?? 0) + SUMMARY_H), showsList)
    measure()
    const ro = new ResizeObserver(measure)
    if (body.current) ro.observe(body.current)
    return () => ro.disconnect()
  }, [onFit, showsList])

  const snappy = reduceMotion ? EASES.base : SPRINGS.snappy
  const toggle = (id: string) => {
    onCue?.(toggleCue(expandedId, id))
    setExpandedId((current) => (current === id ? null : id))
  }
  const live = liveCards(presentation)
  const recent = presentation.sections.find((s) => s.kind === "recent")
  const folded = foldedSections(presentation)
  const machines = machinesOf(presentation).slice(0, 4)

  const card = (row: Row, opts: { hero?: boolean; dimmed?: boolean; grouped?: boolean } = {}) => (
    <WorkCard
      row={row}
      voice={voice}
      hero={opts.hero}
      dimmed={opts.dimmed}
      grouped={opts.grouped}
      offline={offline}
      expanded={expandedId === row.id}
      questions={questions}
      answers={answers}
      onAnswer={onAnswer}
      onDismiss={onDismiss}
      onToggle={() => toggle(row.id)}
      planState={plans[row.id] ?? NEW_PLAN_STATE}
      onPlanState={(s) => setPlans((p) => ({ ...p, [row.id]: s }))}
    />
  )
  /** Finished, quiet or paused work: one-line rows on one surface; a clicked row opens into its card in place. */
  const group = (rows: Row[], dimmed = false) => (
    <Group items={rows.map((row) => ({ id: row.id, node: expandedId === row.id ? card(row, { dimmed, grouped: true }) : <div style={{ opacity: dimmed ? 0.7 : 1 }}><CompactRow row={row} onToggle={() => toggle(row.id)} /></div> }))} />
  )

  return (
    <div style={{ display: "flex", height: "100%", flexDirection: "column", gap: 10, paddingTop: 2, opacity: cached ? 0.72 : 1, transition: "opacity .35s ease-out" }}>
      <SummaryBar presentation={presentation} hasData={hasData} offline={offline} local={local} reduceMotion={reduceMotion} />
      <div className="ro-scroll" style={{ minHeight: 0, flex: 1 }}>
        <div ref={body} style={{ display: "flex", flexDirection: "column", gap: METRICS.sectionSpacing, paddingBottom: 8 }}>
          {!showsList ? (
            <AllClear hasData={hasData} offline={offline} local={local} privateEarlier={presentation.privateEarlier} />
          ) : (
            <>
              {live.cards.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: METRICS.itemSpacing }}>
                  <AnimatePresence initial>
                    {live.cards.map(({ row, hero }, index) => (
                      <motion.div
                        key={row.id}
                        layout="position"
                        initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.97, transition: EASES.fast }}
                        transition={{ ...snappy, delay: first.current ? Math.min(index, 6) * 0.04 : 0, layout: snappy }}
                        style={{ transformOrigin: "top" }}
                      >
                        {card(row, { hero })}
                      </motion.div>
                    ))}
                  </AnimatePresence>
                  {live.more > 0 && <MoreLine count={live.more} local={local} onOpen={local ? openHome : openDashboard} />}
                </div>
              )}
              {recent && (
                <motion.div layout="position" transition={{ layout: snappy }} initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }} animate={{ opacity: 1, y: 0 }}>
                  {group(recent.rows.slice(0, cap("recent")))}
                </motion.div>
              )}
              {folded.length > 0 && (
                <motion.div layout="position" transition={{ layout: snappy }} style={{ display: "flex", flexDirection: "column", gap: METRICS.itemSpacing }}>
                  <QuietLine sections={folded} open={showsFolded} onToggle={() => setShowsFolded((v) => !v)} />
                  <AnimatePresence initial={false}>
                    {showsFolded && (
                      <motion.div initial={{ opacity: 0, y: reduceMotion ? 0 : -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={snappy}>
                        {group(foldedRows(folded), true)}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              )}
              {machines.length > 0 && (
                <motion.div layout="position" transition={{ layout: snappy }} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <Group items={machines.map((m) => ({ id: m.name, node: <MachineRow machine={m} /> }))} />
                </motion.div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Rows grouped on one surface with hairlines between them (ReloCardGroup). */
function Group({ items }: { items: Array<{ id: string; node: ReactNode }> }) {
  return (
    <div style={{ borderRadius: METRICS.radius, overflow: "hidden", background: METRICS.fill, boxShadow: `inset 0 0 0 1px ${METRICS.border}` }}>
      {items.map((item, index) => (
        <div key={item.id}>
          {index > 0 && <div style={{ height: 0.5, background: "rgb(255 255 255 / 0.08)", marginLeft: 12 }} />}
          {item.node}
        </div>
      ))}
    </div>
  )
}

// MARK: Summary

/** One count of the summary (ReloSummaryCount): the state's symbol and number in its colour, its word after it when there is room. */
function Count({ entry, worded, reduceMotion, ref }: { entry: TallyEntry; worded: boolean; reduceMotion: boolean; /** AnimatePresence measures its child to take it out of the flow while it leaves. */ ref?: Ref<HTMLSpanElement> }) {
  const color = entry.tone ? toneColor(entry.tone) : COLORS.secondaryText
  const spring = reduceMotion ? EASES.base : SPRINGS.snappy
  // `.transition(.opacity.combined(with: .scale(scale: 0.8)))` (Reduce Motion: opacity only), on the line's `snappy`.
  const from = reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8 }
  return (
    <motion.span ref={ref} layout="position" initial={from} animate={{ opacity: 1, scale: 1 }} exit={from} transition={{ ...spring, layout: spring }} style={{ position: "relative", display: "flex", flex: "none", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
      <span style={{ color, display: "grid" }}>{entry.tone ? <ToneIcon tone={entry.tone} size={9} /> : <ComputerIcon name="laptop" size={9} />}</span>
      <NumericText value={entry.count} reduceMotion={reduceMotion} className="tabular-nums" style={{ fontSize: 11, fontWeight: 600, color }} />
      <AnimatePresence initial={false} mode="popLayout">
        {worded && (
          <motion.span key="word" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ ...spring, layout: spring }} style={{ fontSize: 11, color: COLORS.secondaryText }}>
            {entry.label}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.span>
  )
}

/**
 * The list's summary in one line: each state's count in its colour and symbol, in the order that matters. When the line
 * runs out of room it drops the words, then the least urgent counts (folded into "+n"), and never wraps. Offline, or
 * private work waiting for this PC's approval, sits on the right as one capsule.
 *
 * Nothing here clips: a count entering or leaving fades and scales while its neighbours glide to their new places and
 * a changed number rolls its digits (the Mac animates the whole line on `snappy` for a changed tally).
 */
function SummaryBar({ presentation, hasData, offline, local, reduceMotion }: { presentation: Presentation; hasData: boolean; offline: boolean; local: boolean; reduceMotion: boolean }) {
  const tally = tallyOf(presentation)
  const room = useRef<HTMLDivElement>(null)
  const counts = useRef<HTMLDivElement>(null)
  const [step, setStep] = useState(0)
  const key = tally.map((e) => `${e.kind}${e.count}`).join()
  // The room depends on which counts exist, not on their numbers: a count changing from 1 to 2 never reflows the variant.
  const shape = tally.map((e) => `${e.kind}${String(e.count).length}`).join()

  // ViewThatFits: the first variant that fits the room; measured, widest first.
  useLayoutEffect(() => {
    setStep(0)
  }, [shape, offline, presentation.hasUnreadable])
  useLayoutEffect(() => {
    const frame = room.current
    const row = counts.current
    if (!frame || !row) return
    if (row.offsetWidth > frame.clientWidth + 0.5 && step < SUMMARY_VARIANTS.length - 1) setStep(step + 1)
  }, [step, key, shape, offline, presentation.hasUnreadable])
  useLayoutEffect(() => {
    const frame = room.current
    if (!frame) return
    let width = frame.clientWidth
    const ro = new ResizeObserver(() => {
      if (Math.abs(frame.clientWidth - width) < 0.5) return
      width = frame.clientWidth
      setStep(0)
    })
    ro.observe(frame)
    return () => ro.disconnect()
  }, [])

  const variant: SummaryVariant = SUMMARY_VARIANTS[Math.min(step, SUMMARY_VARIANTS.length - 1)]!
  const { shown, rest } = summaryShown(tally, variant)
  const spring = reduceMotion ? EASES.base : SPRINGS.snappy
  return (
    <div title={presentation.sinceYouLooked ? `Since you looked: ${presentation.sinceYouLooked}` : undefined} style={{ display: "flex", height: METRICS.summaryHeight, flex: "none", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
      <div ref={room} style={{ display: "flex", minWidth: 0, flex: "1 1 0", alignItems: "center" }}>
        <div ref={counts} style={{ display: "flex", flex: "none", position: "relative", alignItems: "center", gap: 12, width: "max-content" }}>
          {!hasData ? (
            <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 500 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: COLORS.info }} />
              Relo <span style={{ color: COLORS.secondaryText }}>· Not connected</span>
            </span>
          ) : tally.length === 0 ? (
            <span style={{ fontSize: 11, color: COLORS.secondaryText }}>Relo</span>
          ) : (
            <>
              <AnimatePresence initial={false} mode="popLayout">
                {shown.map(({ entry, worded }) => <Count key={entry.kind} entry={entry} worded={worded} reduceMotion={reduceMotion} />)}
              </AnimatePresence>
              {rest > 0 && (
                <motion.span layout="position" transition={{ layout: spring }} className="tabular-nums" style={{ fontSize: 11, fontWeight: 600, color: COLORS.tertiaryText }}>+{rest}</motion.span>
              )}
            </>
          )}
        </div>
      </div>
      {offline ? (
        <Capsule color={COLORS.warning}><OfflineIcon local={local} size={10} /> {offlineLabel(local)}</Capsule>
      ) : presentation.hasUnreadable && !local ? (
        <Capsule color={COLORS.warning}><Lock size={10} /> Approve this PC on your iPhone</Capsule>
      ) : null}
    </div>
  )
}

function Capsule({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span style={{ display: "flex", flex: "none", alignItems: "center", gap: 4, borderRadius: 999, padding: "2px 8px", fontSize: 10.5, fontWeight: 500, color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}>
      {children}
    </span>
  )
}

// MARK: Folded and quiet

/** The folded line: the moon (paused only: the pause sign) breathing in slate, "3 quiet · 1 paused", when the freshest of them last moved, Show or Hide. */
function QuietLine({ sections, open, onToggle }: { sections: Section[]; open: boolean; onToggle: () => void }) {
  const rows = sections.flatMap((s) => s.rows)
  const last = Math.max(...rows.map((r) => r.declaredAt))
  return (
    <button type="button" className="ro-press" onClick={onToggle} aria-expanded={open} style={{ display: "flex", height: METRICS.quietHeight, width: "100%", alignItems: "center", gap: 7, padding: "0 2px", textAlign: "left" }}>
      <motion.span style={{ color: COLORS.info, width: 13, display: "grid", placeItems: "center" }} animate={{ opacity: [0.45, 0.9, 0.45] }} transition={{ duration: 4.5, repeat: Infinity, ease: "easeInOut" }}>
        <ToneIcon tone={foldIsOnlyPaused(sections) ? "paused" : "quiet"} size={10} />
      </motion.span>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: "rgb(255 255 255 / 0.75)", whiteSpace: "nowrap" }}>{foldCounts(sections)}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: COLORS.tertiaryText }}>· last moved {ago(last, Date.now())}</span>
      <span style={{ marginLeft: "auto", fontSize: 10, color: COLORS.tertiaryText }}>{open ? "Hide" : "Show"}</span>
      <motion.span animate={{ rotate: open ? 90 : 0 }} transition={SPRINGS.snappy} style={{ color: COLORS.tertiaryText, display: "grid" }}><Chevron /></motion.span>
    </button>
  )
}

// MARK: Computers

/** One computer at work: a tile with its symbol, its name, a chip per harness with its working and waiting counts, what it is doing. */
function MachineRow({ machine }: { machine: Machine }) {
  const working = machine.working > 0
  const idle = machine.isIdle
  const tint = working ? COLORS.running : COLORS.secondaryText
  const tile = working ? COLORS.running : COLORS.signalCoral
  const parts = [working ? `${machine.working} working` : null, machine.waiting > 0 ? `${machine.waiting} waiting` : null].filter(Boolean)
  return (
    <div className={working ? "ro-machine-sweep" : undefined} style={{ display: "flex", height: METRICS.machineHeight, alignItems: "center", gap: 8, padding: "0 12px", opacity: idle ? 0.55 : 1, transition: "opacity .26s ease-in-out" }}>
      <span style={{ display: "grid", width: 20, height: 20, flex: "none", placeItems: "center", borderRadius: 6, color: working || idle ? tint : COLORS.signalCoral, background: idle ? "rgb(255 255 255 / 0.06)" : `color-mix(in srgb, ${tile} 16%, transparent)` }}>
        <ComputerIcon name={machine.icon} size={10} />
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 600 }}>{readableName(machine.name) ?? "A computer"}</span>
      {machine.harnesses.slice(0, 4).map((h) => (
        <span
          key={h.source}
          title={`${h.source}: ${h.working} working, ${h.waiting} waiting${h.idle ? `, ${h.idle} idle` : ""}${h.untracked ? `, ${h.untracked} not tracked: turn on Relo's hooks to see activity` : ""}`}
          style={{ display: "flex", flex: "none", alignItems: "center", gap: 3, borderRadius: 7, padding: `2px ${h.working + h.waiting > 0 ? 6 : 3}px 2px 3px`, fontSize: 10, fontWeight: 600, background: h.working === 0 && h.waiting > 0 ? "rgb(255 122 102 / 0.12)" : "rgb(255 255 255 / 0.06)" }}
        >
          <SourceMark name={h.source} size={11} />
          {h.working > 0 && <span className="tabular-nums" style={{ color: COLORS.running }}>{h.working}</span>}
          {h.waiting > 0 && <span className="tabular-nums" style={{ color: COLORS.signalCoral }}>{h.waiting}</span>}
        </span>
      ))}
      <span style={{ flex: 1 }} />
      {working && <span className="ro-wave" aria-hidden><i /><i /><i /><i /></span>}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10, color: "rgb(255 255 255 / 0.54)" }}>{parts.length ? parts.join(" · ") : machine.untracked > 0 ? "" : "Idle"}</span>
    </div>
  )
}

/** "+N more" (ReloMoreLine): a server opens its Dashboard, Relo on this PC opens Home. Plain text when there is nowhere to go. */
function MoreLine({ count, local, onOpen }: { count: number; local: boolean; onOpen: (() => void) | null }) {
  const style = { fontSize: 11, fontWeight: 500, color: COLORS.tertiaryText, textAlign: "left" as const }
  if (!onOpen) return <div style={style}>{moreLine(count, true)}</div>
  return (
    <button type="button" className="ro-press" onClick={onOpen} style={style}>
      {moreLine(count, local)}
    </button>
  )
}

function AllClear({ hasData, offline, local, privateEarlier }: { hasData: boolean; offline: boolean; local: boolean; privateEarlier: number }) {
  const words = allClearWords({ local, offline, connecting: !hasData })
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={SPRINGS.snappy} style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, padding: "26px 0", textAlign: "center" }}>
      <span style={{ color: offline ? COLORS.yellow : COLORS.mint }}>{offline ? <OfflineIcon local={local} size={22} /> : <Check size={22} />}</span>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{words.title}</div>
      <div style={{ fontSize: 11, color: COLORS.secondaryText }}>{words.detail}</div>
      {privateEarlier > 0 && !local && <div style={{ fontSize: 10.5, color: COLORS.tertiaryText }}>{privateEarlierLine(privateEarlier)}</div>}
    </motion.div>
  )
}
