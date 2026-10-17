/** The Dashboard's live update channel: Server-Sent Event hints from the server's change hub. */
export const NOW_EVENTS_PATH = "/api/dashboard/events"
/** A burst of hints becomes one refetch this long after the first of them. */
export const HINT_DEBOUNCE_MS = 750
/** Hint refetches start at least this far apart. */
export const HINT_MIN_GAP_MS = 2_000
/** Reconnect delays after an error double from here up to the 60 s poll, which keeps running anyway. */
export const RECONNECT_BASE_MS = 2_000
export const RECONNECT_MAX_MS = 60_000

/**
 * Listen for the server's "something of yours changed" hints while the tab is visible and call
 * `refetch` for them, debounced and rate-limited. A hint carries no state and nothing here decides
 * any: the timers only schedule a read of the server's Now or a reconnect. The stream closes when
 * the tab hides and reopens when it shows; the server sends a hint on every (re)connect, so a
 * reconnect reads again. Returns the teardown. Without EventSource it does nothing (the poll stays).
 */
export function connectNowLive(refetch: () => void, url: string = NOW_EVENTS_PATH): () => void {
  if (typeof EventSource === "undefined") return () => {}
  let source: EventSource | null = null
  let stopped = false
  let failures = 0
  let reconnect: number | undefined
  let debounce: number | undefined
  let cooldown: number | undefined
  let queued = false

  const fire = () => {
    debounce = undefined
    refetch()
    // The next hint refetch can start HINT_MIN_GAP_MS after this one (cooldown plus its debounce).
    cooldown = window.setTimeout(() => {
      cooldown = undefined
      if (queued) { queued = false; onHint() }
    }, HINT_MIN_GAP_MS - HINT_DEBOUNCE_MS)
  }
  const onHint = () => {
    if (cooldown !== undefined) { queued = true; return }
    if (debounce === undefined) debounce = window.setTimeout(fire, HINT_DEBOUNCE_MS)
  }
  const clearHints = () => {
    window.clearTimeout(debounce); debounce = undefined
    window.clearTimeout(cooldown); cooldown = undefined
    queued = false
  }
  const close = () => {
    window.clearTimeout(reconnect); reconnect = undefined
    source?.close(); source = null
  }
  const open = () => {
    if (stopped || source || document.visibilityState === "hidden") return
    const next = new EventSource(url)
    source = next
    next.onopen = () => { failures = 0 }
    next.addEventListener("changed", onHint)
    next.onerror = () => {
      // Take reconnects over from the browser so a failing stream backs off instead of retrying every few seconds.
      if (source !== next) return
      close()
      if (stopped || document.visibilityState === "hidden") return
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** failures)
      failures += 1
      reconnect = window.setTimeout(() => { reconnect = undefined; open() }, delay)
    }
  }
  const onVisibility = () => {
    if (document.visibilityState === "hidden") { close(); clearHints() }
    else open()
  }

  open()
  document.addEventListener("visibilitychange", onVisibility)
  return () => {
    stopped = true
    document.removeEventListener("visibilitychange", onVisibility)
    close()
    clearHints()
  }
}
