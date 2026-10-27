// Relo's main window (Mac: ReloHomeView.swift): whether this PC is connected, what needs you and what runs, and the ways
// in (the notch, the Dashboard, Settings). The notch stays the live surface; this is where someone who opened "the app"
// lands. No native title band: the content runs up under a custom title area (src/chrome/TitleBar.tsx) like the Mac's
// full-size content view, over the window's Acrylic backdrop. Layout: an aside (the Now deck as the iPhone draws it,
// then the computers and their sessions) and the notch's sections in one column, whose cards open like the notch's.

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { inTauri } from "../bridge"
import { TitleBar } from "../chrome/TitleBar"
import { loadSnapshot } from "../relo/fixtures"
import { machinesOf, presentationOf, sectionTitle, isFolded, type Machine, type Row, type Section } from "../relo/presentation"
import { snapshotName } from "../relo/useRelo"
import { CompactRow as ReloCompactRow, WorkCard as ReloWorkCard } from "../relo/ui/Card"
import { ReloModeContext, type ReloMode } from "../relo/ui/mode"
import { NEW_PLAN_STATE, type PlanState } from "../relo/ui/open/PlanDeck"
import { PlasmaOrb } from "../relo/visual/PlasmaOrb"
import { COLORS, toneColor } from "../relo/ui/theme"
import { useSettings } from "../settings/store"
import { deckInput, leadOf } from "./deck"
import { DeckWash, NowDeck } from "./NowDeck"
import {
  checkResultLine,
  INITIAL_HOME,
  LOCAL_LABEL,
  localProblemText,
  machineCountLabel,
  readable,
  screenOf,
  sessionCountLabel,
  subline,
  runningCount,
  syncLabel,
  updateBanner,
  type HomeNotice,
  type HomeState,
} from "./state"

const tint = (color: string): CSSProperties => ({ ["--tone" as string]: color })
const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
const noop = () => {}
const NO_QUESTIONS = {}

/** The state to show: what the notch published (Rust relays it), or a fixture with `?snapshot=<name>` in a browser. */
function useHomeState(): HomeState {
  const [state, setState] = useState<HomeState>(() => {
    const name = snapshotName()
    const snap = name ? loadSnapshot(name) : null
    return snap ? { ...INITIAL_HOME, connection: "live", lastUpdated: Date.now(), serverHost: "relo.example.com", dashboard: true, summary: snap.summary } : INITIAL_HOME
  })
  useEffect(() => {
    if (!inTauri) return
    let alive = true
    void invoke<HomeState | null>("home_state_get").then((s) => alive && s && setState(s)).catch(() => {})
    const off = listen<HomeState>("home_state", (e) => setState(e.payload))
    return () => {
      alive = false
      void off.then((f) => f())
    }
  }, [])
  return state
}

/** Dev only: `?glass=sim` in a browser stands in for the Acrylic desktop blur (the TitleBar sets data-glass in the app). */
function useGlass() {
  useEffect(() => {
    if (import.meta.env.DEV && !inTauri && new URLSearchParams(location.search).get("glass") === "sim") document.documentElement.dataset.glass = "sim"
  }, [])
}

export function HomeApp() {
  const state = useHomeState()
  useGlass()
  // The app's Reduce Motion setting: the CSS stops every animation under data-reduce-motion (the OS setting is the media query).
  const { settings } = useSettings()
  useEffect(() => {
    document.documentElement.toggleAttribute("data-reduce-motion", settings.reduceMotion)
  }, [settings.reduceMotion])
  const screen = screenOf(state)
  // Not set up: the onboarding does it, so Home hands over to it (the Mac orders the window out and posts needsSetup).
  useEffect(() => {
    if (screen !== "needsSetup" || state.connection !== "signedOut" || !inTauri) return
    void invoke("open_settings", { page: "onboarding" }).catch(() => {})
    void invoke("close_home").catch(() => {})
  }, [screen, state.connection])
  const presentation = useMemo(() => presentationOf(state.summary), [state.summary])
  const input = useMemo(() => deckInput(presentation, state.connection, state.lastUpdated), [presentation, state.connection, state.lastUpdated])
  const lead = leadOf(input)
  const [note, setNote] = useState<string | null>(null)
  const showNote = (line: string) => {
    setNote(line)
    window.setTimeout(() => setNote((n) => (n === line ? null : n)), 5000)
  }
  // Relo on this PC has no server: the cards read as local, no Dashboard link.
  const mode = useMemo<ReloMode>(() => ({ local: state.local, openDashboard: null, openHome: noop }), [state.local])
  return (
    <ReloModeContext.Provider value={mode}>
      <div className="home" data-lead={lead}>
        <div className="home-backdrop" />
        {screen === "work" && <DeckWash lead={lead} />}
        {screen === "work" ? (
          <div className="home-body">
            <Aside state={state} presentation={presentation} />
            <Work state={state} presentation={presentation} />
          </div>
        ) : screen === "localProblem" ? (
          <LocalProblem problem={state.localProblem} />
        ) : (
          <div className="home-center">
            <Orb size={140} />
          </div>
        )}
        <UpdateBanner state={state} note={note} />
        <TitleBar title="Relo">
          <div className="home-tb">
            <SyncPill state={state} />
            <div className="home-tb-actions">
              <Actions state={state} onNote={showNote} />
            </div>
          </div>
        </TitleBar>
      </div>
    </ReloModeContext.Provider>
  )
}

