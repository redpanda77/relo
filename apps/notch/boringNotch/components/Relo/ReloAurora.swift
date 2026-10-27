//
//  ReloAurora.swift
//  Relo
//
//  The backdrop of Relo's own windows (onboarding, the main window): slow light in the state colours on near
//  black, like the iPhone's orb seen from far away. Three blurred discs drift with one repeating Core Animation
//  move, so nothing is drawn per frame; with Reduce Motion they stay still.
//

import SwiftUI

struct ReloAurora: View {
    /// How bright the light is: the onboarding uses all of it, the main window less so its content reads.
    var intensity: Double = 1

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            ZStack {
                Color(red: 0.03, green: 0.03, blue: 0.055)
                // The three lights drift on Core Animation: nothing here is drawn per frame.
                ReloLoopView(key: intensity) { [intensity] root, size in
                    let w = size.width, h = size.height, c = CGPoint(x: w / 2, y: h / 2)
                    root.masksToBounds = true
                    let drift = { (t: Double) in ReloEase.reversing(t, 11) }
                    let lights: [(Color, CGFloat, CGPoint, CGPoint)] = [
                        (ReloNotchTheme.running, 0.95, CGPoint(x: w * 0.08, y: -h * 0.12), CGPoint(x: -w * 0.28, y: -h * 0.32)),
                        (ReloNotchTheme.signalCoral, 0.72, CGPoint(x: w * 0.06, y: h * 0.36), CGPoint(x: w * 0.32, y: h * 0.08)),
                        (ReloNotchTheme.done, 0.6, CGPoint(x: -w * 0.36, y: h * 0.16), CGPoint(x: -w * 0.08, y: h * 0.42))]
                    for (color, fraction, a, b) in lights {
                        let blob = ReloLoop.blob(color.opacity(0.5 * intensity), size: w * fraction, blur: w * fraction * 0.3, center: c,
                                                 scale: root.contentsScale)
                        ReloLoop.drift(blob, from: CGPoint(x: c.x + a.x, y: c.y + a.y), to: CGPoint(x: c.x + b.x, y: c.y + b.y), period: 22, drift)
                        root.addSublayer(blob)
                    }
                }
                RadialGradient(colors: [.clear, .black.opacity(0.6)], center: .center,
                               startRadius: min(w, h) * 0.2, endRadius: max(w, h) * 0.85)
            }
            .frame(width: w, height: h)
            .clipped()
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

/// Relo's wordmark: the name in a rounded heavy face with a soft light running through it.
struct ReloWordmark: View {
    var size: CGFloat = 64

    var body: some View {
        Text("Relo")
            .font(.system(size: size, weight: .bold, design: .rounded))
            .tracking(-size * 0.02)
            .foregroundStyle(
                LinearGradient(colors: [.white, Color(white: 0.86), ReloNotchTheme.sky.opacity(0.9)],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
            )
            .shadow(color: ReloNotchTheme.running.opacity(0.45), radius: size * 0.4)
            .accessibilityAddTraits(.isHeader)
    }
}

/// The primary action in Relo's own windows: a white capsule with black text.
struct ReloPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(.black)
            .padding(.horizontal, 26)
            .padding(.vertical, 11)
            .background(Capsule().fill(.white.opacity(configuration.isPressed ? 0.8 : 1)))
            .shadow(color: .white.opacity(0.25), radius: 14)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
            .contentShape(Capsule())
    }
}

/// The secondary action: a quiet glass capsule.
struct ReloSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(.white.opacity(0.85))
            .padding(.horizontal, 18)
            .padding(.vertical, 9)
            .background(Capsule().fill(.white.opacity(configuration.isPressed ? 0.16 : 0.09)))
            .overlay(Capsule().strokeBorder(.white.opacity(0.14)))
            .contentShape(Capsule())
    }
}
