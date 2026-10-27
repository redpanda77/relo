// The notch (apps/notch ContentView.swift): one black shape that morphs between closed and open on springs, the closed
// card inside it while closed, and while open the header (tabs, settings) over the selected tab. The shape's outline,
// radii, springs, content transition, hover rules and "remember last tab" follow the Mac; the hot rect Rust hit-tests
// against is reported on every animation frame.
//
// This file wires the parts together (each is built and tested on its own):
//   closed   Relo's wings, or the music activity when Relo has nothing live (relo/notchState.ts closedContent), or the
//            peek: the notch grown into a card for an update (relo/ui/peek, driven by the wings' moments)
//   open     the header and the tab the owner chose (relo/tabs.ts: Relo, System, Music, Shelf)
//   events   `shortcut` and `notch_gesture` from Rust, the shelf's drag, the owner client's sign-in and tray actions
//   Home     the state the Home window shows is published whenever it changes (home/state.ts)

import { animate, AnimatePresence, motion, useMotionValue, useMotionValueEvent, useTransform } from "motion/react"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from "react"
import { inTauri, onPointer, onQuitRequest, openUrl, quitReady, setDisplay, setHot, setKeyboard, startedAtLogin } from "./bridge"
import { invoke } from "@tauri-apps/api/core"
import { OwnerBar } from "./client/OwnerBar"
import { useOwner } from "./client/useOwner"
import { onNotchGesture } from "./gestures"
import {
  CLOSE_SPRING,
  CLOSED,
  CONTENT_BOTTOM,
  CONTENT_INSET,
  CONTENT_SCALE_FROM,
  CONTENT_OUT,
  CONTENT_SPRING,
  HEADER_GAP,
  HOVER_CLOSE_DELAY_MS,
  OPEN_BASE,
  OPEN_SPRING,
  RESIZE_SPRING,
  WINDOW_W,
  tabOpenHeight,
  outline,
  reloOpenHeight,
  sameRect,
  toHotRect,
  type HotRect,
} from "./geometry"
import type { EventKind } from "./relo/events"
import { INITIAL_HOME, publishHome, type HomeConnection, type HomeState } from "./home/state"
import { useLocalState } from "./local/api"
import { closedLine, LocalPanel, problemOf, type Problem } from "./local/LocalPanel"
import { ClosedMusic, closedMusicShape, SneakPeekStrip, useClosedMusic } from "./music"
import { useHideForFullscreen } from "./music/fullscreen"
import { onShelfDragEnter, shelfOpensByDefault } from "./relo/builtinTabs"
import { closedContent, closedHeightOf, extendedRect, fitsContent, gestureEffect, gestureFeedback, NO_FEEDBACK, rememberLastTabOf, shortcutEffect } from "./relo/notchState"
import { ONBOARDING_ROW_ID } from "./relo/onboarding"
import { useOnboardingStage } from "./relo/useOnboardingStage"
import { dashboardUrl, ReloModeContext, type ReloMode } from "./relo/ui/mode"
import { getTab, isTabVisible, subscribeVisibleTabs, tabOnOpen, visibleTabsKey, type TabViewProps } from "./relo/tabs"
import { ClosedActivity, closedWidth, isLive, ringColors } from "./relo/ui/ClosedActivity"
import { Connect } from "./relo/ui/Connect"
import { Header } from "./relo/ui/open/Header"
import { expandingView, mayOpenOnHover, sneakPeek, useExpandingView, useSneakPeek } from "./relo/ui/open/sneak"
import { REDUCED, SPRINGS } from "./relo/ui/open/tokens"
import { Panel } from "./relo/ui/Panel"
import { PeekHost } from "./relo/ui/peek/Peek"
import { PEEK_WIDTH } from "./relo/ui/peek/logic"
import { usePeek } from "./relo/ui/peek/usePeek"
import { COLORS } from "./relo/ui/theme"
import { useRelo, type ReloInput } from "./relo/useRelo"
import { openSettings } from "./settings/ipc"
import { useSettings } from "./settings/store"
import { onShortcut } from "./shortcuts"
import { useAlerts } from "./alerts"
import { answerQuitRequests, cueLaunchOnce } from "./alerts/lifecycle"
import { cuePlayer } from "./sound"

