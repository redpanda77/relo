/**
 * The server's first frame (apps/server/src/web/dashboard-skeleton.ts) giving way to React's.
 *
 * React's first commit replaces the skeleton at the same geometry, so the structure (title, deck,
 * readouts) does not move. What was only a placeholder leaves gently: the skeleton rows stay on top
 * as a still copy and fade out while the real rows fade in (opacity only), and words that were on
 * screen under the core ("Starting Relo") keep their minimum 500 ms before they fade. Every copy is
 * gone within a fade's time even when the page gets no frames. The painted core does not
 * snap: React's takes the skeleton's breath over on the same beat until the scene is ready.
 */

import { putOnBeat } from "@/lib/heartbeat"

/** Loops in the skeleton that ride the heartbeat (`lib/heartbeat.ts`). */
const SKELETON_LOOPS = new Set(["loading-breath", "skeleton-sweep"])
/** "Starting Relo" appears this long after the document starts (loading.css). */
const WORDS_AT_MS = 1000
const MIN_SHOWN_MS = 500
const FADE_MS = 260

/**
 * The skeleton's loops started before the heartbeat existed: move their timelines onto the page's
 * beat, as the heartbeat does for every loop that starts later (the core's breath set that beat, so
 * it stays where it is). Only timelines move.
 */
export function keepSkeletonOnBeat() {
  onBeat(document)
}

/** Moves the skeleton loops under `node` onto the beat now (before the frame paints). */
function onBeat(node: Document | Element) {
  if (typeof node.getAnimations !== "function") return
  for (const animation of node.getAnimations()) {
    if ("animationName" in animation && SKELETON_LOOPS.has(String(animation.animationName))) putOnBeat(animation)
  }
}

/**
 * React's painted core on its first frame: while the skeleton's breath is being handed over
 * (loading.css `[data-skeleton-core]`), it breathes on the same phase, so its opacity on the commit
 * is the skeleton's. Without a hand-off it rests at its still opacity, as before.
 */
export function continueSkeletonBreath(painted: Element | null) {
  if (painted && document.documentElement.dataset.skeletonCore) onBeat(painted)
}

/** The scene took over (or the stage left): the painted core stops breathing from here on. */
export function endSkeletonBreath() {
  delete document.documentElement.dataset.skeletonCore
}

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
}

/** A still copy of `node` over the page where it stands, for its exit. */
function ghostOf(node: Element, layer: HTMLElement) {
  const rect = node.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  const copy = node.cloneNode(true) as HTMLElement
  copy.removeAttribute("id")
  Object.assign(copy.style, {
    position: "fixed",
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
  })
  // Frozen as it looks now: a copy would restart its timed reveals from the beginning.
  const originals = [node, ...node.querySelectorAll("*")]
  const copies = [copy, ...copy.querySelectorAll<HTMLElement>("*")]
  originals.forEach((original, index) => {
    const target = copies[index]
    if (!target?.style) return
    const style = getComputedStyle(original)
    target.style.animation = "none"
    target.style.opacity = style.opacity
    target.style.visibility = style.visibility
  })
  layer.append(copy)
  return copy
}

/**
 * Fades a still copy out, then removes it. A timer backs the fade: an animation gets no frames
 * while the page is hidden (a background tab, a phone switching apps), and a copy left on screen
 * would sit over the real page.
 */
function fadeOut(node: HTMLElement, delay: number, done: () => void) {
  let gone = false
  const finish = () => {
    if (gone) return
    gone = true
    node.remove()
    done()
  }
  if (reducedMotion() || typeof node.animate !== "function") {
    window.setTimeout(finish, delay)
    return
  }
  const fade = node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, delay, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" })
  fade.onfinish = finish
  window.setTimeout(finish, delay + FADE_MS + 120)
}

/**
 * Call just before rendering; call the function it returns right after. When React's commit removes
 * the skeleton, the placeholder parts leave as described above. Without a skeleton, nothing happens.
 */
export function handOffSkeleton(): () => void {
  const skeleton = document.querySelector("[data-page-skeleton]")
  const host = document.getElementById("root")
  if (!skeleton || !host) return () => undefined
  // The skeleton's core is breathing: React's painted core continues it (loading.css).
  if (skeleton.querySelector("[data-loading-core]") && !reducedMotion()) document.documentElement.dataset.skeletonCore = "breathing"
  return () => {
    // Measured now (the skeleton is still the page), shown once React has replaced it.
    const layer = document.createElement("div")
    layer.className = "loading-ghosts"
    layer.setAttribute("aria-hidden", "true")
    const rows = [...skeleton.querySelectorAll("[data-skeleton-rows]")]
    const words = [...skeleton.querySelectorAll(".loading-words")].find((node) =>
      [...node.children].some((part) => getComputedStyle(part).opacity !== "0" && getComputedStyle(part).visibility !== "hidden"))
    const rowsGhosts = rows.flatMap((list) => ghostOf(list, layer) ?? [])
    const wordsGhost = words ? ghostOf(words, layer) : null
    // Under the core the words keep their minimum time; under a list they would sit over the real
    // rows that replace the placeholder, so they leave with the rows.
    const hold = words?.closest(".orb-stage") ? Math.max(0, MIN_SHOWN_MS - (performance.now() - WORDS_AT_MS)) : 0

    const observer = new MutationObserver(() => {
      if (skeleton.isConnected) return
      observer.disconnect()
      // A hidden page shows nothing to fade (and gets no animation frames to fade it with).
      if ((!rowsGhosts.length && !wordsGhost) || document.hidden) return
      document.body.append(layer)
      const root = document.documentElement
      root.dataset.skeletonHandoff = "true"
      let pending = rowsGhosts.length + Number(Boolean(wordsGhost))
      const settle = () => {
        pending -= 1
        if (pending > 0) return
        layer.remove()
        delete root.dataset.skeletonHandoff
      }
      for (const ghost of rowsGhosts) fadeOut(ghost, 0, settle)
      if (wordsGhost) fadeOut(wordsGhost, hold, settle)
    })
    observer.observe(host, { childList: true, subtree: true })
  }
}
