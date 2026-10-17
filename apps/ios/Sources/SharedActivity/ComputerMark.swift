import ReloCore
import SwiftUI

/// A computer's icon, with its name when given. An unknown icon reads as a laptop (`ComputerIcon`), so
/// every place a computer appears draws the same mark. Compiled into the app and the widget like `SourceLogo`.
struct ComputerMark: View {
    var icon: ComputerIcon?
    var name: String? = nil
    var tint: Color? = nil

    var body: some View {
        let symbol = (icon ?? .laptop).systemImageName
        if let name {
            Label(name, systemImage: symbol).foregroundStyle(tint ?? Color.primary)
        } else {
            Image(systemName: symbol).foregroundStyle(tint ?? Color.primary).accessibilityLabel((icon ?? .laptop).label)
        }
    }

    /// The same mark inside a line of text ("… · 12:01 AM · 􀟛 MacBook Pro").
    static func text(icon: ComputerIcon?, name: String) -> Text {
        Text(Image(systemName: (icon ?? .laptop).systemImageName)) + Text(" " + name)
    }
}
