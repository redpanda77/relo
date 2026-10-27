import ReloCore
import SwiftUI

/// A project's colour: one of twelve by its palette slot (`ProjectPalette`, the contracts' table), so a project reads
/// the same on every card and every surface.
enum ReloProjectPalette {
    static func color(for project: InboxProjectIdentity?, fallback: Color = .primary) -> Color {
        color(slot: project?.paletteSlot, name: project?.name) ?? fallback
    }

    static func color(slot: Int?, name: String?) -> Color? {
        ProjectPalette.slot(slot, name: name).map { slot in
            let rgb = ProjectPalette.rgb(slot)
            return Color(red: rgb.red, green: rgb.green, blue: rgb.blue)
        }
    }
}
