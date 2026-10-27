import { useEffect } from "react"

/** What the page backdrop says: the Now page's state in three soft colours (alpha .1 to .2). */
export type WashState = "needsYou" | "yourTurn" | "running" | "clear" | "quiet"

const WASH: Record<WashState, readonly [string, string, string]> = {
  needsYou: ["rgb(255 138 61 / 0.19)", "rgb(255 107 87 / 0.14)", "rgb(255 179 71 / 0.12)"],
  yourTurn: ["rgb(251 191 36 / 0.16)", "rgb(255 138 61 / 0.12)", "rgb(251 191 36 / 0.1)"],
  running: ["rgb(92 225 255 / 0.16)", "rgb(124 107 255 / 0.16)", "rgb(52 211 153 / 0.1)"],
  clear: ["rgb(77 141 255 / 0.18)", "rgb(124 107 255 / 0.16)", "rgb(92 225 255 / 0.12)"],
  quiet: ["rgb(214 92 240 / 0.22)", "rgb(124 107 255 / 0.2)", "rgb(255 107 87 / 0.12)"],
}

/** Which wash the Now counts ask for: the most urgent thing wins. */
export function washFor(counts: { needsYou: number; waitingOnYou: number; running: number }, connecting = false): WashState {
  if (connecting) return "quiet"
  if (counts.needsYou > 0) return "needsYou"
  if (counts.waitingOnYou > 0) return "yourTurn"
  if (counts.running > 0) return "running"
  return "clear"
}

/** Sets --wash-a/b/c on <html>; the registered colours (index.css) glide over 1.2 s. Other pages keep the last one. */
export function setBackdropWash(state: WashState, root: HTMLElement = document.documentElement) {
  const [a, b, c] = WASH[state]
  root.style.setProperty("--wash-a", a)
  root.style.setProperty("--wash-b", b)
  root.style.setProperty("--wash-c", c)
  root.dataset.wash = state
}

export function useBackdropWash(state: WashState) {
  useEffect(() => setBackdropWash(state), [state])
}
