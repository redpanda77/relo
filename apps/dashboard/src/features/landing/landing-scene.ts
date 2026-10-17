/**
 * The landing hero's entry chunk (the server preloads it by this path): the shared Relo core in its
 * hero framing (`lib/orb-scene.ts`).
 */
import { createOrbScene, type OrbScene } from "@/lib/orb-scene"

export { supportsWebGL } from "@/lib/orb-scene"
export type LandingScene = OrbScene

export function createLandingScene(
  canvas: HTMLCanvasElement,
  options: { reducedMotion: boolean; onReady?: () => void; onLost?: () => void }
): LandingScene {
  return createOrbScene(canvas, { ...options, framing: "hero" })
}
