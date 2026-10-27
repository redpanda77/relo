// The Settings pages, ported from the Mac's (ReloSettingsView.swift, SettingsView.swift): same pages, same words,
// Windows places. Relo, Voice and Shortcuts have their own files; Media and Shelf theirs (media.tsx, shelf.tsx).
// What the Mac has and Windows cannot do is left out, not faked: haptics and trackpad swipes (no Windows equivalent),
// the title bar and lock screen options (the notch is a click-through
// overlay), Lottie visualizers. "Enable window shadow", "Extend hover area" and "Automatically switch displays" are the
// Mac's settings (`enableShadow`, `extendHoverArea`, `automaticallySwitchDisplay`); the notch and displays.rs read them.
import { useEffect, useState } from "react"
import licenses from "../../THIRD_PARTY.md?raw"
import { autostartGet, autostartSet, listDisplays, type DisplayInfo } from "../bridge"
import { cuePlayer, type NotchEventKind } from "../sound"
import type { Tone } from "../relo/presentation"
import { COLORS, toneColor, toneLabel } from "../relo/ui/theme"
import { appVersion, openLogsFolder } from "./ipc"
import { ACCENTS, NOTCH_HEIGHT_MAX, NOTCH_HEIGHT_MIN, NOTCH_HEIGHT_PRESETS, type Accent, type NotchHeightMode, type ReloSettings, type SettingsPatch } from "./store"
import { Btn, Group, Page, Row, Segmented, Select, Slider, ToggleRow } from "./ui"

export { ReloPage } from "./reloPage"
export { VoicePage } from "./voicePage"
export { ShortcutsPage } from "./shortcutsPage"

export interface PageProps {
  s: ReloSettings
  set: (patch: SettingsPatch) => void
}

// ---- Alerts ----

const SOUND_ROWS: Array<{ kind: NotchEventKind; title: string; detail?: string }> = [
  { kind: "question", title: "A question needs you" },
  { kind: "yourTurn", title: "It's your turn" },
  { kind: "failed", title: "Work failed" },
  { kind: "finished", title: "Work finished" },
  { kind: "started", title: "Work started" },
  { kind: "progressed", title: "A step finished", detail: "At most every 3 minutes per card" },
]

/** The Mac's `ReloAlertPreview.tone`. */
export const KIND_TONE: Record<NotchEventKind, Tone> = { question: "needsYou", yourTurn: "yourTurn", failed: "failed", finished: "done", started: "working", progressed: "working" }

const play = (kind: NotchEventKind) => {
  void cuePlayer.preload().then(() => cuePlayer.preview(kind))
}

const PREVIEW_KINDS: Array<{ kind: NotchEventKind; label: string }> = [
  { kind: "question", label: "Question" },
  { kind: "yourTurn", label: "Your turn" },
  { kind: "finished", label: "Finished" },
  { kind: "failed", label: "Failed" },
]

/** The closed notch in small, in the kind's colour; pick a kind to see and hear it. */
function AlertPreview() {
  const [kind, setKind] = useState<NotchEventKind>("question")
  const tone = KIND_TONE[kind]
  return (
    <div className="alert-preview" style={{ ["--k" as string]: toneColor(tone) }}>
      <div className="mini-notch" aria-hidden>
        <i />
        <b>{toneLabel(tone)}</b>
      </div>
      <Segmented<NotchEventKind>
        label="Preview"
        value={kind}
        options={PREVIEW_KINDS.map((k) => ({ value: k.kind, label: k.label }))}
        onChange={(k) => {
          setKind(k)
          play(k)
        }}
      />
    </div>
  )
}

export function AlertsPage({ s, set }: PageProps) {
  return (
    <Page title="Alerts" detail="What the notch does when work needs you, finishes or fails">
      <AlertPreview />
      <Group title="Notch">
        <ToggleRow title="Show Relo in the closed notch" checked={s.closedActivity} onChange={(closedActivity) => set({ closedActivity })} />
        <ToggleRow title="Expand for what matters" detail="When work starts, needs you, finishes or fails" checked={s.peek} disabled={!s.closedActivity} onChange={(peek) => set({ peek })} />
      </Group>
      <Group title="Sounds">
        <ToggleRow title="Play sounds" checked={s.sounds} onChange={(sounds) => set({ sounds })} />
        {SOUND_ROWS.map((r) => (
          <Row key={r.kind} title={r.title} detail={r.detail} disabled={!s.sounds}>
            <Btn onClick={() => play(r.kind)}>Preview</Btn>
            <button type="button" role="switch" aria-checked={s.soundEvents[r.kind]} aria-label={r.title} className="switch" onClick={() => set({ soundEvents: { ...s.soundEvents, [r.kind]: !s.soundEvents[r.kind] } })} />
          </Row>
        ))}
        <ToggleRow title="Interface sounds" detail="The notch, cards, tabs, Settings, Relo launching and quitting" checked={s.interfaceSounds} disabled={!s.sounds} onChange={(interfaceSounds) => set({ interfaceSounds })} />
      </Group>
      <Group title="Interruptions" footer="Progress and status changes update the notch quietly; only the updates above expand it.">
        <ToggleRow title="Stay quiet while a full-screen app is in front" checked={s.quietInFullScreen} onChange={(quietInFullScreen) => set({ quietInFullScreen })} />
      </Group>
    </Page>
  )
}

