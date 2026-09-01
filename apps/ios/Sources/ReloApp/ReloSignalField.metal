#include <metal_stdlib>
#include <SwiftUI/SwiftUI_Metal.h>

using namespace metal;

float reloNoise(float2 point) {
    return fract(sin(dot(point, float2(12.9898, 78.233))) * 43758.5453);
}

[[ stitchable ]] half4 reloSignalField(
    float2 position,
    half4 currentColor,
    float time,
    half4 coral,
    half4 indigo,
    float intensity
) {
    float2 uv = position / 820.0;
    float phase = time * 0.12;

    float coralPath = 0.72 + sin(uv.y * 4.1 + phase) * 0.12;
    float indigoPath = 0.12 + cos(uv.y * 3.3 - phase * 0.8) * 0.1;
    float coralGlow = 1.0 - smoothstep(0.0, 0.42, abs(uv.x - coralPath));
    float indigoGlow = 1.0 - smoothstep(0.0, 0.36, abs(uv.x - indigoPath));
    float breathe = 0.92 + sin(uv.y * 8.0 - phase * 1.7) * 0.08;

    half3 color = currentColor.rgb;
    color = mix(color, coral.rgb, half(coralGlow * breathe * 0.34 * intensity));
    color = mix(color, indigo.rgb, half(indigoGlow * 0.25 * intensity));

    float grain = reloNoise(position + float2(time * 12.0, -time * 9.0)) - 0.5;
    color += half3(grain * 0.022 * intensity);
    return half4(color, 1.0);
}
