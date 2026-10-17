/**
 * One heartbeat (`--period-breath`, 4 s) for everything that breathes. CSS loops start when their
 * element mounts, so two dots mounted a second apart would breathe out of step. This phase-locks
 * them to the document clock:
 *
 * - `--breath-epoch` on :root, set once at boot to `-(now % period)`, is the `animation-delay` of every
 *   loop, so anything painted in the first frame is already on the beat without script.
 * - Loops that start later are re-anchored on `animationstart` (it bubbles, pseudo-elements included):
 *   their start time is moved so their local time equals the document's, keeping every loop
 *   (and the half-period urgency loops) in phase. Only the timeline moves; nothing is re-rendered.
 * - The beat's origin is the document's start, unless the server's first frame was already breathing
 *   when the script arrived (skeleton-handoff.ts): then the page takes the skeleton's beat, so its
 *   core never jumps to catch up and React's core continues it.
 */
export const BREATH_PERIOD_MS = 4000
/** The keyframes that ride the heartbeat (motion.css, index.css and loading.css). */
const HEARTBEAT_LOOPS = new Set(["breathe", "status-pulse", "mission-pulse", "skeleton-sweep", "now-centre-glow", "now-step-breathe", "loading-breath", "loading-rail-travel", "orb-painted-breath"])

let started = false
let origin = 0

/** Where the beat is (0...1) at `now`, on the document clock (the WebGL halo reads it too). */
export function beatPhase(now = performance.now()) {
  return ((((now - origin) % BREATH_PERIOD_MS) + BREATH_PERIOD_MS) % BREATH_PERIOD_MS) / BREATH_PERIOD_MS
}

/** Puts one loop on the beat: its local time becomes the beat's. Only its timeline moves. */
export function putOnBeat(animation: Animation) {
  const delay = Number(animation.effect?.getTiming().delay ?? 0)
  animation.startTime = origin - delay
}

/**
 * The beat's origin: the server frame's core breath when it is already breathing (loading.css
 * `loading-breath`; it started before any script), else the document's start.
 */
function skeletonOrigin() {
  if (typeof document.getAnimations !== "function") return 0
  const breath = document.getAnimations().find((animation) =>
    "animationName" in animation && animation.animationName === "loading-breath" && animation.startTime != null)
  return breath ? Number(breath.startTime) + Number(breath.effect?.getTiming().delay ?? 0) : 0
}

export function startHeartbeat() {
  if (started || typeof document === "undefined") return
  started = true
  origin = skeletonOrigin()
  const now = typeof performance !== "undefined" ? performance.now() : 0
  document.documentElement.style.setProperty("--breath-epoch", `${-Math.round(beatPhase(now) * BREATH_PERIOD_MS)}ms`)
  document.addEventListener("animationstart", (event) => {
    if (!HEARTBEAT_LOOPS.has(event.animationName)) return
    const target = event.target
    if (!(target instanceof Element) || typeof target.getAnimations !== "function") return
    for (const animation of target.getAnimations({ subtree: Boolean(event.pseudoElement) })) {
      if (!("animationName" in animation) || animation.animationName !== event.animationName) continue
      putOnBeat(animation)
    }
  })
}
