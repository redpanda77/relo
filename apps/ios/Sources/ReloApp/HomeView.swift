import SwiftUI

/// Authentication is the only gate. Each connected destination owns its navigation.
struct HomeView: View {
    @Bindable var model: AppModel
    var body: some View {
        Group {
            if model.hasLocalAccountAccess && (model.hasRestoredLocalAccount || model.accountState != .restoring) {
                ReloRootView(model: model).id(model.presentationScopeIdentity)
            } else if model.accountState == .restoring {
                ProgressView("Restoring your account…").frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.reloCanvas)
            } else {
                OnboardingView(model: model)
            }
        }.tint(.reloInteractive)
    }
}
#if DEBUG
#Preview("Ready · Light") { HomeView(model: .preview(state: .ready)).preferredColorScheme(.light) }
#Preview("Ready · Dark") { HomeView(model: .preview(state: .ready)).preferredColorScheme(.dark) }
#Preview("No saved activity") { HomeView(model: .preview(state: .noCacheOffline)) }
#Preview("Offline") { HomeView(model: .preview(state: .offline)) }
#Preview("Welcome") { HomeView(model: .preview(state: .signedOut)) }
#Preview("Large text") { HomeView(model: .preview(state: .ready)).environment(\.dynamicTypeSize, .accessibility3) }
#Preview("Dense history") { NavigationStack { HistoryView(model: .preview(state: .denseHistory)) } }
#Preview("Response states") { HomeView(model: .preview(state: .responseStates)) }
#Preview("Long detail") {
    let model = AppModel.preview(state: .longContent)
    NavigationStack { NotificationDetailView(model: model, item: model.items[0]) }
}
#Preview("Settings · Light") { NavigationStack { SettingsView(model: .preview(state: .ready)) }.preferredColorScheme(.light) }
#Preview("Settings · Dark") { NavigationStack { SettingsView(model: .preview(state: .ready)) }.preferredColorScheme(.dark) }
#Preview("Recovery") { HomeView(model: .preview(state: .reauthenticationRequired)) }
#endif
