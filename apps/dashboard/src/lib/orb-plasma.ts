/**
 * The core's plasma field, baked. The field (domain-warped fbm on the unit sphere, 16 simplex noises
 * a sample) was three quarters of the scene's GPU time when every pixel of the sphere evaluated it
 * every frame. It is smooth and slow: it depends only on the direction from the core's centre and a
 * time that advances a few hundredths a second. So it is evaluated into two small cube maps, at
 * times `t0` and `t0 + BAKE_STEP`, and each pixel blends the two; when the time passes the second,
 * the first is re-baked one step further ahead. The sphere spins in its own frame, so a spin never
 * re-bakes. Without a renderable half-float target the sphere evaluates the field live, as before.
 */
import * as THREE from "three"

/**
 * The field at direction `p` (unit length, in the core's own frame) and plasma time `t`. Expects
 * `fbm` from the scene's noise chunk.
 */
export const PLASMA_FIELD = /* glsl */ `
float plasmaField(vec3 p, float uTimeValue) {
  float t = uTimeValue * 0.07;
  vec3 warp = vec3(
    fbm(p * 0.85 + vec3(t, -t * 0.8, t * 0.6)),
    fbm(p * 0.85 + vec3(5.2, 1.3, 2.8) - t),
    fbm(p * 0.85 + vec3(1.7, 9.2, 4.1) + t * 0.5));
  return fbm(p * 1.15 + warp * 1.9);
}
`

/**
 * Texels per cube face: about one texel per screen pixel where the deck's sphere faces the camera
 * (450 px buffer), so the finest filaments match the live field (96 visibly softened them).
 */
export const BAKE_SIZE = 192
/**
 * Plasma time between the two baked fields (uTime units). The field drifts a small fraction of its
 * finest detail in a step, so the blend between neighbours reads as the live field. Now's busiest
 * churn and the landing re-bake about five times a second; a calm core about once every 4 s.
 */
export const BAKE_STEP = 0.25

/** Where a cube face's texel looks: GL's face layout (spec table 3.21) inverted, from face and texel centre. */
const BAKE_FRAGMENT = (noise: string) => /* glsl */ `
uniform float uTime;
uniform int uFace;
uniform float uSize;
${noise}
${PLASMA_FIELD}
void main() {
  vec2 st = gl_FragCoord.xy / uSize * 2.0 - 1.0;
  float sc = st.x;
  float tc = st.y;
  vec3 dir;
  if (uFace == 0) dir = vec3(1.0, -tc, -sc);
  else if (uFace == 1) dir = vec3(-1.0, -tc, sc);
  else if (uFace == 2) dir = vec3(sc, 1.0, tc);
  else if (uFace == 3) dir = vec3(sc, -1.0, -tc);
  else if (uFace == 4) dir = vec3(sc, -tc, 1.0);
  else dir = vec3(-sc, -tc, -1.0);
  gl_FragColor = vec4(plasmaField(normalize(dir), uTime), 0.0, 0.0, 1.0);
}
`

export type PlasmaBake = {
  /** The orb material's uniforms for the baked field. */
  uniforms: { uFieldA: { value: THREE.Texture }; uFieldB: { value: THREE.Texture }; uFieldMix: { value: number } }
  /** Brings the two fields around plasma time `time` (bakes only when it leaves their span). */
  update(time: number): void
  dispose(): void
}

/** Whether this renderer can bake: a filterable, renderable half-float target. */
export function canBakePlasma(renderer: THREE.WebGLRenderer): boolean {
  const extensions = renderer.extensions
  return extensions.has("EXT_color_buffer_half_float") || extensions.has("EXT_color_buffer_float")
}

export function createPlasmaBake(renderer: THREE.WebGLRenderer, noise: string): PlasmaBake {
  const target = () =>
    new THREE.WebGLCubeRenderTarget(BAKE_SIZE, {
      type: THREE.HalfFloatType,
      format: THREE.RedFormat,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    })
  let a = target()
  let b = target()
  let at = Number.NaN

  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uFace: { value: 0 }, uSize: { value: BAKE_SIZE } },
    vertexShader: "void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: BAKE_FRAGMENT(noise),
    depthTest: false,
    depthWrite: false,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  quad.frustumCulled = false
  const scene = new THREE.Scene()
  scene.add(quad)
  const camera = new THREE.Camera()

  function bake(into: THREE.WebGLCubeRenderTarget, time: number) {
    const previous = renderer.getRenderTarget()
    material.uniforms.uTime!.value = time
    for (let face = 0; face < 6; face++) {
      material.uniforms.uFace!.value = face
      renderer.setRenderTarget(into, face)
      renderer.render(scene, camera)
    }
    renderer.setRenderTarget(previous)
  }

  const uniforms = { uFieldA: { value: a.texture as THREE.Texture }, uFieldB: { value: b.texture as THREE.Texture }, uFieldMix: { value: 0 } }

  return {
    uniforms,
    update(time) {
      if (!(time >= at && time < at + 2 * BAKE_STEP)) {
        // First bake, or a jump past both fields: bake the pair afresh around now.
        at = time
        bake(a, at)
        bake(b, at + BAKE_STEP)
      } else if (time >= at + BAKE_STEP) {
        // Leapfrog: the later field becomes the earlier, and one field is baked a step ahead.
        ;[a, b] = [b, a]
        at += BAKE_STEP
        bake(b, at + BAKE_STEP)
      }
      uniforms.uFieldA.value = a.texture
      uniforms.uFieldB.value = b.texture
      uniforms.uFieldMix.value = Math.min(Math.max((time - at) / BAKE_STEP, 0), 1)
    },
    dispose() {
      a.dispose()
      b.dispose()
      quad.geometry.dispose()
      material.dispose()
    },
  }
}
