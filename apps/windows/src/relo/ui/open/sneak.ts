// The sneak peek and the expanding closed notch (BoringViewCoordinator): a compact expanded state the closed notch shows
// for a moment (music; moments on the PC). `toggleSneakPeek` shows it for `duration` (1.5 s by default) and hides it by
// itself; `toggleExpandingView` holds it for 3 s. While a sneak peek shows, hovering does not open the notch.

import { useSyncExternalStore } from "react"
import { EXPANDING_MS, SNEAK_PEEK_MS } from "../../../geometry"

export interface Timers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }

export interface PeekState {
  show: boolean
  /** What it shows, e.g. "music". */
  type: string
}

/** One timed flag: showing it (again) restarts the timer; it hides itself when the time is up. */
export class TimedFlag {
  private handle: unknown = null
  private state: PeekState = { show: false, type: "" }
  private listeners = new Set<() => void>()

  private readonly defaultMs: number
  private readonly timers: Timers

  constructor(defaultMs: number, timers: Timers = realTimers) {
    this.defaultMs = defaultMs
    this.timers = timers
  }

  get = (): PeekState => this.state
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  show(type: string, ms: number = this.defaultMs): void {
    this.cancel()
    this.state = { show: true, type }
    this.emit()
    this.handle = this.timers.set(() => this.hide(), ms)
  }

  hide(): void {
    this.cancel()
    if (!this.state.show) return
    this.state = { show: false, type: this.state.type }
    this.emit()
  }

  private cancel(): void {
    if (this.handle !== null) this.timers.clear(this.handle)
    this.handle = null
  }

  private emit(): void {
    this.listeners.forEach((l) => l())
  }
}

/** The sneak peek (1.5 s) and the expanding view (3 s). */
export const sneakPeek = new TimedFlag(SNEAK_PEEK_MS)
export const expandingView = new TimedFlag(EXPANDING_MS)

export const useSneakPeek = (): PeekState => useSyncExternalStore(sneakPeek.subscribe, sneakPeek.get)
export const useExpandingView = (): PeekState => useSyncExternalStore(expandingView.subscribe, expandingView.get)

/** Hover opens only a closed notch with no sneak peek showing, when "open on hover" is on (ContentView.handleHover). */
export function mayOpenOnHover(state: { open: boolean; sneakPeekShowing: boolean; openOnHover: boolean }): boolean {
  return !state.open && !state.sneakPeekShowing && state.openOnHover
}