// ---- General ----

export const HEIGHT_MODE_OPTIONS: ReadonlyArray<{ value: NotchHeightMode; label: string }> = [
  { value: "real", label: "Match real notch height" },
  { value: "menuBar", label: "Match menu bar height" },
  { value: "custom", label: "Custom height" },
]

/** The patch for choosing a height mode: presets pin their height, custom starts at the real-notch height (the Mac's onChange). */
export function heightModePatch(mode: NotchHeightMode): SettingsPatch {
  return { notchHeightMode: mode, notchHeight: mode === "custom" ? NOTCH_HEIGHT_PRESETS.real : NOTCH_HEIGHT_PRESETS[mode] }
}

export function sensitivityLabel(v: number): string {
  return v === 100 ? "High" : v === 200 ? "Medium" : "Low"
}

export function GeneralPage({ s, set }: PageProps) {
  const [autostart, setAutostart] = useState(false)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  useEffect(() => {
    void autostartGet().then(setAutostart).catch(() => {})
    void listDisplays().then(setDisplays)
  }, [])
  return (
    <Page title="General" detail="How Relo starts, where the notch sits and when it opens">
      <Group title="System features">
        <ToggleRow title="Show tray icon" checked={s.showTrayIcon} onChange={(showTrayIcon) => set({ showTrayIcon })} />
        <ToggleRow
          title="Open Relo when this PC starts"
          checked={autostart}
          onChange={(on) => {
            setAutostart(on)
            void autostartSet(on).catch(() => setAutostart(!on))
          }}
        />
        <ToggleRow title="Show on all displays" checked={s.showOnAllDisplays} onChange={(showOnAllDisplays) => set({ showOnAllDisplays })} />
        <Row title="Preferred display" disabled={s.showOnAllDisplays}>
          <Select<string>
            label="Preferred display"
            disabled={s.showOnAllDisplays}
            value={s.display ?? ""}
            options={[{ value: "", label: "Primary display" }, ...displays.map((d) => ({ value: d.id, label: `${d.name || d.id}${d.primary ? " (primary)" : ""}` }))]}
            onChange={(v) => set({ display: v || null })}
          />
        </Row>
        <ToggleRow
          title="Automatically switch displays"
          detail="The notch follows the display you are working on"
          checked={s.autoSwitchDisplay}
          disabled={s.showOnAllDisplays}
          onChange={(autoSwitchDisplay) => set({ autoSwitchDisplay })}
        />
      </Group>
      <Group title="Notch sizing">
        <Row title="Notch height">
          <Select<NotchHeightMode> label="Notch height" value={s.notchHeightMode} options={HEIGHT_MODE_OPTIONS} onChange={(m) => set(heightModePatch(m))} />
        </Row>
        {s.notchHeightMode === "custom" && (
          <Row title={`Custom notch size - ${s.notchHeight}`}>
            <Slider label="Custom notch size" min={NOTCH_HEIGHT_MIN} max={NOTCH_HEIGHT_MAX} step={1} value={s.notchHeight} onChange={(notchHeight) => set({ notchHeightMode: "custom", notchHeight })} />
          </Row>
        )}
      </Group>
      <Group title="Notch behavior">
        <ToggleRow title="Open notch on hover" checked={s.openOnHover} onChange={(openOnHover) => set(openOnHover ? { openOnHover } : { openOnHover, enableGestures: true })} />
        <ToggleRow title="Remember last tab" checked={s.rememberLastTab} onChange={(rememberLastTab) => set({ rememberLastTab })} />
        {s.openOnHover && (
          <Row title="Hover delay" detail={`${s.hoverDelay.toFixed(1)}s`}>
            <Slider label="Hover delay" min={0} max={1} step={0.1} value={s.hoverDelay} onChange={(hoverDelay) => set({ hoverDelay })} />
          </Row>
        )}
      </Group>
      <Group title="Gesture control (Beta)" footer="Two-finger swipe up on notch to close, two-finger swipe down on notch to open when Open notch on hover option is disabled">
        <ToggleRow title="Enable gestures" checked={s.enableGestures} disabled={!s.openOnHover} onChange={(enableGestures) => set({ enableGestures })} />
        {s.enableGestures && (
          <>
            <ToggleRow title="Close gesture" checked={s.closeGesture} onChange={(closeGesture) => set({ closeGesture })} />
            <Row title="Gesture sensitivity" detail={sensitivityLabel(s.gestureSensitivity)}>
              <Slider label="Gesture sensitivity" min={100} max={300} step={100} value={s.gestureSensitivity} onChange={(v) => set({ gestureSensitivity: v as ReloSettings["gestureSensitivity"] })} />
            </Row>
          </>
        )}
      </Group>
    </Page>
  )
}