/** Dev: `?open=1` holds the notch open (a browser has no Rust to report the cursor); `?tab=` picks the tab. */
const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams()
const FORCE_OPEN = params.get("open") === "1"
const FORCE_TAB = params.get("tab")
const DEV_PEEK = params.get("peekKind")
/** The wheel going quiet this long ends a gesture (gestures.rs IDLE_RESET) and the notch settles back to its size. */
const GESTURE_IDLE_MS = 400
/** How long a failure, update, approval or notice holds the notch open by itself (the Mac's peek). */
const PEEK_MS = 8000
/** The expanded card is 440 wide and the notch pads it by its bottom corner radius (14) on each side. */
const PEEK_NOTCH_W = PEEK_WIDTH + 28

export type NotchProps = ReloInput & {
  /** Dismisses a missed question: POST /api/devices/self/questions/:id/dismiss (the owner client's, by default). */
  onDismiss?: (questionId: string) => void
}

function Placeholder({ label }: { label: string }) {
  return <div className="grid h-full place-items-center text-[12px]" style={{ color: COLORS.tertiaryText }}>{label}</div>
}

const homeConnection = (c: string): HomeConnection => (c === "live" || c === "offline" || c === "connecting" || c === "starting" ? c : "signedOut")

/** Local mode's trouble as Home words it (its "not answering" is a failure to start for Home's purposes: Try again). */
const homeProblem = (p: Problem | null): HomeState["localProblem"] => (p === "startFailed" || p === "notAnswering" ? "failed" : p === "needsRepair" ? "repair" : p === "starting" ? "starting" : null)

