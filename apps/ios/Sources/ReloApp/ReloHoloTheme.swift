import SwiftUI

/// Shared colors for the holographic status HUD: cool cyan to violet to magenta, with coral
/// reserved for "this needs you".
enum ReloHoloTheme {
    static let cyan = Color(red: 0x5C / 255, green: 0xE1 / 255, blue: 1)
    static let violet = Color(red: 0x8B / 255, green: 0x7C / 255, blue: 1)
    static let magenta = Color(red: 0xD6 / 255, green: 0x5C / 255, blue: 0xF0 / 255)
    static let coral = Color(red: 1, green: 0x6B / 255, blue: 0x57 / 255)

    /// A seamless loop, so an angular gradient has no visible seam.
    static func colors(for state: ReloSignalState) -> [Color] {
        switch state {
        case .clear: [cyan, violet, cyan.opacity(0.6), violet, cyan]
        case .running: [cyan, violet, magenta, violet, cyan]
        case .needsYou: [coral, magenta, violet, magenta, coral]
        }
    }

    /// The accent used for the sweep, pulse and key readouts.
    static func accent(for state: ReloSignalState) -> Color {
        switch state {
        case .clear: cyan
        case .running: violet
        case .needsYou: coral
        }
    }

    static func label(for state: ReloSignalState) -> String {
        switch state {
        case .clear: "IDLE"
        case .running: "RUNNING"
        case .needsYou: "NEEDS YOU"
        }
    }
}
