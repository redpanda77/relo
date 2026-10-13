import { useSyncExternalStore } from "react"

/**
 * One 1 s clock for the whole page. Every live timer subscribes to it, so a hundred cards cost one
 * interval, and it stops while the tab is hidden or nothing is listening.
 */
let now = Date.now()
const listeners = new Set<() => void>()
let timer: number | undefined

const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden"

function tick() {
  now = Date.now()
  listeners.forEach((listener) => listener())
}

function sync() {
  const shouldRun = listeners.size > 0 && visible()
  if (shouldRun && timer === undefined) {
    tick()
    timer = window.setInterval(tick, 1000)
  } else if (!shouldRun && timer !== undefined) {
    window.clearInterval(timer)
    timer = undefined
  }
}

function subscribe(listener: () => void) {
  if (listeners.size === 0 && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", sync)
  }
  listeners.add(listener)
  sync()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", sync)
    }
    sync()
  }
}

/** The current time in ms, refreshed once a second while the page is visible. */
export function useTicker(enabled = true): number {
  return useSyncExternalStore(
    enabled ? subscribe : subscribeNothing,
    () => (enabled ? now : 0),
    () => 0
  )
}

function subscribeNothing() {
  return () => {}
}
