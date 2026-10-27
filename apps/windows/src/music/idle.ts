// Inactivity timeout (MusicManager.updateIdleState): while music plays the player is active; after it pauses the player
// stays "not idle" for `waitInterval` seconds, then becomes idle (the closed notch drops its music activity). Playing
// again cancels the countdown. Time is injected so it is testable.

export interface Clock {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export const realClock: Clock = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export class IdleTracker {
  idle = true
  private handle: unknown = null
  private waitSeconds: () => number
  private onChange: (idle: boolean) => void
  private clock: Clock
  constructor(waitSeconds: () => number, onChange: (idle: boolean) => void, clock: Clock = realClock) {
    this.waitSeconds = waitSeconds
    this.onChange = onChange
    this.clock = clock
  }

  /** Call on every playing/paused change (and once at the start). */
  playing(isPlaying: boolean): void {
    this.cancel()
    if (isPlaying) {
      this.set(false)
      return
    }
    const wait = Math.max(0, this.waitSeconds())
    this.handle = this.clock.set(() => {
      this.handle = null
      this.set(true)
    }, wait * 1000)
  }

  dispose(): void {
    this.cancel()
  }

  private cancel() {
    if (this.handle !== null) this.clock.clear(this.handle)
    this.handle = null
  }

  private set(idle: boolean) {
    if (this.idle === idle) return
    this.idle = idle
    this.onChange(idle)
  }
}

/** The closed notch shows the music activity while playing or not yet idle (and the setting is on). */
export function showsMusicActivity(o: { isPlaying: boolean; idle: boolean; liveActivity: boolean; hiddenForFullscreen: boolean; active: boolean }): boolean {
  return o.liveActivity && o.active && !o.hiddenForFullscreen && (o.isPlaying || !o.idle)
}
