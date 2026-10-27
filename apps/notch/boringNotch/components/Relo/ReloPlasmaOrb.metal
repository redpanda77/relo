// Mirrors apps/ios/Sources/ReloApp/ReloPlasmaOrb.metal (ADR 0013 §6: the orb is Relo's visual on every surface).
// Change both together.
#include <metal_stdlib>
#include <SwiftUI/SwiftUI_Metal.h>
using namespace metal;

// The Now core: a sphere of slowly churning plasma. Its colors are today's meanings in
// proportion (up to four, with cumulative weights), lit by a rim so it reads as a volume,
// with a darker heart so the count over it stays legible. A ripple from a touch warps it.

static float hash21(float2 p) {
    p = fract(p * float2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

static float noise2(float2 p) {
    float2 i = floor(p), f = fract(p);
    float2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + float2(1, 0)), u.x),
               mix(hash21(i + float2(0, 1)), hash21(i + float2(1, 1)), u.x), u.y);
}

// Octaves are kept low on purpose: the orb is small and slow, so 3–4 layers read the same as
// more while costing far less per pixel (battery).
static float fbm(float2 p, int octaves) {
    float value = 0.0, amplitude = 0.5;
    for (int octave = 0; octave < octaves; octave++) {
        value += amplitude * noise2(p);
        p = p * 2.03 + float2(17.1, 9.2);
        amplitude *= 0.5;
    }
    return value;
}

// Blend through up to four colors at cumulative stops w.x <= w.y <= w.z <= 1.
static half3 ramp(float t, half3 c0, half3 c1, half3 c2, half3 c3, float4 w) {
    float soft = 0.06;
    half3 color = c0;
    color = mix(color, c1, half(smoothstep(w.x - soft, w.x + soft, t)));
    color = mix(color, c2, half(smoothstep(w.y - soft, w.y + soft, t)));
    color = mix(color, c3, half(smoothstep(w.z - soft, w.z + soft, t)));
    return color;
}

