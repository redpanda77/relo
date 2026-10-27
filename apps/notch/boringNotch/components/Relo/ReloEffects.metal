// The effect painters' shapes on the GPU (ReloEffectRenderer): each shape is one instanced quad whose fragment works out
// its own coverage (signed distance, with a pixel of antialiasing), its shading (colour or a linear or radial gradient of
// up to four stops) and its clips (a rect, a rounded rect, the notch's own shape as a mask). Two pipelines share these
// functions: drawn over, and added (plusLighter). Also the wings' light noise, used here and by the SwiftUI Canvas the
// snapshot bench pins (`reloWingLight`), so both draw the same light.
#include <metal_stdlib>
#include <SwiftUI/SwiftUI_Metal.h>
using namespace metal;

// MARK: - The wings' light noise

static float wingHash(float2 p) {
    p = fract(p * float2(127.1, 311.7));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
}

static float wingNoise(float2 p) {
    float2 i = floor(p), f = fract(p);
    float2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(wingHash(i), wingHash(i + float2(1, 0)), u.x),
               mix(wingHash(i + float2(0, 1)), wingHash(i + float2(1, 1)), u.x), u.y);
}

static float wingFbm(float2 p) {
    float value = 0.0, amplitude = 0.5;
    for (int octave = 0; octave < 3; octave++) {
        value += amplitude * wingNoise(p);
        p = p * 2.07 + float2(13.7, 5.3);
        amplitude *= 0.5;
    }
    return value;
}

/// How bright the light is at a point: the band of the state's colour modulated by slow noise that flows from the
/// notch's outer edges toward the camera.
static float wingLightGain(float2 position, float2 size, float time) {
    float fromEdge = min(position.x, size.x - position.x);
    float2 q = float2(fromEdge * 0.05 - time * 0.42, position.y * 0.11 + time * 0.06);
    return 0.45 + 1.1 * wingFbm(q);
}

// The Canvas wings apply it as a colour shader to the light layer only, so the orbit, the bar and the chips stay crisp.
[[ stitchable ]] half4 reloWingLight(float2 position, half4 color, float2 size, float time) {
    return color * half(wingLightGain(position, size, time));
}

// MARK: - Shapes

// Mirrors ReloEffectQuad in ReloEffectRenderer.swift, field for field.
struct Quad {
    float4 rect;        // the local rect to cover (x, y, w, h), margin included
    float4 m;           // local → canvas: a, b, c, d
    float4 t;           // tx, ty, pixels per local unit, opacity
    float4 shape;       // the shape's own rect (x, y, w, h), local
    float4 p;           // corner radius, line width, blur sigma, noise time (the wing light: the painter's size in x, y)
    uint4 k;            // kind, shading, flags, stop count
    uint4 line;         // first point, point count
    float4 clip;        // canvas clip rect: minX, minY, maxX, maxY
    float4 rclip;       // canvas rounded clip: x, y, w, h
    float4 rclipR;      // its corner radius; canvas size (y, z); canvas pixels per point (w)
    float4 g;           // linear (x0, y0, x1, y1) or radial (cx, cy, r0, r1), local
    float4 colors[8];   // straight RGBA stops; the wing light's pool in 4…6
    float4 locs0;
    float4 locs1;
    float4 g2;          // wing light: mask (x0, y0, x1, y1)
    float4 maskA;       // wing light: mask alphas a0, a1 at l0, l1
    float4 g3;          // wing light: pool (cx, cy, 0, r1)
};

enum Kind : uint {
    kEllipseFill = 0, kEllipseStroke = 1, kRoundedRectFill = 2, kPillBorder = 3, kGlowRect = 4,
    kLines = 5, kBlurredLines = 6, kWingLight = 7, kTexture = 8, kArc = 9
};
enum Shading : uint { sColor = 0, sLinear = 1, sRadial = 2 };
enum Flags : uint { fBody = 1, fRoundedClip = 2, fButt = 4 };

struct VOut {
    float4 position [[position]];
    float2 local;
    float2 canvas;
    float2 uv;
    uint index [[flat]];
};

