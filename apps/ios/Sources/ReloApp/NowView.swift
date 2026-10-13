import ReloCore
import SwiftUI

struct NowView: View {
    @Bindable var model: AppModel
    @Binding var tab: ReloTab
    @State private var sheet: Sheet?
    @AppStorage(ReloHistoryPreferences.clearedAtKey) private var clearedAt: Double = 0
    private enum Sheet: String, Identifiable {
        case connection, signIn
        var id: Self { self }
    }

    var body: some View {
        let attention = model.attention
        let screen = model.currentPresentation
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                ReloNowHero(
                    // A clear resets today's count too: the hero only counts what is still shown.
                    summary: InboxTodaySummary.make(items: (model.historyItems + model.items).filter {
                            clearedAt <= 0 || $0.createdAt.timeIntervalSince1970 >= clearedAt
                        }, attention: attention, now: model.attentionDate),
                    needsYou: screen.actionableCount, tasks: screen.running.map {
                        ReloHoloTask(id: $0.subjectId, progress: $0.activity?.progress)
                    })
                CurrentAttentionView(model: model)
            }
            .padding(.horizontal, ReloLayout.screenInset)
            .padding(.bottom, 24)
        }
        .reloScreenBackground()
        .navigationTitle("Now").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { sheet = .connection } label: {
                    ReloNowStatusLabel(updating: isUpdating, symbol: connectionSymbol)
                }
                .accessibilityLabel(connectionLabel)
                .accessibilityHint("Shows connection details and recovery options")
            }
        }
        .refreshable { _ = await model.refresh() }
        .sheet(item: $sheet) { destination in
            NavigationStack {
                if destination == .signIn {
                    SignInView(model: model)
                } else {
                    ScrollView {
                        recovery.padding(ReloLayout.screenInset)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .reloScreenBackground()
                    .navigationTitle("Connection")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) { Button("Done") { sheet = nil } }
                    }
                }
            }
        }
    }

    private var isUpdating: Bool { model.connectionStatus.updating }
    private var connectionSymbol: String { model.connectionStatus.symbol }
    private var connectionLabel: String { model.connectionStatus.label }
    @ViewBuilder private var recovery: some View {
        if model.requiresReauthentication {
            Group {
                ReloNotice(title: "Sign in again", detail: "Your saved history is available. Sign in to reconnect.",
                           symbol: "person.crop.circle.badge.exclamationmark", actionTitle: "Sign in") { sheet = .signIn }
            }
        } else if model.accountState == .disabled {
            Group {
                ReloNotice(title: "Account needs attention", detail: "Open your dashboard to recover access.",
                           symbol: "person.crop.circle.badge.exclamationmark", actionTitle: "Open dashboard") {
                    UIApplication.shared.open(model.dashboardURL)
                }
            }
        } else if case .offline = model.syncState {
            Group {
                ReloNotice(title: "You're offline", detail: model.lastSyncedAt.map {
                    "Showing saved activity from \($0.formatted(date: .abbreviated, time: .shortened))."
                } ?? "No saved activity yet. Connect to load your Inbox.",
                           symbol: "wifi.slash", actionTitle: "Try again") { Task { _ = await model.refresh() } }
            }
        } else if case .failed = model.registrationState {
            Group {
                ReloNotice(title: "Connection needs attention", detail: "This iPhone could not register with your server.",
                           symbol: "iphone.badge.exclamationmark", actionTitle: "Review connection") { sheet = nil; tab = .settings }
            }
        } else if model.isRegistered && (model.permission != .allowed || model.pushRegistrationError != nil || !model.liveActivitiesAuthorized) {
            Group {
                ReloNotice(title: "Notification settings", detail: "History is available. Review permissions to receive alerts and Live Activities.",
                           symbol: "bell.badge", actionTitle: "Review settings") { sheet = nil; tab = .settings }
            }
        } else if !model.isRegistered {
            ReloNotice(title: "Connecting this iPhone", detail: "Saved activity is available while Relo reconnects.",
                       symbol: "iphone", actionTitle: "Review connection") { sheet = nil; tab = .settings }
        } else {
            ReloNotice(title: isUpdating ? "Updating notifications" : "Connected", detail: model.lastSyncedAt.map {
                "Last updated \($0.formatted(date: .abbreviated, time: .shortened))."
            } ?? "Relo is connected. New activity will appear in Now.",
                       symbol: "checkmark.icloud", actionTitle: "Refresh") { Task { _ = await model.refresh() } }
        }
    }
}
