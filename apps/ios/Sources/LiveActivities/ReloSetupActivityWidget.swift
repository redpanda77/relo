import ActivityKit
import ReloCore
import SwiftUI
import WidgetKit

/// "Connect a computer" on the Lock Screen and in the Dynamic Island: waiting, then connected, then the agents set up
/// there. Tapping opens the wizard (relo://setup).
struct ReloSetupActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ReloSetupActivityAttributes.self) { context in
            SetupLockScreenView(state: context.state)
                .activityBackgroundTint(Color(red: 0.05, green: 0.06, blue: 0.1))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(ReloDeepLink.setupURL)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    SetupGlyph(state: state).font(.title2).padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(state.headline).font(.headline).lineLimit(1).minimumScaleFactor(0.8)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(state.agentsLine ?? SetupLockScreenView.detail(for: state))
                        .font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
            } compactLeading: {
                SetupGlyph(state: state)
            } compactTrailing: {
                if state.isConnected { Image(systemName: "checkmark").foregroundStyle(SetupGlyph.green) }
            } minimal: {
                SetupGlyph(state: state)
            }
            .widgetURL(ReloDeepLink.setupURL)
            .keylineTint(state.isConnected ? SetupGlyph.green : SetupGlyph.blue)
        }
    }
}

private struct SetupGlyph: View {
    static let blue = Color(red: 0.35, green: 0.55, blue: 1)
    static let green = Color(red: 0.3, green: 0.8, blue: 0.5)
    let state: ReloSetupActivityAttributes.ContentState

    var body: some View {
        Image(systemName: symbol)
            .foregroundStyle(state.isConnected ? Self.green : state.isExpired ? Color.orange : Self.blue)
            .accessibilityLabel(state.headline)
    }

    private var symbol: String {
        if state.isConnected { return "checkmark.circle.fill" }
        if state.isExpired { return "exclamationmark.triangle.fill" }
        return "desktopcomputer"
    }
}

private struct SetupLockScreenView: View {
    let state: ReloSetupActivityAttributes.ContentState

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            SetupGlyph(state: state).font(.title2)
            VStack(alignment: .leading, spacing: 4) {
                Text(state.headline).font(.headline).foregroundStyle(.white).lineLimit(2)
                Text(state.agentsLine ?? Self.detail(for: state))
                    .font(.subheadline).foregroundStyle(.white.opacity(0.7)).lineLimit(3)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .accessibilityElement(children: .combine)
    }

    static func detail(for state: ReloSetupActivityAttributes.ContentState) -> String {
        switch state.state {
        case "redeemed", "key_published": "Setting up Relo there."
        case "reported": "Finishing setup. Your first notification is next."
        case "tested": "Your first notification arrived."
        case "expired": "Open Relo to make a new command."
        default: "Paste the command on your computer, or give the prompt to your agent."
        }
    }
}
