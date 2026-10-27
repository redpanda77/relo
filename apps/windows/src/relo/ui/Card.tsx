// The card anatomy of Relo for Mac (ReloCards.swift ReloWorkCard / ReloStateBadge / ReloCompactRow, ReloNotchView.swift
// ReloAnswerBar, ReloNotchTheme.swift ReloStepsBar): the origin with the state's badge on its right (the state is said
// once), the title, the status, the plan bar (left out when complete or stepless) and a footer (the plan on the left; the
// computer and the time, or the answer, on the right). Every collapsed card is 108 pt tall; opened, it grows to its whole
// text and shows what the last round delivered and the plan's deck. Finished work is a compact row.

import { AnimatePresence, motion } from "motion/react"
import { useState, type CSSProperties } from "react"
import type { AnswerPhase, OnAnswer, QuestionSpec } from "../answers"
import { answerButtons } from "../answers"
import { hasRoundSections, type BarSegment } from "../plan"
import { rowBar, type Row } from "../presentation"
import { Check, ComputerIcon, ExternalLink, Lock, OfflineIcon, ToneIcon } from "./icons"
import { useReloMode } from "./mode"
import { DISMISS_FAILED, offlineAnswer, textReply, untitled } from "./words"
import { cardFacts, answerView, readableName } from "./open/logic"
import { NEW_PLAN_STATE, PlanSteps, type PlanState } from "./open/PlanDeck"
import { Elapsed, timeOf } from "./open/time"
import { EASES, FONT, METRICS, SPRINGS } from "./open/tokens"
import { COLORS, toneColor } from "./theme"

/** The plan as segments, one per top-level step (ReloStepsBar). Past 12 steps it is one continuous bar. */
export function PlanBarView({ bar, color: colorProp, tone, maxSegments = 12 }: { bar: BarSegment[]; color?: string; /** The earlier name of `color`. */ tone?: string; maxSegments?: number; live?: boolean }) {
  const color = colorProp ?? tone ?? COLORS.running
  if (bar.length > maxSegments) {
    const filled = bar.reduce((n, s) => n + (s.state === "done" ? 1 : s.state === "current" ? Math.min(1, s.fill) : 0), 0)
    return (
      <div className="ro-bar" style={{ ["--tone" as string]: color }}>
        <span style={{ flex: 1, background: "rgb(255 255 255 / 0.1)", borderRadius: 999, position: "relative", overflow: "hidden" }}>
          <span style={{ position: "absolute", inset: "0 auto 0 0", width: `${(filled / Math.max(bar.length, 1)) * 100}%`, background: color, borderRadius: 999 }} />
        </span>
      </div>
    )
  }
  return (
    <div className="ro-bar" style={{ ["--tone" as string]: color }}>
      {bar.map((segment, index) => (
        <span
          key={index}
          data-step={segment.state}
          style={segment.state === "current" ? { ["--seg-fill" as string]: `${Math.round(Math.min(1, segment.fill) * 100)}%` } : undefined}
        />
      ))}
    </div>
  )
}

const sourceTint: Record<string, string | undefined> = { "claude code": "#d97757", claude: "#d97757", "claude-code": "#d97757" }

/** A known agent's own mark in place of its name (ReloSourceMark); unknown sources keep their name. */
export function SourceMark({ name, size = 11 }: { name: string; size?: number }) {
  const key = name.trim().toLowerCase()
  const known = key in sourceTint || ["codex", "openai codex", "codex cli", "opencode", "open code"].includes(key)
  if (!known) return <span>{name}</span>
  const color = sourceTint[key] ?? COLORS.secondaryText
  const codex = key.includes("codex")
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-label={name} style={{ color, flex: "none" }} fill="currentColor">
      {codex ? (
        <path d="M8 1.5 13.600 4.750v6.500L8 14.500 2.400 11.250v-6.500L8 1.500Zm0 3a3.500 3.500 0 1 0 0 7 3.500 3.500 0 0 0 0-7Z" fillRule="evenodd" />
      ) : key.includes("open") ? (
        <path d="M3 2h10v12H3V2Zm2.500 3v6h5V5h-5Z" fillRule="evenodd" />
      ) : (
        <path d="M8 .8 9.300 5.300 13.500 2.700 10.700 6.700 15.200 8 10.700 9.300 13.500 13.300 9.300 10.700 8 15.200 6.700 10.700 2.500 13.300 5.300 9.300.8 8 5.300 6.700 2.500 2.700 6.700 5.300 8 .8Z" />
      )}
    </svg>
  )
}

