// The closed notch's music activity (ContentView.swift: MusicLiveActivity + the music sneak peek): the cover at
// (closed height - 12) = 20 px on the left, the five-band visualizer on the right, and in between the notch itself.
// Sneak peek, standard: "♪ Title - Artist" under the notch. Inline: the wings widen and carry title and artist.

import { useEffect, useState } from "react"
import { css, ensureMinimumBrightness } from "./color"
import { NoteIcon } from "./icons"
import { Marquee } from "./Marquee"
import { showsMusicActivity } from "./idle"
import { useMusic } from "./store"
import { Visualizer } from "./Visualizer"
import type { MediaSettings } from "./types"

/** Mac: the chin grows by 2 * (closedHeight - 12) + 20 when music is the closed activity. */
export const closedMusicExtraWidth = (closedHeight: number): number => 2 * Math.max(0, closedHeight - 12) + 20
/** Mac: the inline sneak peek centre is 380 wide, between the cover and the visualizer. */
export const INLINE_CENTER_W = 380
/** Extra height of the standard sneak peek strip under the closed notch. */
export const SNEAK_STRIP_H = 26

export interface ClosedMusicShape {
  /** Width the closed notch should take for the music activity (CSS px). */
  width: number
  /** Extra height under it (the standard sneak peek strip). */
  extraHeight: number
}

/** The closed notch's size for the music activity, from the closed shape (`closedWidth` x `closedHeight`). */
export function closedMusicShape(o: { closedWidth: number; closedHeight: number; sneak: boolean; style: MediaSettings["sneakPeekStyle"] }): ClosedMusicShape {
  const art = Math.max(0, o.closedHeight - 12)
  if (o.sneak && o.style === "inline") return { width: INLINE_CENTER_W + 2 * art + 2 * 8 + 12, extraHeight: 0 }
  const base = o.closedWidth + closedMusicExtraWidth(o.closedHeight)
  return { width: o.sneak && o.style === "standard" ? Math.max(base, 260) : base, extraHeight: o.sneak && o.style === "standard" ? SNEAK_STRIP_H : 0 }
}

/**
 * Should the closed notch carry music now (instead of Relo's card)? Read this in the notch shell:
 * `const { show } = useClosedMusic({ hiddenForFullscreen })`.
 */
export function useClosedMusic(o: { hiddenForFullscreen?: boolean } = {}) {
  const m = useMusic()
  const show = showsMusicActivity({ isPlaying: m.state.isPlaying, idle: m.idle, liveActivity: m.settings.liveActivity, hiddenForFullscreen: !!o.hiddenForFullscreen, active: m.state.active })
  return { show, sneak: m.sneak, settings: m.settings, state: m.state }
}

function usePageVisible(): boolean {
  const [v, setV] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden")
  useEffect(() => {
    const f = () => setV(document.visibilityState !== "hidden")
    document.addEventListener("visibilitychange", f)
    return () => document.removeEventListener("visibilitychange", f)
  }, [])
  return v
}

/**
 * The strip inside the closed notch: it fills the notch's width (give it the notch's inner box).
 * `closedHeight` is the notch height (32 by default); the cover is `closedHeight - 12` square.
 */
export function ClosedMusic({ closedHeight = 32, inline: forceInline }: { closedHeight?: number; inline?: boolean }) {
  const { state, settings, avg, sneak } = useMusic()
  const visible = usePageVisible()
  const size = Math.max(0, closedHeight - 12)
  const tint = settings.coloredSpectrogram ? css(avg) : "rgb(128 128 128)"
  const inline = forceInline ?? (sneak && settings.sneakPeekStyle === "inline")
  const radius = 4
  return (
    <div className="flex w-full items-center justify-between" style={{ height: closedHeight, gap: 8 }}>
      <div style={{ width: size, height: size, flex: "none" }}>
        {state.artwork ? (
          <img src={state.artwork} alt="" draggable={false} style={{ width: size, height: size, borderRadius: radius, objectFit: "cover", display: "block" }} />
        ) : (
          <div className="grid place-items-center text-white/70" style={{ width: size, height: size, borderRadius: radius, background: "linear-gradient(135deg, #3a3a44, #1c1c22)" }}>
            <NoteIcon size={size * 0.6} />
          </div>
        )}
      </div>
      {inline && (
        <div className="flex min-w-0 flex-1 items-center justify-between" style={{ gap: 12, fontSize: 12 }}>
          <Marquee text={state.title} color={tint} className="min-w-0 flex-1" minDuration={0.4} />
          <span className="truncate text-right" style={{ color: tint, maxWidth: 120 }}>
            {state.artist}
          </span>
        </div>
      )}
      <div className="grid place-items-center" style={{ width: size, height: size, flex: "none" }}>
        <Visualizer active={state.isPlaying && visible} color={tint} />
      </div>
    </div>
  )
}

/** The standard sneak peek strip under the closed notch ("♪ Title - Artist"). Render it when `sneak` and style is standard. */
export function SneakPeekStrip() {
  const { state, settings, avg } = useMusic()
  const color = settings.playerColorTinting ? css(ensureMinimumBrightness(avg, 0.6)) : "rgb(160 160 160)"
  return (
    <div className="flex items-center justify-center" style={{ height: SNEAK_STRIP_H, gap: 6, padding: "0 14px 4px", fontSize: 12, color: "rgb(160 160 160)" }}>
      <NoteIcon size={13} />
      <Marquee text={`${state.title} - ${state.artist}`} color={color} className="min-w-0 flex-1" minDuration={1} />
    </div>
  )
}
