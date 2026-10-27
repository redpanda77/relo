//
//  ReloOrb.swift
//  Relo
//
//  Relo's orb on the Mac (ADR 0013 §6): the iPhone's plasma shader (ReloPlasmaOrb.metal, mirrored), in the palette of
//  what matters now: coral while something needs the owner, cyan while work runs, blue when all is clear. It draws at
//  most 30 frames a second while visible, and stands still with Reduce Motion.
//

import ReloNotchKit
import SwiftUI

struct ReloOrb: View {
    enum Mood { case clear, running, needsYou }

    var mood: Mood = .clear
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if ReloEffects.metal {
                // Drawn by Metal at 30 fps; SwiftUI only hands it a new mood.
                ReloEffectView(paused: reduceMotion) { [mood, reduceMotion] canvas in
                    _ = canvas.sink()
                    guard let recording = canvas.recording else { return }
                    let time = reduceMotion ? 9 : canvas.now.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 3600)
                    let palette = Self.palette(mood)
                    ReloEffectRenderer.shared?.orb(in: recording, rect: CGRect(origin: .zero, size: canvas.size), time: time,
                                                   energy: Self.energy(mood), palette: [palette[0], palette[1], palette[2], palette[1]])
                }
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
                    let time = reduceMotion ? 9 : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 3600)
                    GeometryReader { proxy in
                        let palette = Self.palette(mood)
                        Rectangle().fill(.black)
                            .colorEffect(ShaderLibrary.reloPlasmaOrb(
                                .float2(proxy.size), .float(Float(time)), .float(Float(Self.energy(mood))),
                                .color(palette[0]), .color(palette[1]), .color(palette[2]), .color(palette[1]),
                                .float4(0.34, 0.67, 0.9, 1), .float2(CGPoint.zero), .float(-1)))
                    }
                }
                .clipShape(Circle())
            }
        }
        // The glow is cast by a still disc under the sphere, not by the moving plasma (which re-rendered it each frame).
        .background {
            Circle().fill(.black).scaleEffect(0.66)
                .shadow(color: Self.palette(mood)[0].opacity(0.45), radius: 30)
        }
        .animation(ReloMotion.base, value: mood)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private static func energy(_ mood: Mood) -> Double {
        switch mood {
        case .clear: 0.35
        case .running: 0.7
        case .needsYou: 1
        }
    }

    /// The iPhone's ReloHoloTheme.colors(for:).
    static func palette(_ mood: Mood) -> [Color] {
        let cyan = Color(red: 0x5C / 255, green: 0xE1 / 255, blue: 1), blue = Color(red: 0x4D / 255, green: 0x8D / 255, blue: 1)
        let violet = Color(red: 0x8B / 255, green: 0x7C / 255, blue: 1), sky = Color(red: 0x7D / 255, green: 0xD3 / 255, blue: 0xFC / 255)
        let azure = Color(red: 0x38 / 255, green: 0xBD / 255, blue: 0xF8 / 255), orange = Color(red: 1, green: 0x8A / 255, blue: 0x3D / 255)
        let coral = Color(red: 1, green: 0x6B / 255, blue: 0x57 / 255), amber = Color(red: 0xFB / 255, green: 0xBF / 255, blue: 0x24 / 255)
        switch mood {
        case .clear: return [cyan, blue, violet]
        case .running: return [cyan, sky, azure]
        case .needsYou: return [orange, coral, amber]
        }
    }

    /// The orb's mood from what the store shows.
    static func mood(_ presentation: NotchPresentation) -> Mood {
        if presentation.needsYouCount > 0 { return .needsYou }
        if presentation.sections.contains(where: { $0.kind == .running && !$0.rows.isEmpty }) { return .running }
        return .clear
    }
}
