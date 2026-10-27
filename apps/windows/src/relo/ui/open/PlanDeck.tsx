// The plan, opened, as a deck (ReloNotchView.swift ReloPlanSteps and its parts, the Round Deck study): delivered rounds
// stack as slabs with their outcome; the round in progress is one panel; one rail joins each step's mark to the next;
// only the step being worked moves (a ripple on its mark, light through its name). Four columns shared by every row:
// mark, text, time, chevron. Built on `PlanOutline`, so folding, windowing and skipped steps read as on the iPhone.

import { AnimatePresence, motion } from "motion/react"
import { useCallback, type ReactNode } from "react"
import { durationLabel, foldText, hasRoundSections, itemsIn, nodeShownLabel, roundSlots, type PlanItem, type PlanNode, type PlanOutline, type PlanRoundOutline, type Branch } from "../../plan"
import type { Row } from "../../presentation"
import { COLORS } from "../theme"
import { EXTRA, PLAN, SPRINGS } from "./tokens"
import { Elapsed } from "./time"

/** What the owner opened or folded in a card's plan; it lives on the card, so closing and reopening keeps it. */
export interface PlanState {
  openedRounds: ReadonlySet<number>
  openedSteps: ReadonlySet<string>
  expandedFolds: ReadonlySet<string>
  earlierExpanded: boolean
}
export const NEW_PLAN_STATE: PlanState = { openedRounds: new Set(), openedSteps: new Set(), expandedFolds: new Set(), earlierExpanded: false }

const flip = <T,>(set: ReadonlySet<T>, v: T): Set<T> => {
  const next = new Set(set)
  if (!next.delete(v)) next.add(v)
  return next
}

/** A stopped work shows its skipped steps as open ones (PlanOutline.unskipped). */
export function unskipped(outline: PlanOutline): PlanOutline {
  return { rounds: outline.rounds.map((round) => ({ ...round, nodes: round.nodes.map((n): PlanNode => (n.state === "skipped" ? { ...n, state: "pending" } : n)) })) }
}

interface Ctx {
  outline: PlanOutline
  state: PlanState
  change: (edit: (s: PlanState) => PlanState) => void
  /** The work is done: finished marks and rails turn green instead of the running gradient. */
  finished: boolean
  /** The work is moving: only then does the current step pulse and shimmer. */
  working: boolean
}

const itemsFor = (ctx: Ctx, round: PlanRoundOutline): PlanItem[] => itemsIn(round, { expandedFolds: ctx.state.expandedFolds, openedSteps: ctx.state.openedSteps })

export function PlanSteps({ row, state, onState }: { row: Row; state: PlanState; onState: (s: PlanState) => void }) {
  const change = useCallback((edit: (s: PlanState) => PlanState) => onState(edit(state)), [state, onState])
  if (!row.outline) return row.status ? <div style={{ fontSize: 11, color: COLORS.secondaryText }}>{row.status}</div> : null
  const stopped = row.tone === "failed" || row.tone === "dropped" || row.tone === "leftUnfinished"
  const outline = stopped ? unskipped(row.outline) : row.outline
  const ctx: Ctx = { outline, state, change, finished: row.tone === "done", working: row.tone === "working" }
  if (hasRoundSections(outline)) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: PLAN.deckSpacing }}>
        {roundSlots(outline, state.earlierExpanded).map((slot) =>
          slot.kind === "earlier" ? (
            <EarlierRounds key="earlier" count={slot.count} expand={() => change((s) => ({ ...s, earlierExpanded: true }))} />
          ) : slot.round.closed ? (
            <RoundSlab key={slot.round.n} round={slot.round} ctx={ctx} />
          ) : (
            <RoundPanel key={slot.round.n} round={slot.round} ctx={ctx} />
          ),
        )}
      </div>
    )
  }
  const round = outline.rounds[0]
  return round ? <Items items={itemsFor(ctx, round)} ctx={ctx} /> : null
}

// MARK: Rows

const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 8 8" width={7.5} height={7.5} aria-hidden style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform .28s cubic-bezier(.2,.8,.2,1)" }}>
    <path d="M2.5 0.8 5.7 4 2.5 7.2" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** The four columns: mark, text, time, chevron. */
