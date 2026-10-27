// The open notch's Music tab (NotchHomeView.swift: MusicPlayerView = album art + MusicControlsView). Same layout: a 90 px
// cover with the source app's badge, title / artist / lyrics, the progress slider with times, and the slot toolbar.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { css, ensureMinimumBrightness } from "./color"
import { BackwardIcon, ForwardIcon, HeartIcon, NoteIcon, PauseIcon, PlayIcon, RepeatIcon, ShuffleIcon, SkipIcon, SpeakerIcon } from "./icons"
import { mediaControl, mediaOpenApp, mediaSeek, mediaVolume } from "./ipc"
import { isArabicScript, lyricsLine } from "./lyrics"
import { Marquee } from "./Marquee"
import { activeSlots } from "./slots"
import { useMusic } from "./store"
import { positionAt, type MediaSettings, type MediaState, type MusicControl } from "./types"
import "./music.css"

const ART = 90
const RADIUS = { opened: 13, closed: 4 } as const

/** Re-render every `ms` while `enabled` (the progress bar's TimelineView). */
export function useNow(ms: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms, enabled])
  return enabled ? now : Date.now()
}

export const timeString = (seconds: number): string => {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`
}

// ---- Album art ----

export function AlbumArt({ state, settings, size = ART, badge = true }: { state: MediaState; settings: MediaSettings; size?: number; badge?: boolean }) {
  const radius = settings.cornerRadiusScaling ? RADIUS.opened : RADIUS.closed
  const art = state.artwork
  const playing = state.isPlaying
  return (
    <div className="relative" style={{ width: size, height: size }}>
      {settings.lightingEffect && art && (
        <img
          src={art}
          alt=""
          draggable={false}
          className="mu-art absolute inset-0 h-full w-full object-cover"
          style={{ borderRadius: radius, transform: "scale(1.3, 1.4) rotate(92deg)", filter: "blur(40px)", opacity: playing ? 0.5 : 0, pointerEvents: "none" }}
        />
      )}
      <button
        type="button"
        onClick={mediaOpenApp}
        aria-label={state.appName ? `Open ${state.appName}` : "Open the music app"}
        className="mu-art relative block h-full w-full cursor-pointer border-0 bg-transparent p-0"
        style={{ transform: `scale(${playing ? 1 : 0.85})` }}
      >
        {art ? (
          <img src={art} alt="" draggable={false} className="h-full w-full object-cover" style={{ borderRadius: radius }} />
        ) : (
          <div className="grid h-full w-full place-items-center text-white/70" style={{ borderRadius: radius, background: "linear-gradient(135deg, #3a3a44, #1c1c22)" }}>
            <NoteIcon size={size * 0.38} />
          </div>
        )}
        {badge && art && state.appName && (
          <span
            className="absolute grid place-items-center text-[13px] font-bold text-white"
            title={state.appName}
            style={{ width: 30, height: 30, right: -10, bottom: -10, borderRadius: 8, background: "linear-gradient(135deg, #5a5a66, #2a2a32)", boxShadow: "0 0 0 1.5px #000" }}
          >
            {state.appName.slice(0, 1)}
          </span>
        )}
      </button>
      {/* The paused veil (albumArtDarkOverlay). */}
      <div className="pointer-events-none absolute inset-0 bg-black transition-opacity duration-300" style={{ opacity: playing ? 0 : 0.5, borderRadius: radius }} />
    </div>
  )
}

// ---- Slider ----

export function Slider({
  value,
  max,
  color,
  onChange,
  onCommit,
  onDrag,
  label,
}: {
  value: number
  max: number
  color: string
  onChange?: (v: number) => void
  onCommit: (v: number) => void
  onDrag?: (dragging: boolean) => void
  label: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const fromEvent = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const f = r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0
    return f * max
  }
  const shown = drag ?? value
  const pct = max > 0 ? Math.min(100, Math.max(0, (shown / max) * 100)) : 0
  return (
    <div
      ref={ref}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(shown)}
      className="mu-track"
      data-dragging={drag !== null ? "" : undefined}
      onPointerDown={(e) => {
        if (max <= 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        const v = fromEvent(e)
        setDrag(v)
        onDrag?.(true)
        onChange?.(v)
      }}
      onPointerMove={(e) => {
        if (drag === null) return
        const v = fromEvent(e)
        setDrag(v)
        onChange?.(v)
      }}
      onPointerUp={(e) => {
        if (drag === null) return
        const v = fromEvent(e)
        setDrag(null)
        onDrag?.(false)
        onCommit(v)
      }}
    >
      <div className="mu-rail">
        <div className="mu-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  )
}

function ProgressBar({ state, settings, tint, sliderColor }: { state: MediaState; settings: MediaSettings; tint: string; sliderColor: string }) {
  const [dragging, setDragging] = useState(false)
  const [held, setHeld] = useState<{ v: number; until: number } | null>(null)
  const now = useNow(100, state.isPlaying && !dragging)
  const duration = state.durationMs / 1000
  let value = positionAt(state, now)
  if (held && now < held.until) value = held.v // the Mac holds a dragged value for a second so the thumb does not jump back
  const [dragValue, setDragValue] = useState(0)
  const shown = dragging ? dragValue : value
  void settings
  return (
    <div className="flex flex-col" style={{ gap: 2 }}>
      <Slider
        label="Playback position"
        value={shown}
        max={duration}
        color={sliderColor}
        onChange={setDragValue}
        onDrag={setDragging}
        onCommit={(v) => {
          setHeld({ v, until: Date.now() + 1000 })
          if (state.canSeek) mediaSeek(v)
        }}
      />
      <div className="flex justify-between text-[11px] font-medium" style={{ color: tint }}>
        <span>{timeString(shown)}</span>
        <span>{timeString(duration)}</span>
      </div>
    </div>
  )
}

// ---- Controls ----

function HoverButton({ label, size = "medium", disabled, color, onClick, children }: { label: string; size?: "medium" | "large"; disabled?: boolean; color?: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button type="button" className="mu-btn" data-size={size} aria-label={label} title={label} disabled={disabled} onClick={onClick} style={{ color: color ?? "#fff", opacity: disabled ? 0.35 : 1 }}>
      {children}
    </button>
  )
}

function Volume({ state }: { state: MediaState }) {
  const [open, setOpen] = useState(false)
  const [v, setV] = useState(state.volume)
  const dragging = useRef(false)
  const last = useRef(0)
  useEffect(() => {
    if (!dragging.current) setV(state.volume)
  }, [state.volume])
  useEffect(() => {
    if (!state.volumeSupported) setOpen(false)
  }, [state.volumeSupported])
  const level = !state.volumeSupported || v === 0 ? 0 : v < 0.33 ? 1 : v < 0.66 ? 2 : 3
  return (
    <div className="flex items-center" style={{ gap: 4 }}>
      <HoverButton label="Volume" disabled={!state.volumeSupported} onClick={() => setOpen((o) => !o)}>
        <SpeakerIcon size={16} level={level as 0 | 1 | 2 | 3} />
      </HoverButton>
      {open && state.volumeSupported && (
        <div style={{ width: 48 }}>
          <Slider
            label="Volume"
            value={v}
            max={1}
            color="#fff"
            onDrag={(d) => (dragging.current = d)}
            onChange={(x) => {
              setV(x)
              const t = Date.now()
              if (t - last.current > 100) {
                last.current = t
                mediaVolume(x)
              }
            }}
            onCommit={(x) => mediaVolume(x)}
          />
        </div>
      )}
    </div>
  )
}

const REPEAT_COLOR = "#ff453a" // the Mac's .red for an active shuffle/repeat/favorite

function SlotView({ slot, state }: { slot: MusicControl; state: MediaState }) {
  switch (slot) {
    case "shuffle":
      return (
        <HoverButton label="Shuffle" disabled={!state.shuffleSupported} color={state.isShuffled ? REPEAT_COLOR : undefined} onClick={() => mediaControl("shuffle")}>
          <ShuffleIcon size={16} />
        </HoverButton>
      )
    case "previous":
      return (
        <HoverButton label="Previous" disabled={state.active && !state.canPrev} onClick={() => mediaControl("prev")}>
          <BackwardIcon size={16} />
        </HoverButton>
      )
    case "playPause":
      return (
        <HoverButton label={state.isPlaying ? "Pause" : "Play"} size="large" onClick={() => mediaControl("toggle")}>
          {state.isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
        </HoverButton>
      )
    case "next":
      return (
        <HoverButton label="Next" disabled={state.active && !state.canNext} onClick={() => mediaControl("next")}>
          <ForwardIcon size={16} />
        </HoverButton>
      )
    case "repeatMode":
      return (
        <HoverButton label="Repeat" disabled={!state.repeatSupported} color={state.repeat !== "off" ? REPEAT_COLOR : undefined} onClick={() => mediaControl("repeat")}>
          <RepeatIcon size={16} one={state.repeat === "one"} />
        </HoverButton>
      )
    case "volume":
      return <Volume state={state} />
    case "favorite":
      return (
        <HoverButton label="Favorite" disabled={!state.favoriteSupported} color={state.isFavorite ? REPEAT_COLOR : undefined} onClick={() => mediaControl("like")}>
          <HeartIcon size={16} filled={state.isFavorite} />
        </HoverButton>
      )
    case "goBackward":
      return (
        <HoverButton label="Back 15 seconds" disabled={!state.canSeek} onClick={() => mediaSeek(Math.max(0, positionAt(state, Date.now()) - 15))}>
          <SkipIcon size={16} forward={false} />
        </HoverButton>
      )
    case "goForward":
      return (
        <HoverButton label="Forward 15 seconds" disabled={!state.canSeek} onClick={() => mediaSeek(positionAt(state, Date.now()) + 15)}>
          <SkipIcon size={16} forward />
        </HoverButton>
      )
    case "none":
      return <div style={{ height: 1 }} />
  }
}

function Lyrics({ enabled }: { enabled: boolean }) {
  const { state, lyrics } = useMusic()
  const live = enabled && state.isPlaying && lyrics.synced.length > 0
  const now = useNow(250, live)
  if (!enabled) return null
  const line = lyricsLine(lyrics, positionAt(state, now))
  return <Marquee text={line} color={lyrics.fetching ? "rgb(160 160 160 / 0.7)" : "rgb(160 160 160)"} className="text-[13px]" style={{ opacity: state.isPlaying ? 1 : 0, transition: "opacity 200ms", fontFamily: isArabicScript(line) ? "Vazirmatn, system-ui, sans-serif" : undefined }} minDuration={3} />
}

// ---- The tab ----

/** The Music tab (register as `home`): `registerTab(musicTab)`. */
export function MusicTabView() {
  const { state, settings, avg } = useMusic()
  const tinted = css(ensureMinimumBrightness(avg, 0.6))
  const tint = settings.playerColorTinting ? tinted : "rgb(160 160 160)"
  const sliderColor = settings.sliderColor === "albumArt" ? css(ensureMinimumBrightness(avg, 0.8)) : settings.sliderColor === "accent" ? "var(--tone, #8b7cff)" : "#fff"
  const slots = activeSlots(settings.slots)
  const title = state.active ? state.title : "Nothing playing"
  const artist = state.active ? state.artist : "Play something to see it here"
  const stop = useCallback((e: React.PointerEvent) => e.stopPropagation(), [])

  return (
    <div className="flex h-full items-center" style={{ gap: 10, padding: "4px 10px 14px 5px" }} onPointerDown={stop}>
      <div style={{ padding: 5, flex: "none" }}>
        <AlbumArt state={state} settings={settings} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2, opacity: state.active ? 1 : 0.55 }}>
        <div className="flex min-w-0 flex-col" style={{ paddingTop: 6 }}>
          <Marquee text={title} color="#fff" className="text-[15px] font-semibold leading-[20px]" />
          <Marquee text={artist} color={state.active ? tint : "rgb(160 160 160)"} className="text-[15px] font-medium leading-[20px]" />
          <Lyrics enabled={settings.lyrics} />
        </div>
        <div style={{ paddingTop: 5 }}>
          <ProgressBar state={state} settings={settings} tint={tint} sliderColor={sliderColor} />
        </div>
        <div className="flex items-center justify-center" style={{ gap: 6 }}>
          {slots.map((slot, i) => (
            <SlotView key={`${i}-${slot}`} slot={slot} state={state} />
          ))}
        </div>
      </div>
    </div>
  )
}
