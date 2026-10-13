import SwiftUI

/// Status changes paint inside a fixed toolbar control; they never enter the feed.
struct ReloNowStatusLabel: View {
    let updating: Bool
    let symbol: String

    var body: some View {
        ZStack {
            Image(systemName: symbol).opacity(updating ? 0 : 1)
            ProgressView().opacity(updating ? 1 : 0)
        }
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
}
