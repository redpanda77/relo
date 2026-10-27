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
                .tabItem { Label("Now", systemImage: "waveform.circle") }.tag(ReloTab.now)
            stack(.history) { HistoryView(model: model).reloAttentionBanner(model: model) }
                .tabItem { Label("History", systemImage: "clock") }.tag(ReloTab.history)
            stack(.settings) { SettingsView(model: model).reloAttentionBanner(model: model) }
                .tabItem { Label("Settings", systemImage: "gearshape") }.tag(ReloTab.settings)
        }
        .onAppear {
            navigation.transition(to: model.presentationScopeIdentity)
            if let id = model.selectedNotificationID { navigation.open(id) }
            if model.securitySettingsNavigationPending { navigation.tab = .settings }
            model.updateAttentionClock()
        }
        .onChange(of: model.securitySettingsRequests) { _, _ in navigation.tab = .settings }
        // A phone or computer waiting for approval: the sheet opens over any tab.
        .sheet(item: Binding(
            get: { model.presentedAccessRequestID.map(AccessRequestRoute.init) },
            set: { model.presentedAccessRequestID = $0?.id }
        )) { route in AccessRequestSheet(model: model, id: route.id) }
        // Connect a computer: opened from Settings or the Live Activity, and offered once to a new account with none.
        .sheet(isPresented: $model.presentsComputerSetup) { ConnectComputerView(model: model) }
        .task(id: "\(model.computerSetupOfferPending)|\(model.credential != nil)") { await model.offerComputerSetupIfNew() }
        // A code the wizard made is checked whenever the app comes to the front, wizard on screen or not.
        .task(id: scenePhase) {
            guard scenePhase == .active, model.credential != nil else { return }
            await model.computerSetup.refresh()
        }
        // Keeps Now's "Needs you" row current: on foreground and when a push lands.
        .task(id: scenePhase) {
            guard scenePhase == .active, model.credential != nil else { return }
            await model.refreshDevices()
        }
        .onReceive(NotificationCenter.default.publisher(for: .reloPushReceived)) { _ in
            guard model.credential != nil else { return }
            Task { await model.refreshDevices() }
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
                        ReloEmptyState(title: "Notification unavailable",
                                       detail: "Refresh your connection and try opening it again.", symbol: "tray")
                    }
                }
        }
    }
}

/// The one problem that stops Relo working, pinned above the tab bar where it cannot be missed,
/// with the way out: the server is unreachable, or notifications are off.
private struct ReloAttentionBanner: View {
    @Bindable var model: AppModel

    private enum Problem { case unreachable, notificationsOff }
    private var problem: Problem? {
        if model.serverUnreachable { return .unreachable }
        if model.isRegistered && model.permission != .allowed { return .notificationsOff }
        return nil
    }

    var body: some View {
        if let problem {
            let color = problem == .unreachable ? Color.reloWarning : Color.reloAttention
            ReloCard(tint: color, edge: true) {
                HStack(alignment: .top, spacing: ReloLayout.itemSpacing) {
                    Image(systemName: problem == .unreachable ? "wifi.exclamationmark" : "bell.slash.fill")
                        .font(.body.weight(.semibold)).foregroundStyle(color)
                        .frame(width: 34, height: 34)
                        .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(color.opacity(0.16)))
                        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(color.opacity(0.35), lineWidth: 0.5))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: ReloLayout.cardGap) {
                        CardTitle(problem == .unreachable ? "Can't reach your Relo server" : "Notifications are off")
                        CardStatusLine(problem == .unreachable
                                       ? "Check your connection and the server address; if your server is on a private network or VPN, make sure it is connected."
                                       : "Relo can't alert you or show Live Activities, so requests from your agents will be missed.", lines: 4)
                    }
                    CardAction(problem == .unreachable ? "Retry" : "Turn on", kind: .primary) { act(problem) }
                }
            }
            .padding(.horizontal, ReloLayout.screenInset).padding(.bottom, ReloLayout.inlineGap)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityElement(children: .combine)
        }
    }

    private func act(_ problem: Problem) {
        switch problem {
        case .unreachable:
            Task { await model.retryDeviceRegistration(); _ = await model.refresh() }
        case .notificationsOff:
            if model.permission == .denied, let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            } else {
                Task { await model.requestNotifications() }
            }
        }
    }
}

extension View {
    func reloAttentionBanner(model: AppModel) -> some View {
        safeAreaInset(edge: .bottom, spacing: 0) {
            ReloAttentionBanner(model: model)
                .animation(.smooth(duration: 0.4), value: model.serverUnreachable)
                .animation(.smooth(duration: 0.4), value: model.permission)
        }
    }
}
