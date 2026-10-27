// Visualizer feed. Rust captures the default output device only while someone here wants the bands, so a hidden or
// paused notch costs nothing: the first `watchBands` starts the capture, the last stop stops it.

import { mediaVisualizer, onMediaBands } from "./ipc"

export const BAND_COUNT = 5

type Cb = (bands: number[]) => void
const watchers = new Set<Cb>()
let off: (() => void) | null = null

/** Subscribe to band levels (0..1, five of them, ~30 per second). Returns the unsubscribe. */
export function watchBands(cb: Cb): () => void {
  watchers.add(cb)
  if (watchers.size === 1) {
    off = onMediaBands((b) => watchers.forEach((w) => w(b)))
    mediaVisualizer(true)
  }
  return () => {
    watchers.delete(cb)
    if (watchers.size === 0) {
      off?.()
      off = null
      mediaVisualizer(false)
    }
  }
}

/** A bar's height as a fraction of its box: never below the Mac's resting 0.35 so silence still reads as a bar. */
export function barScale(level: number, resting = 0.35): number {
  const l = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0
  return resting + (1 - resting) * l
}

/** True when a watcher should be running: music playing and the visualizer on screen. */
export function wantsBands(o: { playing: boolean; visible: boolean }): boolean {
  return o.playing && o.visible
}