[[ stitchable ]] half4 reloPlasmaOrb(float2 position, half4 input, float2 size, float time, float energy,
                                     half4 c0, half4 c1, half4 c2, half4 c3, float4 weights,
                                     float2 touch, float touchAge) {
    float scale = min(size.x, size.y) * 0.5;
    float2 uv = (position - size * 0.5) / scale;

    // A ripple from the last touch or event: a ring travelling outward that bends the plasma
    // and lights it as it passes.
    float touchLight = 0.0;
    if (touchAge >= 0.0 && touchAge < 2.0) {
        float2 t = (touch - size * 0.5) / scale;
        float2 d = uv - t;
        float dist = length(d) + 1e-4;
        float front = touchAge * 1.6;
        float band = exp(-pow((dist - front) / 0.10, 2.0)) * exp(-touchAge * 1.6);
        uv += d / dist * band * 0.08;
        touchLight = band;
    }

    // A slow ambient ripple from the heart every few seconds, so the core always breathes.
    float period = 5.5 - 2.0 * energy;
    float phase = fract(time / period);
    float centre = length(uv);
    float ambient = exp(-pow((centre - phase * 0.8) / 0.045, 2.0)) * (1.0 - phase) * (0.35 + 0.35 * energy);
    uv *= 1.0 - ambient * 0.03;

    const float radius = 0.66;
    float r = length(uv);

    // Halo outside the sphere, in the dominant color, fading to nothing.
    half3 lead = ramp(0.0, c0.rgb, c1.rgb, c2.rgb, c3.rgb, weights);
    if (r > radius) {
        // Reaches exactly zero before the view's edge (r = 1), so no square shows around the orb.
        float halo = exp(-(r - radius) * 7.0) * (0.22 + 0.22 * energy) * smoothstep(0.98, 0.78, r);
        return half4(lead * half(halo), half(halo));
    }

    // Sphere geometry: a normal from the disc, so the plasma wraps a volume.
    float z = sqrt(max(radius * radius - r * r, 0.0)) / radius;
    float3 n = float3(uv / radius, z);
    float speed = 0.05 + 0.07 * energy;
    float2 flow = n.xy * 1.35 / (0.55 + z * 0.45) + float2(time * speed, -time * speed * 0.6);

    // Domain-warped noise: the plasma folds over itself slowly.
    float2 warp = float2(fbm(flow + time * 0.07, 3), fbm(flow + float2(5.2, 1.3) - time * 0.05, 3));
    float field = fbm(flow + 1.7 * warp, 4);

    // Sections by meaning: each color owns a slice of the sphere sized by its share, turning
    // slowly with the surface; the plasma makes the borders turbulent instead of straight.
    float longitude = atan2(n.y, n.x) / 6.2831853 + 0.5 + time * (0.012 + 0.02 * energy);
    float sector = fract(longitude + (field - 0.5) * 0.22);
    half3 plasma = ramp(sector, c0.rgb, c1.rgb, c2.rgb, c3.rgb, weights);
    // Within a section, the field shades between light and dark so it never looks flat.
    plasma *= half(0.65 + 0.7 * field);

    // Bright filaments where the field folds; they carry the energy of the state.
    float filament = pow(1.0 - abs(fbm(flow * 2.0 + warp * 2.0, 3) * 2.0 - 1.0), 6.0);
    plasma += half3(filament * (0.35 + 0.45 * energy));

    // Rim light, a soft key light from the top left, and a dark heart behind the count.
    float rim = pow(1.0 - z, 2.4);
    float key = clamp(dot(n, normalize(float3(-0.45, -0.55, 0.7))), 0.0, 1.0);
    float heart = mix(0.38, 1.0, smoothstep(0.10, 0.62, r / radius));
    half3 color = plasma * half(0.30 + 0.55 * key) * half(heart) + lead * half(rim * 1.1);
    // Ripples light the plasma as they pass: the ambient one softly, a touch brightly.
    color += plasma * half(ambient * 1.4) + half3(touchLight * 0.55) + plasma * half(touchLight * 1.2);

    // Antialiased edge.
    float edge = smoothstep(radius, radius - 0.012, r);
    float alpha = edge * (0.82 + 0.18 * rim);
    return half4(color * half(alpha), half(alpha));
}

// MARK: - The Mac's orb layer (not mirrored: the iPhone draws the orb through SwiftUI)

// The orb drawn by ReloEffectRenderer into a CAMetalLayer at 30 fps, so SwiftUI does not redraw it every frame. It is
// the same function above, over one quad covering the orb's view.
struct ReloOrbUniforms {
    float4 rect;    // the orb's view in the layer: x, y, w, h (points)
    float2 canvas;  // the layer, in points
    float time;
    float energy;
    float4 colors[4];
    float4 weights;
};

struct ReloOrbOut {
    float4 position [[position]];
    float2 local;
};

vertex ReloOrbOut reloOrbVertex(uint vid [[vertex_id]], constant ReloOrbUniforms &u [[buffer(0)]]) {
    float2 corner = float2(vid & 1, vid >> 1);
    float2 p = u.rect.xy + corner * u.rect.zw;
    ReloOrbOut out;
    out.position = float4(p.x / u.canvas.x * 2 - 1, 1 - p.y / u.canvas.y * 2, 0, 1);
    out.local = corner * u.rect.zw;
    return out;
}

fragment half4 reloOrbFragment(ReloOrbOut in [[stage_in]], constant ReloOrbUniforms &u [[buffer(0)]]) {
    return reloPlasmaOrb(in.local, half4(0, 0, 0, 1), u.rect.zw, u.time, u.energy,
                         half4(u.colors[0]), half4(u.colors[1]), half4(u.colors[2]), half4(u.colors[3]), u.weights,
                         float2(0), -1);
}