function PlanRow({ mark, text, meta, chevron }: { mark: ReactNode; text: ReactNode; meta?: ReactNode; chevron?: "open" | "closed" }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: PLAN.gap, padding: `${PLAN.rowPad}px 0` }}>
      <span style={{ width: PLAN.mark, height: PLAN.mark, marginTop: (PLAN.line - PLAN.mark) / 2, flex: "none", position: "relative", display: "grid", placeItems: "center" }}>{mark}</span>
      <div style={{ flex: 1, minWidth: 0 }}>{text}</div>
      <span style={{ width: PLAN.meta, height: PLAN.line, flex: "none", display: "flex", justifyContent: "flex-end", alignItems: "center" }}>{meta}</span>
      <span style={{ width: PLAN.chevron, height: PLAN.line, flex: "none", display: "grid", placeItems: "center", color: COLORS.tertiaryText, opacity: chevron ? 1 : 0 }}>
        <Chevron open={chevron === "open"} />
      </span>
    </div>
  )
}

/** Rows that open something dim a little while pressed. */
function PressRow({ onClick, children, label }: { onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button type="button" className="ro-press" aria-label={label} onClick={(e) => { e.stopPropagation(); onClick() }} style={{ display: "block", width: "100%", textAlign: "left" }}>
      {children}
    </button>
  )
}

// MARK: Marks

type MarkKind = "done" | "current" | "open" | "skipped" | "roundDone" | "fold"
const markKind = (s: PlanNode["state"]): MarkKind => (s === "complete" ? "done" : s === "current" ? "current" : s === "skipped" ? "skipped" : "open")

function Tick({ color, width = 1.5 }: { color: string; width?: number }) {
  return (
    <svg viewBox="0 0 12 12" width="100%" height="100%" style={{ position: "absolute", inset: 0 }} aria-hidden>
      <path d="M3.48 6.36 5.28 8.16 8.76 4.32" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The ring that grows to 2.4x and fades every 1.8 s, after a short beat (ReloPlanRipple). */
function Ripple() {
  return <span className="ro-ripple" aria-hidden />
}

export function PlanMark({ kind, finished = false, parent = false, pulse = false }: { kind: MarkKind; finished?: boolean; parent?: boolean; pulse?: boolean }) {
  const ring = (c: string, w: number, dash?: string): React.CSSProperties => ({ position: "absolute", inset: 0, borderRadius: "50%", boxSizing: "border-box", border: `${w}px ${dash ?? "solid"} ${c}` })
  return (
    <>
      {pulse && <Ripple />}
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={kind}
          style={{ position: "absolute", inset: 0 }}
          initial={{ opacity: 0, scale: kind === "done" ? 0.6 : 1 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ ...SPRINGS.bouncy }}
        >
          {kind === "done" && (
            <>
              <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: finished ? EXTRA.done : EXTRA.holo }} />
              <Tick color="rgb(0 0 0 / 0.82)" />
            </>
          )}
          {kind === "current" && (
            <>
              <span style={ring(EXTRA.running, 1.5)} />
              <span style={{ position: "absolute", left: "50%", top: "50%", width: parent ? 3 : 5, height: parent ? 3 : 5, margin: parent ? -1.5 : -2.5, borderRadius: "50%", background: EXTRA.running }} />
            </>
          )}
          {kind === "open" && <span style={ring("rgb(255 255 255 / 0.28)", 1.25)} />}
          {kind === "skipped" && <span style={ring("rgb(255 255 255 / 0.28)", 1.25, "dashed")} />}
          {kind === "roundDone" && (
            <>
              <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "rgb(52 211 153 / 0.16)" }} />
              <Tick color={EXTRA.done} />
            </>
          )}
          {kind === "fold" && (
            <>
              <span style={ring("rgb(255 255 255 / 0.22)", 1, "dotted")} />
              <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 7, fontWeight: 700, lineHeight: 1, color: COLORS.tertiaryText }}>···</span>
            </>
          )}
        </motion.span>
      </AnimatePresence>
    </>
  )
}

// MARK: Items