vertex VOut reloEffectVertex(uint vid [[vertex_id]], uint iid [[instance_id]], constant Quad *quads [[buffer(0)]],
                             constant float2 &canvas [[buffer(1)]]) {
    constant Quad &q = quads[iid];
    float2 corner = float2(vid & 1, vid >> 1);
    float2 local = q.rect.xy + corner * q.rect.zw;
    float2 c = float2(q.m.x * local.x + q.m.z * local.y + q.t.x, q.m.y * local.x + q.m.w * local.y + q.t.y);
    VOut out;
    out.position = float4(c.x / canvas.x * 2 - 1, 1 - c.y / canvas.y * 2, 0, 1);
    out.local = local;
    out.canvas = c;
    out.uv = corner;
    out.index = iid;
    return out;
}

static float coverage(float d, float scale) { return clamp(0.5 - d * scale, 0.0, 1.0); }

static float sdRoundedRect(float2 p, float4 r, float radius) {
    float2 c = r.xy + r.zw * 0.5, h = r.zw * 0.5;
    radius = min(radius, min(h.x, h.y));
    float2 q = abs(p - c) - h + radius;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

static float sdEllipse(float2 p, float4 r) {
    float2 c = r.xy + r.zw * 0.5, radii = max(r.zw * 0.5, 1e-4);
    float2 d = p - c;
    float k0 = length(d / radii), k1 = length(d / (radii * radii));
    return k1 > 0 ? k0 * (k0 - 1.0) / k1 : -min(radii.x, radii.y);
}

// The distance to a polyline; `butt` ends it flat at its two ends (CoreGraphics' default cap) instead of round.
static float sdLines(float2 p, constant float2 *points, uint first, uint count, bool butt) {
    float d = 1e6;
    for (uint i = 1; i < count; i++) {
        float2 a = points[first + i - 1], b = points[first + i], pa = p - a, ba = b - a;
        float h = dot(pa, ba) / max(dot(ba, ba), 1e-6);
        if (butt && ((i == 1 && h < 0) || (i == count - 1 && h > 1))) continue;
        d = min(d, length(pa - ba * clamp(h, 0.0, 1.0)));
    }
    return d;
}

// The error function (Winitzki's approximation, within 1e-4): Metal has none.
static float erfApprox(float x) {
    float x2 = x * x, a = 0.147;
    return sign(x) * sqrt(1.0 - exp(-x2 * (1.27323954 + a * x2) / (1.0 + a * x2)));
}
static float2 erfApprox(float2 x) { return float2(erfApprox(x.x), erfApprox(x.y)); }

// A Gaussian-blurred band of width w, at distance d from its centre line.
static float blurredBand(float d, float w, float sigma) {
    float s = sigma * 1.41421356;
    return 0.5 * (erfApprox((d + w * 0.5) / s) - erfApprox((d - w * 0.5) / s));
}

// A Gaussian-blurred box (the corners are left square; the bar's segments are 3 pt tall).
static float blurredBox(float2 p, float4 r, float sigma) {
    float2 c = r.xy + r.zw * 0.5, h = r.zw * 0.5;
    float s = sigma * 1.41421356;
    float2 a = 0.5 * (erfApprox((p - c + h) / s) - erfApprox((p - c - h) / s));
    return a.x * a.y;
}

static float4 premultiply(float4 c) { return float4(c.rgb * c.a, c.a); }

// A gradient's colour at x, premultiplied: CoreGraphics interpolates premultiplied, so white fading into a clear tint
// stays white rather than taking on the tint.
static float4 stops(float x, constant float4 *colors, float4 locs, uint count) {
    if (count <= 1 || x <= locs[0]) return premultiply(colors[0]);
    for (uint i = 1; i < count; i++) {
        if (x <= locs[i]) {
            float span = locs[i] - locs[i - 1];
            float f = span > 0 ? (x - locs[i - 1]) / span : 1.0;
            return mix(premultiply(colors[i - 1]), premultiply(colors[i]), f);
        }
    }
    return premultiply(colors[count - 1]);
}

static float linearT(float2 p, float4 g) {
    float2 a = g.xy, b = g.zw, ab = b - a;
    return clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
}

static float radialT(float2 p, float4 g) {
    return clamp((length(p - g.xy) - g.z) / max(g.w - g.z, 1e-6), 0.0, 1.0);
}

static float4 shade(constant Quad &q, float2 p) {
    switch (q.k.y) {
    case sLinear: return stops(linearT(p, q.g), q.colors, q.locs0, q.k.w);
    case sRadial: return stops(radialT(p, q.g), q.colors, q.locs0, q.k.w);
    default: return premultiply(q.colors[0]);
    }
}

fragment float4 reloEffectFragment(VOut in [[stage_in]], constant Quad *quads [[buffer(0)]],
                                   constant float2 *points [[buffer(1)]], texture2d<float> image [[texture(0)]],
                                   texture2d<float> body [[texture(1)]]) {
    constexpr sampler linear(filter::linear, address::clamp_to_edge);
    constant Quad &q = quads[in.index];
    float2 p = in.local, c = in.canvas;
    float scale = q.t.z;
    float4 color;
    float cover = 1.0;
    switch (q.k.x) {
    case kEllipseFill:
        cover = coverage(sdEllipse(p, q.shape), scale);
        color = shade(q, p);
        break;
    case kEllipseStroke:
        cover = coverage(abs(sdEllipse(p, q.shape)) - q.p.y * 0.5, scale);
        color = shade(q, p);
        break;
    case kRoundedRectFill:
        cover = coverage(sdRoundedRect(p, q.shape, q.p.x), scale);
        color = shade(q, p);
        break;
    case kPillBorder: {
        // The outline of a 0.75 pt stroke, stroked 1 pt: two hairlines 0.75 pt apart that overlap into one band.
        float d = abs(sdRoundedRect(p, q.shape, q.p.x));
        float outer = coverage(abs(d - 0.375) - 0.5, scale);
        cover = outer;
        color = shade(q, p);
        break;
    }
    case kGlowRect: {
        // The shadow under, then the shape over it (colors[0] the fill, colors[1] the shadow).
        float shadow = blurredBox(p, q.shape, q.p.z);
        float shape = coverage(sdRoundedRect(p, q.shape, q.p.x), scale);
        float4 s = premultiply(q.colors[1]) * shadow;
        float4 f = premultiply(q.colors[0]) * shape;
        color = f + s * (1.0 - f.a);
        break;
    }
    case kLines:
        cover = coverage(sdLines(p, points, q.line.x, q.line.y, q.k.z & fButt) - q.p.y * 0.5, scale);
        color = shade(q, p);
        break;
    case kBlurredLines:
        cover = blurredBand(sdLines(p, points, q.line.x, q.line.y, q.k.z & fButt), q.p.y, q.p.z);
        color = shade(q, p);
        break;
    case kWingLight: {
        float4 band = stops(linearT(p, q.g), q.colors, q.locs0, 4);
        // destinationIn: only the mask's alpha counts.
        float2 ml = q.maskA.zw;
        float mt = linearT(p, q.g2);
        float mask = mt <= ml.x ? q.maskA.x : mt >= ml.y ? q.maskA.y : mix(q.maskA.x, q.maskA.y, (mt - ml.x) / max(ml.y - ml.x, 1e-6));
        float4 pool = stops(radialT(p, q.g3), q.colors + 4, q.locs1, 3);
        color = band * mask + pool;
        if (q.p.w >= 0) color *= wingLightGain(p, q.p.xy, q.p.w);
        cover = coverage(sdRoundedRect(p, q.shape, 0), scale);
        break;
    }
    case kArc: {
        // shape: centre and radius; p: line width (y), from and to in radians (z, w), increasing clockwise on screen.
        float2 d = p - q.shape.xy;
        float r = q.shape.z, from = q.p.z, sweep = min(q.p.w - q.p.z, 6.2831853);
        float rel = fmod(atan2(d.y, d.x) - from + 12.5663706, 6.2831853);
        float dist;
        if (rel <= sweep) {
            dist = abs(length(d) - r);
        } else if (q.k.z & fButt) {
            dist = 1e6;
        } else {
            float2 a = q.shape.xy + r * float2(cos(from), sin(from));
            float2 b = q.shape.xy + r * float2(cos(from + sweep), sin(from + sweep));
            dist = min(length(p - a), length(p - b));
        }
        cover = coverage(dist - q.p.y * 0.5, scale);
        color = shade(q, p);
        break;
    }
    case kTexture:
        color = image.sample(linear, in.uv);
        break;
    default:
        color = float4(0);
    }
    // Clips, in the canvas.
    float pixels = q.rclipR.w;
    cover *= coverage(sdRoundedRect(c, float4(q.clip.xy, q.clip.zw - q.clip.xy), 0), pixels);
    if (q.k.z & fRoundedClip) cover *= coverage(sdRoundedRect(c, q.rclip, q.rclipR.x), pixels);
    if (q.k.z & fBody) cover *= body.sample(linear, c / q.rclipR.yz).r;
    return color * (cover * q.t.w);
}