// ---- Title area (ReloHomeToolbar): the sync chip at the leading end, the actions before the caption buttons ----

function SyncPill({ state }: { state: HomeState }) {
  const offline = state.connection === "offline"
  const label = syncLabel(state, time)
  return (
    <div className="home-sync glass-pill" title={label}>
      {offline ? <span className="warn-dot" /> : <LiveDot color={COLORS.done} live={state.lastUpdated !== null} />}
      <span>{label}</span>
    </div>
  )
}

function Actions({ state, onNote }: { state: HomeState; onNote: (line: string) => void }) {
  const [checking, setChecking] = useState(false)
  // "Check for Updates..." (ReloHomeToolbar): the same check as Settings; a found update shows as the banner.
  const checkUpdates = () => {
    if (!inTauri || checking) return
    setChecking(true)
    void invoke<{ state: string; message?: string | null }>("updater_check_manual")
      .then((r) => {
        const line = checkResultLine(r.state, r.message)
        if (line) onNote(line)
      })
      .catch(() => onNote("Couldn't check for updates"))
      .finally(() => setChecking(false))
  }
  const call = (cmd: string, args?: Record<string, unknown>) => () => {
    if (inTauri) void invoke(cmd, args).catch(() => {})
  }
  return (
    <>
      <button className="home-btn glass-pill" onClick={call("home_open_notch")} title="Open in Notch (Ctrl+Shift+I)">
        <NotchGlyph />
        <span className="home-btn-label">Open in Notch</span>
        <span className="home-hint">Ctrl+Shift+I</span>
      </button>
      {!state.local && state.dashboard && (
        <IconButton label="Open the Dashboard" onClick={call("home_open_dashboard")}>
          <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM10.4 5.6L9 9 5.6 10.4 7 7z" />
        </IconButton>
      )}
      <IconButton label={checking ? "Checking for updates" : "Check for Updates"} onClick={checkUpdates}>
        <path d="M13.5 8a5.5 5.5 0 11-1.8-4.1M13.5 2.2v3h-3" strokeLinecap="round" />
      </IconButton>
      <IconButton label="Settings" onClick={call("open_settings", {})}>
        <path d="M6.7 1.6h2.6l.4 1.7 1.2.7 1.6-.6 1.3 2.2-1.2 1.2v1.4l1.2 1.2-1.3 2.2-1.6-.6-1.2.7-.4 1.7H6.7l-.4-1.7-1.2-.7-1.6.6-1.3-2.2 1.2-1.2V7.2L2.2 6l1.3-2.2 1.6.6 1.2-.7zM8 6.2a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6z" />
      </IconButton>
    </>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button className="home-icon glass-pill" onClick={onClick} title={label} aria-label={label}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </button>
  )
}

function NotchGlyph() {
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden>
      <rect x="0.7" y="0.7" width="12.6" height="10.6" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M0.7 3.2h12.6V1.8a1.1 1.1 0 00-1.1-1.1H1.8a1.1 1.1 0 00-1.1 1.1z" fill="currentColor" />
    </svg>
  )
}

function LiveDot({ color, live }: { color: string; live: boolean }) {
  return <span className="live-dot" data-live={live ? "" : undefined} style={{ background: color, color }} />
}

// ---- Aside ----