// ---- Appearance ----

const ACCENT_NAMES: Record<Accent, string> = { running: "Violet", cyan: "Cyan", mint: "Mint", signalCoral: "Coral" }

export function AppearancePage({ s, set }: PageProps) {
  return (
    <Page title="Appearance" detail="Colour, motion and what the notch shows. The music look is on the Media page.">
      <Group title="General">
        <ToggleRow title="Always show tabs" checked={s.alwaysShowTabs} onChange={(alwaysShowTabs) => set({ alwaysShowTabs })} />
        <ToggleRow title="Show settings icon in notch" checked={s.settingsIconInNotch} onChange={(settingsIconInNotch) => set({ settingsIconInNotch })} />
      </Group>
      <Group title="Look">
        <Row title="Accent" detail={ACCENT_NAMES[s.accent]}>
          <div className="swatches">
            {ACCENTS.map((a) => (
              <button key={a} type="button" className="swatch" aria-label={ACCENT_NAMES[a]} aria-pressed={s.accent === a} style={{ ["--c" as string]: COLORS[a] }} onClick={() => set({ accent: a })} />
            ))}
          </div>
        </Row>
        <ToggleRow title="Reduce motion" detail="Fewer animations in the notch and Settings" checked={s.reduceMotion} onChange={(reduceMotion) => set({ reduceMotion })} />
      </Group>
    </Page>
  )
}

// ---- Advanced ----

export function AdvancedPage({ s, set, onReset }: PageProps & { onReset: () => void }) {
  return (
    <Page title="Advanced" detail="Window behavior, logs and first-run setup">
      <Group title="Window Appearance">
        <ToggleRow title="Enable window shadow" detail="A soft shadow under the notch while it is open or hovered" checked={s.enableShadow} onChange={(enableShadow) => set({ enableShadow })} />
      </Group>
      <Group title="Window Behavior">
        <ToggleRow title="Extend hover area" detail="Open the notch from a larger area around it" checked={s.extendHoverArea} onChange={(extendHoverArea) => set({ extendHoverArea })} />
        <ToggleRow title="Hide from screen recording" detail="The notch does not appear in screenshots, recordings or screen sharing" checked={s.hideFromScreenRecording} onChange={(hideFromScreenRecording) => set({ hideFromScreenRecording })} />
      </Group>
      <Group>
        <Row title="Logs" detail="Open the folder Relo writes its logs to">
          <Btn onClick={() => void openLogsFolder()}>Open logs folder</Btn>
        </Row>
        <Row title="Onboarding" detail="Show the welcome and setup again">
          <Btn
            onClick={() => {
              set({ onboardingDone: false, onboarding: null })
              onReset()
            }}
          >
            Reset onboarding
          </Btn>
        </Row>
      </Group>
    </Page>
  )
}

// ---- About ----

export function AboutPage() {
  const [version, setVersion] = useState("")
  useEffect(() => void appVersion().then(setVersion), [])
  return (
    <Page title="About" detail="Relo for Windows">
      <Group title="Version info">
        <Row title="Relo">
          <span className="mono">{version}</span>
        </Row>
      </Group>
      <Group title="Licenses" footer="Based on boring.notch by TheBoredTeam, GPL-3.0, for the Mac app. This list is apps/windows/THIRD_PARTY.md.">
        <pre className="licenses">{licenses}</pre>
      </Group>
    </Page>
  )
}
