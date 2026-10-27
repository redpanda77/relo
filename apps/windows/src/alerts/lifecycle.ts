// The app's start and its end, in sound (ReloMoments launch rules, boringNotchApp.swift `applicationShouldTerminate`):
//   - the launch cue plays once per run, unless Windows started the app at sign-in (`--at-login`);
//   - quitting plays the quit cue and tells Rust how long it lasts, so Rust delays the exit by that (at most 2 s).
// Pure over the ports it is given; Notch.tsx wires the real ones.

export interface LaunchDeps {
  /** Windows started the app at sign-in (Rust read `--at-login`). */
  startedAtLogin: () => Promise<boolean>
  /** `alerts.launchCue`: plays "launch" unless `atLogin`. */
  launchCue: (options: { atLogin: boolean }) => boolean
  /** The cues are decoded (a cue played before that is silent). */
  ready?: () => Promise<void>
}

let launchCued = false

/** Plays the launch cue the first time it is called in this run; later calls do nothing. Returns whether a cue played. */
export async function cueLaunchOnce(deps: LaunchDeps): Promise<boolean> {
  if (launchCued) return false
  launchCued = true
  const atLogin = await deps.startedAtLogin().catch(() => false)
  if (!atLogin) await deps.ready?.().catch(() => undefined)
  return deps.launchCue({ atLogin })
}

/** Test hook. */
export function resetLaunchCue(): void {
  launchCued = false
}

export interface QuitDeps {
  /** Rust asks the page to quit (tray Quit, Settings Quit). */
  onQuitRequest: (cb: () => void) => () => void
  /** `alerts.quitSound`: plays "quit"; the milliseconds to wait before exiting (0 = exit now). */
  quitSound: () => number
  /** Tells Rust how long to wait. */
  quitReady: (ms: number) => Promise<void> | void
}

/** Answers every quit request with the quit cue's length. Returns the unsubscribe. */
export function answerQuitRequests(deps: QuitDeps): () => void {
  return deps.onQuitRequest(() => {
    let ms = 0
    try {
      ms = Math.max(0, Math.min(2000, deps.quitSound()))
    } catch {
      ms = 0 // a sound that fails must not hold the exit
    }
    void Promise.resolve(deps.quitReady(ms)).catch(() => {})
  })
}
