import ReloCore
import SwiftUI

/// A project's color: one of three, by its palette slot, so a project reads the same on every card.
enum ReloProjectPalette {
    static func color(for project: InboxProjectIdentity?, fallback: Color = .primary) -> Color {
        guard let slot = project?.paletteSlot else { return fallback }
        switch slot % 3 {
        case 0: return .reloInteractive
        case 1: return .reloSignalIndigo
        default: return .reloSignalCoral
        }
    }
}