function Aside({ state, presentation }: { state: HomeState; presentation: ReturnType<typeof presentationOf> }) {
  const input = deckInput(presentation, state.connection, state.lastUpdated)
  const machines = useMemo(() => machinesOf(presentation), [presentation])
  const live = presentation.sessions.filter((s) => s.phase !== "ended").length
  const sentence = subline(presentation, runningCount(presentation))
  return (
    <aside className="home-aside">
      <NowDeck presentation={presentation} input={input} />
      <p className="home-sentence" title={sentence}>
        {sentence}
      </p>
      <section className="home-sessions glass">
        <div className="home-sessions-head">
          <SectionHeader title="Sessions" count={live} color={COLORS.secondaryText} />
          {machines.length > 0 && <span className="home-machine-count">{machineCountLabel(machines.length)}</span>}
        </div>
        {machines.length === 0 ? (
          <p className="home-empty-line">No session is open right now.</p>
        ) : (
          machines.slice(0, 5).map((m) => <MachineRow key={m.name} machine={m} />)
        )}
        <div className="home-grow" />
        {state.local ? (
          <div className="home-foot" title={LOCAL_LABEL}>
            <LaptopGlyph /> <span>{LOCAL_LABEL}</span>
          </div>
        ) : state.serverHost ? (
          <div className="home-foot home-mono" title={state.serverHost}>
            <LockGlyph /> <span>{state.serverHost}</span>
          </div>
        ) : null}
      </section>
    </aside>
  )
}

function SectionHeader({ title, count, color }: { title: string; count?: number; color: string }) {
  return (
    <h2 className="sec-head" style={{ color }}>
      <span>{title.toUpperCase()}</span>
      {count !== undefined && <span style={{ opacity: 0.7 }}>{count}</span>}
      <span className="sec-line" style={{ background: `linear-gradient(90deg, ${color}66, transparent)` }} />
    </h2>
  )
}