/** The line from a step's mark to the next one's: fills top-down with the running gradient (green when finished). */
function Rail({ tinted, finished }: { tinted: boolean; finished: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        left: PLAN.mark / 2 - 0.75,
        width: 1.5,
        top: PLAN.rowPad + (PLAN.line - PLAN.mark) / 2 + PLAN.mark,
        bottom: -(PLAN.rowPad + (PLAN.line - PLAN.mark) / 2),
        borderRadius: 1,
        background: "rgb(255 255 255 / 0.13)",
        overflow: "hidden",
        pointerEvents: "none",
      }}
    >
      <span className="ro-rail-fill" style={{ background: finished ? "rgb(52 211 153 / 0.7)" : EXTRA.holoDown, transform: `scaleY(${tinted ? 1 : 0.0001})` }} />
    </span>
  )
}

function Items({ items, ctx }: { items: PlanItem[]; ctx: Ctx }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {items.map((item, index) => {
        const last = index === items.length - 1
        if (item.kind === "branch") {
          return (
            <div key={item.node.id} style={{ position: "relative" }}>
              {!last && <Rail tinted={item.node.state === "complete"} finished={ctx.finished} />}
              <BranchView branch={item} ctx={ctx} />
            </div>
          )
        }
        return (
          <div key={item.id} style={{ position: "relative" }}>
            {!last && <Rail tinted={item.foldKind === "done"} finished={ctx.finished} />}
            <PressRow label={`${foldText(item)}, hidden`} onClick={() => ctx.change((s) => ({ ...s, expandedFolds: new Set(s.expandedFolds).add(item.id) }))}>
              <PlanRow mark={<PlanMark kind="fold" />} text={<span style={{ fontSize: 10.5, color: COLORS.tertiaryText }}>{foldText(item)}</span>} />
            </PressRow>
          </div>
        )
      })}
    </div>
  )
}

