import ReloCore
import SwiftUI

struct ReloRootView: View {
    @Bindable var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var navigation = ReloNavigationState()
    init(model: AppModel, initialTab: ReloTab = .now) {
        self.model = model
        var initial = ReloNavigationState()
        initial.transition(to: model.presentationScopeIdentity)
        initial.tab = initialTab
        _navigation = State(initialValue: initial)
    }
    var body: some View {
        TabView(selection: $navigation.tab) {
            stack(.now) { NowView(model: model, tab: $navigation.tab) }
                .tabItem { Label("Now", systemImage: "bolt.circle") }.tag(ReloTab.now)
            stack(.history) { HistoryView(model: model) }
                .tabItem { Label("History", systemImage: "clock") }.tag(ReloTab.history)
            stack(.settings) { SettingsView(model: model) }
                .tabItem { Label("Settings", systemImage: "gearshape") }.tag(ReloTab.settings)
        }
        .onAppear {
            navigation.transition(to: model.presentationScopeIdentity)
            if let id = model.selectedNotificationID { navigation.open(id) }
            model.updateAttentionClock()
        }
        .onChange(of: model.presentationScopeIdentity) { _, scope in
            navigation.transition(to: scope)
            if let id = model.selectedNotificationID { navigation.open(id) }
        }
        .onChange(of: model.selectedNotificationID) { _, id in
            if let id { navigation.open(id) } else { navigation.dismiss() }
        }
        .onChange(of: model.items) { _, _ in model.updateAttentionClock() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { model.updateAttentionClock() } }
        .task(id: "\(scenePhase)|\(nextPresentationUpdateAt?.timeIntervalSince1970 ?? 0)") {
            guard scenePhase == .active else { return }
            model.updateAttentionClock()
            guard let deadline = nextPresentationUpdateAt else { return }
            let seconds = max(0.01, deadline.timeIntervalSinceNow)
            do {
                try await Task.sleep(for: .seconds(seconds))
                guard !Task.isCancelled else { return }
                model.updateAttentionClock()
            } catch { /* A new snapshot cancels and reschedules the local deadline. */ }
        }
    }
    private var nextPresentationUpdateAt: Date? {
        [model.attention.nextTransitionAt, Calendar.current.dateInterval(of: .day, for: model.attentionDate)?.end]
            .compactMap { $0 }.min()
    }
    private func stack<Content: View>(_ tab: ReloTab, @ViewBuilder content: () -> Content) -> some View {
        NavigationStack {
            content()
                .navigationDestination(isPresented: Binding(
                    get: { navigation.detailTab == tab && navigation.notificationID != nil },
                    set: { if !$0 && navigation.detailTab == tab { navigation.dismiss(); model.dismissNotification() } }
                )) {
                    if let item = model.selectedNotification {
                        NotificationDetailView(model: model, item: item)
                    } else {
                        ContentUnavailableView("Notification unavailable", systemImage: "tray",
                            description: Text("Refresh your connection and try opening it again."))
                    }
                }
        }
    }
}