function MachineRow({ machine }: { machine: Machine }) {
  const working = machine.working > 0
  const waiting = machine.waiting > 0
  const hot = working || waiting
  const color = waiting ? COLORS.signalCoral : working ? COLORS.running : COLORS.secondaryText
  const name = readable(machine.name) ?? "A computer"
  const harnesses = machine.harnesses.map((h) => `${h.source} · ${sessionCountLabel(h.total)}`)
  return (
    <div className="machine" style={tint(color)} title={[name, ...harnesses].join("\n")}>
      <span className="machine-tile glass-sm" data-hot={hot ? "" : undefined}>
        <LaptopGlyph />
      </span>
      <div className="machine-main">
        <div className="machine-name">{name}</div>
        <div className="machine-sub">
          {harnesses.slice(0, 3).map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
      </div>
      <div className="machine-state" data-hot={hot ? "" : undefined}>
        {waiting ? (
          <>
            <i /> <span>Waiting on you</span>
          </>
        ) : working ? (
          <>
            <Wave /> <span>Working</span>
          </>
        ) : (
          <>
            <i className="idle" /> <span>Idle</span>
          </>
        )}
      </div>
    </div>
  )
}

function Wave() {
  return (
    <svg width="11" height="10" viewBox="0 0 11 10" className="wave" aria-hidden>
      {[1, 3.4, 5.8, 8.2].map((x, i) => (
        <rect key={x} x={x} y="1" width="1.4" height="8" rx="0.7" fill="currentColor" style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </svg>
  )
}

function LaptopGlyph() {
  return (
    <svg width="15" height="12" viewBox="0 0 15 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
      <rect x="2.2" y="0.8" width="10.6" height="7.4" rx="1.2" />
      <path d="M0.8 10.6h13.4" strokeLinecap="round" />
    </svg>
  )
}

function LockGlyph() {
  return (
    <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden>
      <rect x="0.5" y="4" width="8" height="5.5" rx="1.3" fill="currentColor" />
      <path d="M2.2 4V3a2.3 2.3 0 014.6 0v1" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

/** The plasma sphere alone, for the screens that have no deck (local trouble, hand-over to onboarding). */
function Orb({ size }: { size: number }) {
  return (
    <div className="orb-solo" aria-hidden>
      <PlasmaOrb mood="clear" size={size} />
    </div>
  )
}

// ---- Work ----

function Work({ state, presentation }: { state: HomeState; presentation: ReturnType<typeof presentationOf> }) {
  const sections = presentation.sections.filter((s) => !isFolded(s.kind) && s.rows.length > 0)
  const notices: HomeNotice[] = state.notices ?? []
  // Dev only (`?expand=<n>` in a browser): the n-th card starts open, for screenshots.
  const [expanded, setExpanded] = useState<string | null>(() => {
    const param = import.meta.env.DEV && !inTauri ? new URLSearchParams(location.search).get("expand") : null
    const n = param === null ? NaN : Number(param)
    return Number.isFinite(n) ? (sections.flatMap((s) => (s.kind === "recent" ? [] : s.rows)).at(n)?.id ?? null) : null
  })
  // The owner's opened rounds and steps survive closing a card.
  const [plans, setPlans] = useState<Record<string, PlanState>>({})
  const toggle = (id: string) => setExpanded((e) => (e === id ? null : id))
  if (sections.length === 0 && notices.length === 0) {
    return (
      <main className="home-work home-work-empty">
        <h2>Nothing needs you</h2>
        <p>Work from your sessions and scripts shows up here and in the notch, live.</p>
      </main>
    )
  }
  return (
    <main className="home-work">
      <div className="home-scroll">
        {presentation.sinceYouLooked && (
          <div className="pill glass-pill" title={`Since you looked: ${presentation.sinceYouLooked}`}>
            <ClockGlyph /> <span>Since you looked: {presentation.sinceYouLooked}</span>
          </div>
        )}
        {presentation.hasUnreadable && !state.local && (
          <div className="pill pill-warn glass-pill">
            <LockGlyph /> <span>Approve this PC on your iPhone to read private work</span>
          </div>
        )}
        {sections.map((section) => (
          <SectionBlock
            key={section.kind}
            section={section}
            expanded={expanded}
            toggle={toggle}
            offline={state.connection === "offline"}
            plans={plans}
            setPlan={(id, p) => setPlans((all) => ({ ...all, [id]: p }))}
          />
        ))}
        {notices.length > 0 && (
          <div className="sec">
            <SectionHeader title="Recent notices" count={notices.length} color={COLORS.secondaryText} />
            <div className="group glass">
              {notices.map((n) => (
                <NoticeRow key={n.id} notice={n} />
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  )
}

interface PlanProps {
  plans: Record<string, PlanState>
  setPlan: (id: string, p: PlanState) => void
}

function SectionBlock({ section, expanded, toggle, offline, plans, setPlan }: { section: Section; expanded: string | null; toggle: (id: string) => void; offline: boolean } & PlanProps) {
  const tone = sectionTone(section)
  const base = toneColor(tone)
  return (
    <div className="sec">
      <SectionHeader title={sectionTitle(section.kind)} count={section.rows.length} color={base} />
      {section.kind === "recent" ? (
        <div className="group glass">
          {section.rows.slice(0, 6).map((row) =>
            expanded === row.id ? (
              <Card key={row.id} row={row} expanded grouped offline={offline} onToggle={() => toggle(row.id)} plans={plans} setPlan={setPlan} />
            ) : (
              <ReloCompactRow key={row.id} row={row} onToggle={() => toggle(row.id)} />
            ),
          )}
        </div>
      ) : (
        section.rows.slice(0, 8).map((row) => (
          <Card key={row.id} row={row} hero={section.kind === "needsYou"} dimmed={isFolded(section.kind)} expanded={expanded === row.id} offline={offline} onToggle={() => toggle(row.id)} plans={plans} setPlan={setPlan} />
        ))
      )}
    </div>
  )
}

function sectionTone(section: Section) {
  switch (section.kind) {
    case "needsYou":
    case "waitingOnYou":
      return "needsYou" as const
    case "running":
      return "working" as const
    case "recent":
      return "done" as const
    case "quiet":
      return "quiet" as const
    case "paused":
      return "paused" as const
  }
}

/** The notch's card, read-only: Home has no answer keys, so a waiting question points at the notch. */
function Card({ row, hero = false, dimmed = false, expanded, grouped = false, offline, onToggle, plans, setPlan }: { row: Row; hero?: boolean; dimmed?: boolean; expanded: boolean; grouped?: boolean; offline: boolean; onToggle: () => void } & PlanProps) {
  const color = toneColor(row.tone)
  const lit = row.tone === "working" || row.tone === "needsYou" || row.tone === "yourTurn"
  const asks = row.questionPending
  // Without the question id the card draws its facts (time, computer) instead of an answer bar.
  const shown = useMemo(() => (asks ? { ...row, questionId: null, questionPending: false } : row), [row, asks])
  const card = (
    <ReloWorkCard
      row={shown}
      hero={hero}
      dimmed={dimmed}
      grouped={grouped}
      expanded={expanded}
      offline={offline}
      questions={NO_QUESTIONS}
      answers={NO_QUESTIONS}
      onAnswer={noop}
      onToggle={onToggle}
      planState={plans[row.id] ?? NEW_PLAN_STATE}
      onPlanState={(p) => setPlan(row.id, p)}
    />
  )
  if (grouped) return card
  return (
    <div className="wc" data-lit={lit ? "" : undefined} data-urgent={row.tone === "needsYou" ? "" : undefined} style={tint(color)}>
      {card}
      {asks && (
        <button
          className="wc-answer glass-pill"
          disabled={offline}
          onClick={() => inTauri && void invoke("home_open_notch").catch(() => {})}
          title={offline ? "Offline" : "Answer in the notch"}
        >
          Answer in the notch
        </button>
      )}
    </div>
  )
}

function NoticeRow({ notice }: { notice: HomeNotice }) {
  const title = readable(notice.title) ?? notice.title
  return (
    <div className="notice">
      <BellGlyph />
      <div className="notice-main">
        <div className="notice-title" title={title}>{title}</div>
        {notice.summary && <div className="notice-summary" title={notice.summary}>{notice.summary}</div>}
        {readable(notice.source) && <div className="notice-source">{notice.source}</div>}
      </div>
      <span className="notice-time">{time(notice.createdAt)}</span>
    </div>
  )
}

function BellGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke={COLORS.runningSoft} strokeWidth="1.2" aria-hidden>
      <path d="M3 8.5V5.2a3 3 0 016 0v3.3l.8 1H2.2zM5 10.8a1 1 0 002 0" strokeLinejoin="round" />
    </svg>
  )
}

function ClockGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
      <circle cx="6" cy="6" r="4.8" />
      <path d="M6 3.2V6l2 1.2" strokeLinecap="round" />
    </svg>
  )
}

function LocalProblem({ problem }: { problem: HomeState["localProblem"] }) {
  const text = localProblemText(problem)
  const starting = problem !== "failed" && problem !== "repair"
  const [working, setWorking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const primary = useRef<HTMLButtonElement>(null)
  useEffect(() => primary.current?.focus(), [starting])
  // "Try again" starts Relo again; "Repair" links again (ReloLocalPanels.swift:act). The notch republishes the new state.
  const act = () => {
    if (!inTauri || working) return
    setWorking(true)
    setFailure(null)
    const run = problem === "failed" ? invoke("local_start").then(() => null as string | null) : invoke<string | null>("local_repair")
    void run
      .then((f) => setFailure(f ?? null))
      .catch((e) => setFailure(typeof e === "string" ? e : "Relo is still not running."))
      .finally(() => setWorking(false))
  }
  return (
    <div className="home-center">
      <Orb size={140} />
      <h1 className="home-wordmark">Relo</h1>
      <h2 className="home-problem-title">{text.title}</h2>
      {!starting && <p className="home-problem-detail">{text.detail}</p>}
      {failure && (
        <>
          <p className="home-failure">{failure}</p>
          <button className="home-link" onClick={() => inTauri && void invoke("local_show_logs").catch(() => {})}>
            Show details
          </button>
        </>
      )}
      {starting ? (
        <span className="home-spinner" role="status" aria-label="Starting Relo" />
      ) : (
        <button ref={primary} className="home-primary" disabled={working} onClick={act}>
          {working ? "Working…" : problem === "failed" ? "Try again" : "Repair"}
        </button>
      )}
    </div>
  )
}

// ---- Update banner (ReloUpdateBanner, ReloUpdater.swift:192-220) ----

function UpdateBanner({ state, note }: { state: HomeState; note: string | null }) {
  const banner = updateBanner(state)
  const version = state.update?.version ?? state.updateVersion ?? null
  const [later, setLater] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (banner && (banner.critical || later !== version)) return <Banner banner={banner} onLater={() => setLater(version)} busy={busy} setBusy={setBusy} />
  const line = note ?? state.updatedLine
  return line ? <div className="home-update" role="status">{line}</div> : null
}

function Banner({ banner, onLater, busy, setBusy }: { banner: NonNullable<ReturnType<typeof updateBanner>>; onLater: () => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const install = () => {
    if (!inTauri || busy) return
    setBusy(true)
    void invoke("updater_install").catch(() => {}).finally(() => setBusy(false))
  }
  return (
    <div className="home-banner" role="status" data-critical={banner.critical ? "" : undefined}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 4.8v5.2M5.7 8.2L8 10.5l2.3-2.3" />
      </svg>
      <span>{banner.text}</span>
      {!banner.critical && (
        <button className="pill-btn" onClick={onLater}>
          Later
        </button>
      )}
      <button className="pill-btn" data-prominent="" disabled={busy} onClick={install}>
        {busy ? "Working…" : banner.action}
      </button>
    </div>
  )
}