export function Origin({ row }: { row: Row }) {
  const project = readableName(row.project)
  return (
    <div style={{ display: "flex", minWidth: 0, alignItems: "center", gap: 4, fontSize: FONT.origin, lineHeight: 1.3, whiteSpace: "nowrap", overflow: "hidden" }}>
      {row.source && <SourceMark name={row.source} />}
      {project && <span style={{ fontWeight: 600, color: COLORS.secondaryText, overflow: "hidden", textOverflow: "ellipsis" }}>{project}</span>}
    </div>
  )
}

const MissedIcon = ({ size = 9 }: { size?: number }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.6V8l2.200 1.300" />
  </svg>
)

/** The state's one badge: symbol and label in its colour; running work carries the travelling light of the bar. */
export function StateBadge({ row, label, live }: { row: Row; label: string; live: boolean }) {
  return (
    <span style={{ display: "flex", flex: "none", alignItems: "center", gap: 4, fontSize: FONT.badge, fontWeight: 600, lineHeight: 1, color: toneColor(row.tone), whiteSpace: "nowrap" }}>
      {row.questionMissed ? <MissedIcon /> : <ToneIcon tone={row.tone} size={9} />}
      <span className={live ? "ro-sweep" : undefined} style={{ ["--tone" as string]: toneColor(row.tone) }}>{label}</span>
    </span>
  )
}

function Spinner() {
  return <span className="ro-spin" aria-hidden />
}

function Pill({ children, prominent = false, disabled = false, onClick }: { children: React.ReactNode; prominent?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <motion.button
      type="button"
      className="ro-pill"
      data-prominent={prominent ? "" : undefined}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.96, opacity: 0.7 }}
      transition={SPRINGS.press}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      {children}
    </motion.button>
  )
}

