import ReloCore
import SwiftUI

/// The HUD's color system. Each state owns a hue family, so the instrument reads at a glance:
/// at rest it is Relo's blue (cyan through blue to violet), running is a brighter electric cyan,
/// needs-you is orange to coral. Mint is kept for one meaning, finished work, so it still says
/// "done" when it flashes. Every ramp starts from near-black ink. See `NowSignal`.
enum ReloHoloTheme {
    static let ink = Color(red: 0x05 / 255, green: 0x06 / 255, blue: 0x0B / 255)
    static let mint = Color(red: 0x34 / 255, green: 0xD3 / 255, blue: 0x99 / 255)
    static let emerald = Color(red: 0x10 / 255, green: 0xB9 / 255, blue: 0x81 / 255)
    static let teal = Color(red: 0x2D / 255, green: 0xD4 / 255, blue: 0xBF / 255)
    static let cyan = Color(red: 0x5C / 255, green: 0xE1 / 255, blue: 1)
    static let blue = Color(red: 0x4D / 255, green: 0x8D / 255, blue: 1)
    static let sky = Color(red: 0x7D / 255, green: 0xD3 / 255, blue: 0xFC / 255)
    static let azure = Color(red: 0x38 / 255, green: 0xBD / 255, blue: 0xF8 / 255)
    static let violet = Color(red: 0x8B / 255, green: 0x7C / 255, blue: 1)
    static let magenta = Color(red: 0xD6 / 255, green: 0x5C / 255, blue: 0xF0 / 255)
    static let coral = Color(red: 1, green: 0x6B / 255, blue: 0x57 / 255)
    static let amber = Color(red: 0xFB / 255, green: 0xBF / 255, blue: 0x24 / 255)
    static let orange = Color(red: 1, green: 0x8A / 255, blue: 0x3D / 255)
    static let yellow = Color(red: 0xFA / 255, green: 0xCC / 255, blue: 0x15 / 255)
    static let red = Color(red: 0xF4 / 255, green: 0x3F / 255, blue: 0x5E / 255)

    /// The one color for each meaning. Use these, not raw hues, so color always says something.
    static func color(_ signal: NowSignal) -> Color {
        switch signal {
        case .done: mint
        case .running: cyan
        case .needsYou: orange
        case .attention: yellow
        case .failed: red
        case .message: violet
        }
    }

    /// A second shade per meaning for gradients that stay inside the meaning.
    static func deep(_ signal: NowSignal) -> Color {
        switch signal {
        case .done: emerald
        case .running: blue
        case .needsYou: coral
        case .attention: amber
        case .failed: Color(red: 0xBE / 255, green: 0x12 / 255, blue: 0x3C / 255)
        case .message: magenta
        }
    }

    /// A seamless loop for angular gradients (first and last match, so no seam shows).
    static func colors(for state: ReloSignalState) -> [Color] {
        switch state {
        case .clear: [cyan, blue, violet, blue, cyan]
        case .running: [cyan, sky, azure, sky, cyan]
        case .needsYou: [orange, coral, amber, coral, orange]
        }
    }

    /// The accent used for the sweep, pulse, labels and key readouts.
    static func accent(for state: ReloSignalState) -> Color {
        switch state {
        case .clear: blue
        case .running: cyan
        case .needsYou: orange
        }
    }

    /// Each running task's arc: all in the running family (cyan to blue, never another meaning's
    /// color), each a different shade so two tasks never read as one; their radius separates them too.
    static func taskRamp(_ index: Int) -> [Color] {
        let ramps: [[Color]] = [[cyan, blue, cyan], [sky, azure, blue], [blue, cyan, sky], [azure, sky, cyan]]
        return ramps[index % ramps.count]
    }

    /// How much of the sphere, its particles and the dust take today's meanings. The rest stays
    /// in the state's own blues, so the deck reads as Relo blue with today's work as accents.
    static let mixAccentShare = 0.28

    /// Today's meaning for a decorative element at `slot` (0–1), or nil when it keeps the state's
    /// colour: only the first `mixAccentShare` of slots carry the mix.
    static func accentSignal(_ mix: NowMix?, slot: Double) -> NowSignal? {
        guard let mix, !mix.isEmpty, slot >= 0, slot < mixAccentShare else { return nil }
        return mix.signal(at: slot / mixAccentShare)
    }

    static func label(for state: ReloSignalState) -> String {
        switch state {
        case .clear: "IDLE"
        case .running: "RUNNING"
        case .needsYou: "NEEDS YOU"
        }
    }
}