function BranchView({ branch, ctx }: { branch: Branch; ctx: Ctx }) {
  const node = branch.node
  const hasChildren = node.childIds.length > 0
  const leafNow = node.state === "current" && !hasChildren
  const duration = node.doneAt && node.startedAt ? durationLabel((node.doneAt - node.startedAt) / 1000) : null
  const row = (
    <PlanRow
      mark={<PlanMark kind={markKind(node.state)} finished={ctx.finished} parent={hasChildren} pulse={leafNow && ctx.working} />}
      text={
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <PlanLabel text={nodeShownLabel(node)} node={node} shine={leafNow && ctx.working} />
          {leafNow && node.detail && (
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ fontSize: 10.5, color: COLORS.tertiaryText, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {node.detail}
            </motion.span>
          )}
        </div>
      }
      meta={
        branch.count ? (
          <span
            className="tabular-nums"
            style={{ fontSize: 9.5, height: 14, lineHeight: "14px", padding: "0 5px", borderRadius: 7, color: node.state === "current" ? COLORS.runningSoft : COLORS.tertiaryText, background: node.state === "current" ? "rgb(139 124 255 / 0.16)" : "rgb(255 255 255 / 0.06)" }}
          >
            {branch.count.done}/{branch.count.total}
          </span>
        ) : leafNow && node.startedAt ? (
          <span style={{ fontSize: 10, color: COLORS.runningSoft }}><Elapsed since={node.startedAt} bare /></span>
        ) : node.state === "complete" && duration ? (
          <span className="tabular-nums" style={{ fontSize: 10, color: COLORS.tertiaryText }}>{duration}</span>
        ) : null
      }
      chevron={hasChildren && node.state !== "current" ? (branch.opened ? "open" : "closed") : undefined}
    />
  )
  return (
    <div>
      {hasChildren && node.state !== "current" ? <PressRow onClick={() => ctx.change((s) => ({ ...s, openedSteps: flip(s.openedSteps, node.id) }))}>{row}</PressRow> : row}
      <AnimatePresence initial={false}>
        {branch.opened && branch.children.length > 0 && (
          <motion.div key="kids" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={SPRINGS.smooth} style={{ paddingLeft: PLAN.mark + PLAN.gap, overflow: "hidden" }}>
            <Items items={branch.children} ctx={ctx} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** A step's name: the current one bold with light passing through it, done ones quiet, a phase a little heavier. */
function PlanLabel({ text, node, shine }: { text: string; node: PlanNode; shine: boolean }) {
  const hasChildren = node.childIds.length > 0
  const color = node.state === "current" ? "#fff" : node.state === "complete" || node.state === "skipped" ? COLORS.tertiaryText : hasChildren ? "rgb(255 255 255 / 0.78)" : COLORS.secondaryText
  return (
    <span
      className={shine ? "ro-shine" : undefined}
      style={{ fontSize: 11.5, lineHeight: `${PLAN.line}px`, fontWeight: node.state === "current" ? 600 : hasChildren ? 500 : 400, fontStyle: node.readable ? undefined : "italic", color, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", transition: "color .26s ease-in-out" }}
    >
      {text}
    </span>
  )
}

// MARK: Rounds

function RoundSlab({ round, ctx }: { round: PlanRoundOutline; ctx: Ctx }) {
  const open = ctx.state.openedRounds.has(round.n)
  const duration = round.openedAt && round.closedAt ? durationLabel((round.closedAt - round.openedAt) / 1000) : null
  return (
    <div style={{ borderRadius: 10, background: "rgb(255 255 255 / 0.05)", boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.08)" }}>
      <PressRow label={`Round ${round.n}, delivered`} onClick={() => ctx.change((s) => ({ ...s, openedRounds: flip(s.openedRounds, round.n) }))}>
        <div style={{ padding: `${PLAN.pane - PLAN.rowPad}px ${PLAN.pane}px` }}>
          <PlanRow
            mark={<PlanMark kind="roundDone" />}
            text={
              <div>
                <span style={{ fontSize: 11.5, lineHeight: `${PLAN.line}px`, display: "-webkit-box", WebkitLineClamp: open ? 2 : 1, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  <span style={{ fontWeight: 600, color: "rgb(255 255 255 / 0.82)" }}>Round {round.n}</span>
                  {round.title && <span style={{ fontWeight: 500, color: COLORS.secondaryText }}> · {round.title}</span>}
                </span>
                {round.outcome && (
                  <span style={{ display: "-webkit-box", WebkitLineClamp: open ? 4 : 1, WebkitBoxOrient: "vertical", overflow: "hidden", fontSize: 10.5, color: COLORS.tertiaryText }}>{round.outcome}</span>
                )}
              </div>
            }
            meta={duration ? <span className="tabular-nums" style={{ fontSize: 10, color: COLORS.tertiaryText }}>{duration}</span> : null}
            chevron={open ? "open" : "closed"}
          />
        </div>
      </PressRow>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="steps" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={SPRINGS.smooth} style={{ overflow: "hidden" }}>
            <div style={{ padding: `0 ${PLAN.pane}px ${PLAN.pane - PLAN.rowPad}px` }}>
              <Items items={itemsFor(ctx, round)} ctx={ctx} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** "3 earlier rounds": rounds before the last two, folded into one quiet slab. */
function EarlierRounds({ count, expand }: { count: number; expand: () => void }) {
  return (
    <PressRow label={`${count} earlier rounds`} onClick={expand}>
      <div style={{ padding: `${PLAN.pane - PLAN.rowPad}px ${PLAN.pane}px`, borderRadius: 10, border: "1px dashed rgb(255 255 255 / 0.08)" }}>
        <PlanRow mark={<PlanMark kind="fold" />} text={<span style={{ fontSize: 10.5, color: COLORS.tertiaryText }}>{count} earlier rounds</span>} />
      </div>
    </PressRow>
  )
}

/** The round in progress: one panel; its heading starts at the marks' edge, its steps below. */
function RoundPanel({ round, ctx }: { round: PlanRoundOutline; ctx: Ctx }) {
  return (
    <div style={{ padding: `${PLAN.pane}px ${PLAN.pane}px ${PLAN.pane - PLAN.rowPad}px`, borderRadius: 10, background: "rgb(139 124 255 / 0.07)", boxShadow: "inset 0 0 0 1px rgb(139 124 255 / 0.18)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 1, paddingRight: PLAN.meta + PLAN.chevron + PLAN.gap * 2, paddingBottom: Math.max(0, PLAN.pane - PLAN.rowPad * 2) }}>
        <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.7px", color: COLORS.runningSoft }}>{`Round ${round.n} · ${ctx.working ? "in progress" : "open"}`.toUpperCase()}</span>
        {round.title && <span style={{ fontSize: 11.5, fontWeight: 600, color: "#fff" }}>{round.title}</span>}
      </div>
      <Items items={itemsFor(ctx, round)} ctx={ctx} />
    </div>
  )
}