/** Answers the owner can give from the notch (ReloAnswerBar). Free-text replies go to the phone or the Dashboard; offline, nothing is sent. */
export function AnswerBar({ interactionId, spec, phase, offline, onAnswer }: { interactionId: string; spec: QuestionSpec | undefined; phase: AnswerPhase | undefined; offline: boolean; onAnswer: OnAnswer }) {
  const { local, openDashboard } = useReloMode()
  const view = answerView(spec, phase, offline, local)
  const buttons = answerButtons(spec, local)
  const small: CSSProperties = { fontSize: 11, whiteSpace: "nowrap" }
  const body = (() => {
    switch (view.kind) {
      case "offline":
        return (
          <span style={{ display: "flex", alignItems: "center", gap: 4, ...small, color: COLORS.yellow }}>
            <OfflineIcon local={local} /> {offlineAnswer(local)}
          </span>
        )
      case "sending":
        return (
          <span style={{ display: "flex", alignItems: "center", gap: 6, ...small, color: COLORS.secondaryText }}>
            <Spinner /> Sending…
          </span>
        )
      case "sent":
        return (
          <span style={{ display: "flex", alignItems: "center", gap: 4, ...small, fontWeight: 500, color: COLORS.mint }}>
            <Check size={11} /> Sent
          </span>
        )
      case "wait":
        return <Spinner />
      case "text":
        // A free-text question is answered in the terminal (local) or on the iPhone or in the Dashboard, with a button to it.
        return (
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ ...small, color: COLORS.secondaryText }}>{textReply(local)}</span>
            {!local && openDashboard && (
              <Pill onClick={openDashboard}>
                <ExternalLink /> Dashboard
              </Pill>
            )}
          </span>
        )
      case "buttons":
        return (
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {view.failure && <span style={{ ...small, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", color: COLORS.yellow }}>{view.failure}</span>}
            {buttons.map((button) => (
              <Pill key={button.optionId ?? button.action} prominent={button.prominent} onClick={() => onAnswer(interactionId, button.action, button.optionId)}>
                {button.label}
              </Pill>
            ))}
          </span>
        )
    }
  })()
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={view.kind} initial={{ opacity: 0, scale: view.kind === "sent" ? 0.8 : 1 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={view.kind === "sent" ? SPRINGS.bouncy : SPRINGS.smooth} style={{ display: "flex" }}>
        {body}
      </motion.span>
    </AnimatePresence>
  )
}

/** The card's play button (ReloPlayButton): `canPlay` says the card has a line to say; `play` says it, or stops it when it is being said. */
export interface CardVoice {
  canPlay: (row: Row) => boolean
  play: (row: Row) => Promise<void> | void
}

/** The little round play / stop button before the badge (ReloCards.swift ReloPlayButton: 16 pt circle, 8 pt glyph). */
export function PlayButton({ active, onPress }: { active: boolean; onPress: () => void }) {
  const label = active ? "Stop speaking" : "Say this card"
  return (
    <button
      type="button"
      className="ro-press ro-play"
      aria-label={label}
      title={active ? "Stop" : "Say this card"}
      aria-pressed={active}
      onClick={(e) => {
        e.stopPropagation()
        onPress()
      }}
      style={{ display: "grid", flex: "none", placeItems: "center", width: 16, height: 16, borderRadius: 999, background: `rgb(255 255 255 / ${active ? 0.18 : 0.08})`, color: active ? "#fff" : COLORS.secondaryText }}
    >
      <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden>
        {active ? <rect x="1" y="1" width="6" height="6" rx="1" /> : <path d="M1.5 0.6 7 4 1.5 7.4z" />}
      </svg>
    </button>
  )
}

function CardPlay({ row, voice }: { row: Row; voice: CardVoice }) {
  const [active, setActive] = useState(false)
  if (!voice.canPlay(row)) return null
  return (
    <PlayButton
      active={active}
      onPress={() => {
        setActive(!active)
        void Promise.resolve(voice.play(row)).finally(() => setActive(false))
      }}
    />
  )
}

export interface CardProps {
  row: Row
  /** Settings > Voice > "Show a play button on cards": given, the card has the button (when it has a line to say). */
  voice?: CardVoice
  /** The question's size (Needs you). */
  hero?: boolean
  expanded?: boolean
  /** Quiet or paused work: faded while closed, full strength once opened to be read. */
  dimmed?: boolean
  offline?: boolean
  questions: Record<string, QuestionSpec>
  answers: Record<string, AnswerPhase>
  onAnswer: OnAnswer
  /** Dismisses a missed question (POST /api/devices/self/questions/:id/dismiss). */
  onDismiss?: (questionId: string) => void | boolean | Promise<void | boolean>
  onToggle: () => void
  /** Opened inside a row group, which draws the surface. */
  grouped?: boolean
  /** The owner's opened rounds and steps; the host keeps them so they survive closing the card. */
  planState?: PlanState
  onPlanState?: (state: PlanState) => void
}

export function WorkCard({ row, voice, hero = false, expanded = false, dimmed = false, offline = false, questions, answers, onAnswer, onDismiss, onToggle, grouped = false, planState, onPlanState }: CardProps) {
  const color = toneColor(row.tone)
  const spec = row.questionId ? questions[row.questionId] : undefined
  const bar = rowBar(row)
  const { local } = useReloMode()
  const facts = cardFacts(row, spec, bar !== null, local)
  const [dismissError, setDismissError] = useState<string | null>(null)
  const dismiss = () => {
    if (!row.questionId || !onDismiss) return
    setDismissError(null)
    // A refusal (false, or a rejected promise) is said on the card; the Mac drops the missed question silently.
    void Promise.resolve()
      .then(() => onDismiss(row.questionId!))
      .then((ok) => ok === false && setDismissError(DISMISS_FAILED))
      .catch(() => setDismissError(DISMISS_FAILED))
  }
  const [localPlan, setLocalPlan] = useState<PlanState>(NEW_PLAN_STATE)
  const plan = planState ?? localPlan
  const setPlan = onPlanState ?? setLocalPlan
  const needsYou = row.tone === "needsYou"
  const insets = METRICS.insetY * 2
  const title = row.unreadable ? untitled(local) : (readableName(row.title) ?? "Untitled")
  // "Cut and whole text cross-fade in place" (`.id(open)` with `.transition(.opacity)` inside the toggle's `withAnimation(snappy)`).
  // The leaving text stays (popped out of the flow at its place) while the other fades in: never a blank between them.
  const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: SPRINGS.snappy }

  return (
    <motion.div
      animate={{ height: expanded ? "auto" : METRICS.cardHeight, opacity: dimmed && !expanded ? 0.6 : 1 }}
      initial={false}
      transition={{ height: SPRINGS.snappy, opacity: EASES.base }}
      onClick={onToggle}
      className="ro-card"
      data-grouped={grouped ? "" : undefined}
      style={{
        ["--tone" as string]: color,
        borderRadius: grouped ? 0 : METRICS.radius,
        overflow: "hidden",
        cursor: "pointer",
        background: grouped ? undefined : needsYou ? `linear-gradient(180deg, color-mix(in srgb, ${color} 12%, transparent), color-mix(in srgb, ${color} 3%, transparent))` : METRICS.fill,
        boxShadow: grouped ? undefined : `inset 0 0 0 1px ${needsYou ? `color-mix(in srgb, ${color} 32%, transparent)` : METRICS.border}`,
        transition: "background .26s ease-in-out, box-shadow .26s ease-in-out",
      }}
    >
      <div style={{ padding: `${METRICS.insetY}px ${METRICS.insetX}px` }}>
        <div style={{ display: "flex", flexDirection: "column", minHeight: METRICS.cardHeight - insets }}>
          <div style={{ display: "flex", flexDirection: "column", gap: METRICS.lineGap }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
              <Origin row={row} />
              <span style={{ display: "flex", flex: "none", alignItems: "center", gap: 6 }}>
                {voice && <CardPlay row={row} voice={voice} />}
                <StateBadge row={row} label={facts.badge} live={row.tone === "working" && !facts.showsBar} />
              </span>
            </div>
            <div style={{ position: "relative", display: "flex", alignItems: "baseline", gap: 5 }}>
              {row.unreadable && <span style={{ color: COLORS.yellow, display: "grid", alignSelf: "center" }}><Lock size={10} /></span>}
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  key={`t${expanded}`}
                  {...fade}
                  style={{ fontSize: hero ? FONT.hero : FONT.title, fontWeight: 600, lineHeight: 1.25, color: row.unreadable ? COLORS.secondaryText : "#fff", minWidth: 0, ...(expanded ? { overflowWrap: "anywhere" } : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }) }}
                >
                  {title}
                </motion.span>
              </AnimatePresence>
            </div>
            {facts.bodyText && (
              <div style={{ position: "relative" }}>
                <AnimatePresence initial={false} mode="popLayout">
                  <motion.div
                    key={`b${expanded}`}
                    {...fade}
                    style={{ fontSize: FONT.status, lineHeight: 1.3, color: COLORS.secondaryText, ...(expanded ? { overflowWrap: "anywhere" } : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }) }}
                  >
                    {facts.bodyText}
                  </motion.div>
                </AnimatePresence>
              </div>
            )}
          </div>
          <div style={{ flex: 1, minHeight: METRICS.lineGap }} />
          <div style={{ display: "flex", flexDirection: "column", gap: METRICS.lineGap }}>
            {facts.showsBar && bar && <PlanBarView bar={bar} color={color} />}
            <div style={{ display: "flex", height: METRICS.footerHeight, alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: FONT.meta, color: COLORS.tertiaryText }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {facts.planCaption ?? ((row.questionPending || row.questionMissed) && <span className="tabular-nums">{timeOf(row.declaredAt)}</span>)}
              </span>
              {facts.footer === "answer" && row.questionId ? (
                <AnswerBar interactionId={row.questionId} spec={spec} phase={answers[row.questionId]} offline={offline} onAnswer={onAnswer} />
              ) : facts.footer === "dismiss" && row.questionId ? (
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {dismissError && <span role="alert" style={{ fontSize: 11, whiteSpace: "nowrap", color: COLORS.yellow }}>{dismissError}</span>}
                  <Pill disabled={offline || !onDismiss} onClick={dismiss}>Dismiss</Pill>
                </span>
              ) : (
                <span style={{ display: "flex", flex: "none", alignItems: "center", gap: 6 }}>
                  {row.computerIcon && <ComputerIcon name={row.computerIcon} size={11} />}
                  {row.tone === "working" ? <Elapsed since={row.startedAt} /> : <span className="tabular-nums">{timeOf(row.declaredAt)}</span>}
                </span>
              )}
            </div>
          </div>
        </div>
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div key="detail" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={SPRINGS.snappy} style={{ paddingTop: METRICS.lineGap, display: "flex", flexDirection: "column", gap: METRICS.lineGap }}>
              {row.roundOutcome && row.roundOutcome !== row.status && !(row.outline && hasRoundSections(row.outline)) && (
                <div style={{ fontSize: FONT.status, color: COLORS.secondaryText }}>{row.roundOutcome}</div>
              )}
              <div style={{ marginTop: 4, paddingTop: 10, borderTop: "0.5px solid rgb(255 255 255 / 0.06)" }} onClick={(e) => e.stopPropagation()}>
                <PlanSteps row={row} state={plan} onState={setPlan} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

/** Finished work, as History shows it: one line, the state's symbol, the title, the project, the time. */
export function CompactRow({ row, onToggle }: { row: Row; onToggle: () => void }) {
  const { local } = useReloMode()
  const color = toneColor(row.tone)
  const project = readableName(row.project)
  return (
    <div className="ro-row" style={{ display: "flex", height: METRICS.rowHeight, cursor: "pointer", alignItems: "center", gap: 8, padding: "0 12px" }} onClick={onToggle}>
      <span style={{ display: "grid", width: 16, height: 16, flex: "none", placeItems: "center", borderRadius: "50%", color, background: `color-mix(in srgb, ${color} 15%, transparent)` }}>
        <ToneIcon tone={row.tone} size={9} />
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 500, color: row.unreadable ? COLORS.secondaryText : "#fff" }}>{row.unreadable ? untitled(local) : (readableName(row.title) ?? "Untitled")}</span>
      {project && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: FONT.meta, color: COLORS.tertiaryText }}>{project}</span>}
      <span className="tabular-nums" style={{ marginLeft: "auto", flex: "none", fontSize: FONT.meta, color: COLORS.tertiaryText }}>{timeOf(row.declaredAt)}</span>
    </div>
  )
}