export function Notch({ onDismiss, ...props }: NotchProps = {}) {
  // Live data comes from the owner client; in snapshot mode it is inert and useRelo shows the fixture. Props override both.
  const owner = useOwner()
  const reloLive = useRelo({ ...owner.input, ...props })
  // The onboarding in the notch (Settings emits `onboarding_stage`): one staged work, never a server card (ReloOnboardingNotch).
  const onboarding = useOnboardingStage()
  const staged = onboarding.presentation !== null
  const relo = useMemo(
    () => (onboarding.presentation ? { ...reloLive, presentation: onboarding.presentation, hasData: true, offline: false, questions: {}, answers: {} } : reloLive),
    [reloLive, onboarding.presentation],
  )
  // Sounds, voice, interface cues and the quiet rules (src/alerts): called once; the rows it returns carry the spoken words.
  const alertsOwner = useMemo(
    () => ({ view: { ...owner.view, arrivals: owner.view.arrivals, questions: Object.fromEntries(Object.entries(owner.view.questions).flatMap(([id, q]) => (q.prompt ? [[id, { prompt: q.prompt }]] : []))) } }),
    [owner.view],
  )
  const alerts = useAlerts({
    presentation: relo.presentation,
    hasData: relo.hasData,
    owner: alertsOwner,
    // The staged onboarding plays every moment (only the master switch gates it), repeats them, and says nothing.
    events: staged ? { staged: true, stagedRowId: ONBOARDING_ROW_ID } : null,
  })
  const presentation = alerts.presentation
  const { settings, update, loaded } = useSettings()
  const dismiss = onDismiss ?? relo.onDismiss
  // The card's play button: only with "Show a play button on cards" on, and only on a card that has a line to say.
  const cardVoice = settings.voiceButton ? { canPlay: alerts.canPlay, play: alerts.playCard } : undefined
  // Relo on this PC: with nothing to show the notch says "Starting Relo…", or that it needs a repair, with one button.
  const local = useLocalState()
  const localMode = owner.enabled && local.mode
  const localProblem = localMode && !relo.hasData ? problemOf(local, owner.view.connection) : null
  // Where Relo runs, for the words and links of the open views (Dashboard: the server's page; Home: "+N more", "Open Relo").
  const serverOrigin = owner.view.serverOrigin
  const mode = useMemo<ReloMode>(() => {
    const url = localMode ? null : dashboardUrl(serverOrigin)
    return {
      local: localMode,
      openDashboard: url ? () => void openUrl(url).catch(() => {}) : null,
      openHome: () => void (inTauri ? invoke("open_home").catch(() => {}) : Promise.resolve()),
    }
  }, [localMode, serverOrigin])
  const [open, setOpen] = useState(FORCE_OPEN)
  const [tab, setTab] = useState(FORCE_TAB ?? "relo")
  const [hovering, setHovering] = useState(false)
  const sneak = useSneakPeek()
  const expanding = useExpandingView()
  useSyncExternalStore(subscribeVisibleTabs, visibleTabsKey)
  // A text field (the server address) has the keyboard: the notch stays open while it does.
  const editing = useRef(false)
  const pointerInside = useRef(false)
  const [relo_, setReloFit] = useState({ listHeight: 0, showsList: false })
  // The owner bar (update, approvals, notices, failures) sits above the Relo tab and adds its own height.
  const [barH, setBarH] = useState(0)
  const [peekH, setPeekH] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const lastHot = useRef<HotRect | null>(null)
  const reduceMotion = settings.reduceMotion

  // ---- The closed notch: Relo, music, or plain ----
  const hide = useHideForFullscreen()
  const music = useClosedMusic({ hiddenForFullscreen: hide })
  const closedH = closedHeightOf(settings.notchHeight)
  // Nothing to show and the owner is needed: sign in (a server), or repair (Relo on this PC; not while it is only starting).
  const needsSignIn =
    owner.enabled && !relo.hasData && (localMode ? localProblem !== null && localProblem !== "starting" : owner.view.connection === "signedOut" || owner.view.connection === "needsSignIn")
  const live = (relo.hasData && isLive(presentation)) || needsSignIn
  const content = closedContent({ closedActivity: settings.closedActivity, live, musicActive: music.show, expanding, hidden: hide })
  // The line under the closed notch, once per launch for 8 s, when Relo has nothing to show and needs the owner.
  const closedHint = !needsSignIn ? null : localMode && localProblem ? closedLine(localProblem) : "Relo · hover here to sign in"
  const musicSneak = music.sneak || (expanding.show && expanding.type === "music")
  const musicShape = closedMusicShape({ closedWidth: CLOSED.w, closedHeight: closedH, sneak: musicSneak, style: music.settings.sneakPeekStyle })

  // ---- Moments become peeks: the notch grows into a card for an update ----
  const gate = {
    quiet: alerts.quiet() || content !== "relo",
    enabled: alerts.peekAllowed(),
    reduceMotion,
  }
  const peekCtl = usePeek({ gates: gate, presentation: presentation, arrivals: owner.view.arrivals, cursorOver: () => pointerInside.current })
  const peekShowing = peekCtl.snapshot.expanded !== null || peekCtl.snapshot.notice !== null
  const peeking = !open && content === "relo" && peekShowing && peekH > 0
  const rows = useMemo(() => presentation.sections.flatMap((s) => s.rows), [presentation])
  // Dev: `?peekKind=started|finished|failed|yourTurn|question` plays that update for the fixture's first card (screenshots).
  const firstRow = rows[0]
  useEffect(() => {
    if (!relo.snapshot || !DEV_PEEK || !firstRow) return
    peekCtl.controller.receive([{ kind: DEV_PEEK as EventKind, row: firstRow }])
  }, [relo.snapshot, firstRow, peekCtl.controller])

  const closed = (() => {
    const base = content === "relo" ? closedWidth(presentation, closedH) : content === "music" ? musicShape.width : CLOSED.w
    return { w: peeking ? Math.max(base, PEEK_NOTCH_W) : base, h: closedH + (peeking ? peekH : content === "music" ? musicShape.extraHeight : 0) }
  })()

  const w = useMotionValue(open ? OPEN_BASE.w : closed.w)
  const h = useMotionValue(open ? OPEN_BASE.h : closed.h)
  const top = useMotionValue(open ? OPEN_BASE.top : CLOSED.top)
  const bottom = useMotionValue(open ? OPEN_BASE.bottom : CLOSED.bottom)
  const d = useTransform([w, h, top, bottom], ([a, b, c, e]: number[]) => outline(a, b, c, e))
  /** What the open content may draw: the shape itself (ContentView `.clipShape(currentNotchShape)`), frame by frame. */
  const clip = useTransform(d, (v) => `path('${v}')`)
  // The open content's presence, 0..1, on its own spring: opening brings it in over the growing shape (scale .8 -> 1 from the
  // top, fade, the header un-blurring); closing takes it out FIRST and fast, so the shape collapses over an empty notch.
  // (ContentView: `.transition(.scale(0.8, anchor: .top).combined(with: .opacity).animation(.smooth(duration: 0.35)))`.)
  const reveal = useMotionValue(open ? 1 : 0)
  const [mounted, setMounted] = useState(open)
  const contentScale = useTransform(reveal, (v) => CONTENT_SCALE_FROM + (1 - CONTENT_SCALE_FROM) * v)
  const headerBlur = useTransform(reveal, (v) => `blur(${((1 - v) * 20).toFixed(2)}px)`)
  // The closed wings take over as the content leaves (cross-fade over the second half) and give way as it arrives.
  const wingsOpacity = useTransform(reveal, [0, 0.5], [1, 0])
  const openNow = useRef(open)
  openNow.current = open
  useMotionValueEvent(reveal, "change", (v) => {
    if (v <= 0.002 && !openNow.current) setMounted(false)
  })
  useEffect(() => {
    if (open) setMounted(true)
    const spring = reduceMotion ? REDUCED : open ? CONTENT_SPRING : CONTENT_OUT
    const run = animate(reveal, open ? 1 : 0, spring)
    return () => run.stop()
  }, [open, reduceMotion, reveal])

  // The open height: the Relo tab fits its list (reloOpenHeight), the others have a fixed one.
  // A tab that reports its height (the Shelf's `onFit`) is given it, clamped; the rest keep their fixed ones.
  const [tabFit, setTabFit] = useState<Record<string, number>>({})
  const tabFitters = useRef<Record<string, (height: number) => void>>({})
  const fitterFor = (id: string) =>
    (tabFitters.current[id] ??= (height: number) => setTabFit((s) => (s[id] === height ? s : { ...s, [id]: height })))
  // Every other tab opens at the Mac's fixed height (System 250, Music and Shelf 190): a view that reports one (the Shelf's 220) is not obeyed.
  const openHeight = tab === "relo" ? Math.min(430, reloOpenHeight(relo_.listHeight, relo_.showsList) + barH) : tabOpenHeight(getTab(tab)?.height ?? OPEN_BASE.h, fitsContent(tab) ? tabFit[tab] : undefined)
  const prev = useRef({ open: FORCE_OPEN, tab, openHeight, peeking: false })

  useEffect(() => {
    const was = prev.current
    // Closed, the wings set the width (ReloOrbitWings: 351 live, 275 at rest), not the bare hardware notch.
    const target = open ? { w: OPEN_BASE.w, h: openHeight, top: OPEN_BASE.top, bottom: OPEN_BASE.bottom } : { ...CLOSED, ...closed }
    // Opening and closing run ContentView's springs; a tab change resizes on its own spring; the list growing or
    // shrinking and the peek growing ride `snappy` (ReloMotion), the peek leaving `smooth`.
    const spring =
      was.open !== open ? (open ? OPEN_SPRING : CLOSE_SPRING)
      : was.tab !== tab ? RESIZE_SPRING
      : was.peeking && !peeking ? SPRINGS.smooth
      : SPRINGS.snappy
    const transition = reduceMotion ? REDUCED : spring
    animate(w, target.w, transition)
    animate(h, target.h, transition)
    animate(top, target.top, transition)
    animate(bottom, target.bottom, transition)
    prev.current = { open, tab, openHeight, peeking }
  }, [open, tab, openHeight, closed.w, closed.h, peeking, reduceMotion, w, h, top, bottom])

  const onEditing = useCallback((now: boolean) => {
    editing.current = now
    setKeyboard(now)
    if (!now && !pointerInside.current) setOpen(FORCE_OPEN)
  }, [])

  // Peek: a failure, an update, an approval or a notice opens the notch by itself for a few seconds.
  const peekSerial = owner.view.peek?.serial ?? 0
  useEffect(() => {
    if (!peekSerial) return
    setOpen(true)
    const timer = setTimeout(() => {
      if (!pointerInside.current && !editing.current) setOpen(FORCE_OPEN)
    }, PEEK_MS)
    return () => clearTimeout(timer)
  }, [peekSerial])

  // The launch cue, once per run once Settings are read (its switches): not when Windows started the app at sign-in.
  useEffect(() => {
    if (!loaded || !inTauri) return
    void cueLaunchOnce({ startedAtLogin, launchCue: alerts.launchCue, ready: () => cuePlayer.preload() })
  }, [loaded]) // eslint-disable-line react-hooks/exhaustive-deps
  // Quit (tray, Settings): play the quit cue and tell Rust how long it lasts, so the exit waits for it.
  const quitSound = useRef(alerts.quitSound)
  quitSound.current = alerts.quitSound
  useEffect(() => answerQuitRequests({ onQuitRequest, quitSound: () => quitSound.current(), quitReady }), [])
  // Interface cues (the player's switches and 400 ms rule apply) and "seen": the orb stops breathing when Relo's tab shows.
  const cuedOpen = useRef(open)
  useEffect(() => {
    if (cuedOpen.current === open) return
    cuedOpen.current = open
    alerts.interfaceCue(open ? "open" : "close")
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const cuedTab = useRef(tab)
  useEffect(() => {
    if (cuedTab.current === tab) return
    cuedTab.current = tab
    if (open) alerts.interfaceCue("tab")
  }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open && tab === "relo") alerts.markSeen()
  }, [open, tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const { onOpenChange } = owner
  useEffect(() => onOpenChange(open), [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const onFit = useCallback((listHeight: number, showsList = false) => setReloFit((s) => (s.listHeight === listHeight && s.showsList === showsList ? s : { listHeight, showsList })), [])

  // Which tab: closing returns to Relo unless "remember last tab" is on or the Shelf opens by default with items on it
  // (BoringViewModel.close); opening restores the same. A tab that hides itself (the Shelf switched off) drops to Relo.
  const rememberLast = rememberLastTabOf(settings)
  const landing = useCallback(
    (current: string) => tabOnOpen({ current, remember: rememberLast, last: settings.lastTab, shelfByDefault: shelfOpensByDefault() }),
    [rememberLast, settings.lastTab],
  )
  const openNotch = useCallback(
    (onTab?: string) => {
      setTab((current) => (FORCE_TAB ? FORCE_TAB : (onTab ?? landing(current))))
      setOpen(true)
    },
    [landing],
  )
  useEffect(() => {
    if (!open) sneakPeek.hide() // BoringViewModel.close: `sneakPeek.show = false`
    if (!open && !FORCE_TAB) setTab(landing)
  }, [open, landing])
  useEffect(() => {
    if (!isTabVisible(tab)) setTab("relo")
  })
  useEffect(() => {
    if (rememberLast && open && settings.lastTab !== tab) update({ lastTab: tab })
  }, [rememberLast, open, tab]) // eslint-disable-line react-hooks/exhaustive-deps

  // The Shelf: a drag entering the notch selects its tab (the notch is already open: Rust treats a drag as hovering).
  useEffect(
    () =>
      onShelfDragEnter(() => {
        setTab("shelf")
        setOpen(true)
      }),
    [],
  )

  // Hover: Rust reports the cursor entering/leaving the hot rect. Entering opens after the hover delay (not while a
  // sneak peek shows); leaving closes after 100 ms (ContentView.handleHover).
  const sneakShowing = sneak.show || music.sneak
  const gates = useRef({ open, sneak: sneakShowing, onHover: settings.openOnHover, delay: settings.hoverDelay })
  gates.current = { open, sneak: sneakShowing, onHover: settings.openOnHover, delay: settings.hoverDelay }
  const openRef = useRef<(tab?: string) => void>(openNotch)
  openRef.current = openNotch
  // Dev only (a browser has no Rust to report the cursor): `window.__relo.open()/close()` drive the notch for frame captures.
  useEffect(() => {
    if (inTauri || !import.meta.env.DEV) return
    ;(window as unknown as { __relo?: unknown }).__relo = { open: (tabId?: string) => openRef.current(tabId), close: () => setOpen(false), tab: (id: string) => setTab(id) }
  }, [])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = onPointer((inside) => {
      clearTimeout(timer)
      pointerInside.current = inside
      setHovering(inside)
      const g = gates.current
      if (inside) {
        if (mayOpenOnHover({ open: g.open, sneakPeekShowing: g.sneak, openOnHover: g.onHover })) {
          timer = setTimeout(() => {
            if (pointerInside.current && !gates.current.sneak) openRef.current()
          }, g.delay * 1000)
        }
      } else {
        timer = setTimeout(() => {
          if (!pointerInside.current && !editing.current) setOpen(FORCE_OPEN)
        }, HOVER_CLOSE_DELAY_MS)
      }
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [])

  // Shortcuts and gestures from Rust (the Mac's global shortcuts, tap and trackpad pan; Rust reports, the page decides).
  const live_ = useRef({ open, tab, sneakStyle: music.settings.sneakPeekStyle })
  live_.current = { open, tab, sneakStyle: music.settings.sneakPeekStyle }
  const autoClose = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const gestureReset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const gScale = useMotionValue(1)
  const gOpacity = useMotionValue(1)
  useEffect(() => {
    const offShortcut = onShortcut((action) => {
      const s = live_.current
      clearTimeout(autoClose.current) // a new shortcut cancels the pending auto-close (closeNotchTask)
      const fx = shortcutEffect(action, { open: s.open, sneakStyle: s.sneakStyle, sneakShowing: sneakPeek.get().show, expandingShowing: expandingView.get().show })
      if (!fx) return
      switch (fx.kind) {
        case "sneak":
          if (fx.show) sneakPeek.show("music", fx.ms)
          else sneakPeek.hide()
          break
        case "expanding":
          if (fx.show) expandingView.show("music")
          else expandingView.hide()
          break
        case "open":
          openRef.current(fx.tab)
          if (fx.autoCloseMs !== null) {
            // Opened by the shortcut (3 s) or by "Open in Notch" (5 s, on Relo): closes unless the pointer is on it.
            autoClose.current = setTimeout(() => {
              if (!pointerInside.current && !editing.current) setOpen(FORCE_OPEN)
            }, fx.autoCloseMs)
          }
          break
        case "close":
          if (!editing.current) setOpen(FORCE_OPEN)
          break
      }
    })
    const offGesture = onNotchGesture((gesture) => {
      const s = live_.current
      // The closed notch scales with the open gesture's progress (ContentView.gestureScale); it settles back when the
      // wheel goes quiet (the Mac's `phase == .ended`) or the gesture completes.
      const feedback = gestureFeedback(gesture, { open: s.open, tab: s.tab })
      clearTimeout(gestureReset.current)
      animate(gScale, feedback.scale, SPRINGS.smooth)
      animate(gOpacity, feedback.contentOpacity, SPRINGS.smooth)
      if (feedback !== NO_FEEDBACK) {
        gestureReset.current = setTimeout(() => {
          animate(gScale, 1, SPRINGS.smooth)
          animate(gOpacity, 1, SPRINGS.smooth)
        }, GESTURE_IDLE_MS)
      }
      const outcome = gestureEffect(gesture, { open: s.open, tab: s.tab, holdOpen: editing.current })
      if (outcome === "open") openRef.current()
      else if (outcome === "close") setOpen(FORCE_OPEN)
    })
    return () => {
      clearTimeout(autoClose.current)
      clearTimeout(gestureReset.current)
      offShortcut()
      offGesture()
    }
  }, [])

  // Settings the notch applies: the display it sits on, and the accent (the colour of "accent"-tinted controls).
  useEffect(() => {
    if (loaded) void setDisplay(settings.display).catch(() => {})
  }, [loaded, settings.display])
  useEffect(() => {
    document.documentElement.style.setProperty("--tone", COLORS[settings.accent])
  }, [settings.accent])

  // Home shows what the notch knows: the connection, Now, the notices (the Home window has no owner client of its own).
  const lastUpdated = owner.view.updatedAt
  const view = owner.view
  const homeState = useMemo<HomeState>(() => {
    const server = view.serverOrigin
    let host: string | null = null
    try {
      host = server ? new URL(server).host : null
    } catch {
      host = server
    }
    return {
      ...INITIAL_HOME,
      connection: homeConnection(view.connection),
      local: owner.enabled && local.mode,
      localProblem: homeProblem(localProblem),
      serverHost: host,
      dashboard: !local.mode && host !== null,
      lastUpdated,
      summary: view.summary,
      notices: view.notices.map((n) => ({ id: n.id, title: n.title, summary: n.summary, source: n.source, createdAt: Date.parse(n.createdAt) || 0 })),
      updateVersion: view.update?.version ?? null,
      update: view.update ? { version: view.update.version, ready: view.update.ready } : null,
      updatedLine: view.updatedLine ?? null,
    }
  }, [view.connection, view.serverOrigin, view.summary, view.notices, view.update?.version, view.update?.ready, view.updatedLine, lastUpdated, local.mode, localProblem, owner.enabled])
  useEffect(() => {
    if (owner.enabled) publishHome(homeState)
  }, [homeState, owner.enabled])

  // Report the hot rect on every spring frame so Rust's hit-testing tracks the animation.
  const report = () => {
    const r = box.current?.getBoundingClientRect()
    if (!r) return
    const hot = toHotRect(extendedRect(r, settings.extendHoverArea && !open), window.devicePixelRatio)
    if (sameRect(lastHot.current, hot)) return
    lastHot.current = hot
    setHot(hot)
  }
  useMotionValueEvent(w, "change", report)
  useMotionValueEvent(h, "change", report)
  useEffect(() => {
    report()
    window.addEventListener("resize", report)
    return () => window.removeEventListener("resize", report)
  })

  // The Mac sits in the black hardware notch, shadowed black while open or hovered. A PC has no bezel: the focus colour
  // (orange when you are needed) glows around the closed shape as on the Dashboard's glass.
  const glow = !open && relo.hasData && presentation.focus ? ringColors(presentation)[0] : null
  // Settings > Appearance > "Enable window shadow" (default on).
  const shadow = settings.enableShadow && (open || hovering) ? "drop-shadow(0 0 6px rgb(0 0 0 / 0.7))" : ""

  const current = getTab(tab)
  const TabView: ComponentType<TabViewProps> | null = current?.view ?? null
  const contentHeight = openHeight
  const faded = hide && !open

  return (
    <ReloModeContext.Provider value={mode}>
    <div style={{ width: WINDOW_W }} className="flex justify-center">
      <motion.div
        ref={box}
        style={{ width: w, height: h, scale: gScale, transformOrigin: "50% 0", opacity: faded ? 0 : 1, transition: "opacity 0.3s ease" }}
        className="relative"
        onClick={() => !inTauri && !open && openNotch()}
      >
        <svg
          className="absolute inset-0 overflow-visible"
          width="100%"
          height="100%"
          style={{ filter: `${shadow}${glow ? ` drop-shadow(0 0 7px ${glow}55)` : ""}` || undefined }}
        >
          <motion.path d={d} fill="#000" stroke="rgb(255 255 255 / 0.14)" strokeWidth={0.75} />
        </svg>
        {/* Closed: Relo's wings (kept mounted so a moment is never announced twice), or the local problem, or music. */}
        <motion.div
          className="absolute left-[14px] right-[14px] top-0 flex items-center"
          style={{ height: closedH, opacity: content === "music" ? 0 : wingsOpacity, pointerEvents: "none", visibility: content === "plain" || content === "music" ? "hidden" : "visible" }}
        >
          <ClosedActivity
            presentation={presentation}
            connected={relo.hasData}
            offline={relo.offline}
            open={open && tab === "relo"}
            quiet={alerts.quiet}
            notices={owner.view.arrivals}
            staged={staged}
            hidden={content !== "relo" || peekShowing}
            onEvents={peekCtl.onEvents}
            hint={closedHint}
          />
        </motion.div>
        {content === "music" && (
          <motion.div className="absolute left-[12px] right-[12px] top-0" style={{ height: closedH, opacity: wingsOpacity, pointerEvents: "none" }}>
            <ClosedMusic closedHeight={closedH} inline={music.settings.sneakPeekStyle === "inline" && musicSneak} />
          </motion.div>
        )}
        {content === "music" && music.settings.sneakPeekStyle === "standard" && musicSneak && !open && (
          <div className="absolute left-0 right-0" style={{ top: closedH, pointerEvents: "none" }}>
            <SneakPeekStrip />
          </div>
        )}
        {/* Peek: the closed notch grown into the update's card (or a notice line) under the wings. */}
        {!open && content === "relo" && (
          <div className="absolute bottom-0 left-0 right-0 flex items-start justify-center overflow-hidden" style={{ top: closedH, pointerEvents: "none" }}>
            <PeekHost
              snapshot={peekCtl.snapshot}
              rows={rows}
              questions={relo.questions}
              answers={relo.answers}
              onAnswer={relo.onAnswer}
              offline={relo.offline}
              reduceMotion={reduceMotion}
              onHeight={setPeekH}
            />
          </div>
        )}
        {/* Open: ContentView clips everything it draws to the notch's shape (`.clipShape(currentNotchShape)`), so nothing is
            seen outside the outline while it morphs. The content is laid out at its final width, centred on the shape, from
            the first frame: the shape grows over it and the settings button is already where it ends up. */}
        <motion.div className="absolute inset-0" style={{ clipPath: clip, pointerEvents: open ? "auto" : "none" }}>
          {mounted && (
              <motion.div
                className="absolute top-0 flex flex-col"
                style={{
                  left: "50%",
                  marginLeft: -(OPEN_BASE.w - CONTENT_INSET * 2) / 2,
                  width: OPEN_BASE.w - CONTENT_INSET * 2,
                  height: open ? h : openHeight,
                  paddingBottom: CONTENT_BOTTOM,
                  opacity: reveal,
                  scale: reduceMotion ? 1 : contentScale,
                  transformOrigin: "50% 0",
                }}
              >
                {/* An upward pan on a non-Relo tab dims what is open as it shrinks (ContentView: `1 - min(|progress| * 0.1, 0.3)`). */}
                <motion.div className="flex min-h-0 flex-1 flex-col" style={{ opacity: gOpacity }}>
                  {/* The header (tabs and the settings gear) is part of the content: laid out in its final place from the
                      first frame, and it scales and fades in with it, un-blurring (BoringHeader: `.blur(20)` while closed). */}
                  <motion.div className="shrink-0" style={{ filter: reduceMotion ? undefined : headerBlur }}>
                    <Header
                      current={tab}
                      reduceMotion={reduceMotion}
                      onSelect={(id) => setTab(id)}
                      alwaysShowTabs={settings.alwaysShowTabs}
                      onSettings={settings.settingsIconInNotch ? () => void openSettings().catch(() => {}) : undefined}
                    />
                  </motion.div>
                  {/* The tab's view: `.transition(.scale(0.8, anchor: .top).combined(with: .opacity).animation(.smooth(duration: 0.35)))`. */}
                  <div className="min-h-0 flex-1" style={{ marginTop: HEADER_GAP }}>
                    <div className="relative h-full overflow-hidden" data-content-height={contentHeight}>
                      <AnimatePresence mode="popLayout" initial={false}>
                        <motion.div
                          key={tab}
                          className="absolute inset-0"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={reduceMotion ? REDUCED : SPRINGS.tabSwap}
                        >
                          {tab === "relo" && owner.enabled && <OwnerBar owner={owner} onFit={setBarH} />}
                          {tab === "relo" ? (
                            localProblem ? (
                              <LocalPanel local={local} connection={owner.view.connection} onFit={(height) => onFit(height, false)} />
                            ) : owner.enabled && !relo.hasData ? (
                              <Connect {...owner.view} onSignIn={(origin) => void owner.signIn(origin)} onCancel={owner.cancelSignIn} onRetry={owner.retry} onEditing={onEditing} onFit={(height) => onFit(height, false)} />
                            ) : (
                              <Panel presentation={presentation} hasData={relo.hasData} offline={relo.offline} questions={relo.questions} answers={relo.answers} onAnswer={relo.onAnswer} onDismiss={dismiss} onFit={onFit} cached={Boolean((owner.view as { cached?: boolean }).cached)} reduceMotion={reduceMotion} voice={cardVoice} onCue={alerts.interfaceCue} />
                            )
                          ) : TabView ? (
                            <TabView active onFit={fitsContent(tab) ? fitterFor(tab) : undefined} />
                          ) : (
                            <Placeholder label={current?.label ?? tab} />
                          )}
                        </motion.div>
                      </AnimatePresence>
                    </div>
                  </div>
                </motion.div>
              </motion.div>
          )}
        </motion.div>
      </motion.div>
    </div>
    </ReloModeContext.Provider>
  )
}

/** For the host: a moment worth a peek (hovering will not open the notch while it shows). */
export const peek = (type = "music", ms?: number): void => sneakPeek.show(type, ms)
