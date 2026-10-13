import ReloCore
import SwiftUI

struct SettingsView: View {
    @Bindable var model: AppModel
    @AppStorage(ReloHistoryPreferences.retentionKey) private var retentionRaw = HistoryRetention.standard.rawValue
    @AppStorage(ReloHistoryPreferences.clearedAtKey) private var clearedAt: Double = 0
    @State private var confirmsClear = false
    var body: some View {
        List {
            Section {
                NavigationLink { AccountSettingsView(model: model) } label: { ReloAccountHeader(model: model) }
                    .listRowBackground(ReloListRowBackground())
            }
            Section {
                NavigationLink { ConnectionSettingsView(model: model) } label: {
                    LabeledContent {
                        Text(model.connectionStatus.healthy ? "Connected" : "Needs attention")
                    } label: {
                        ReloSettingLabel(title: "Connection", symbol: "antenna.radiowaves.left.and.right", color: .reloIndigo)
                    }
                }
                NavigationLink { notificationSettings } label: {
                    LabeledContent {
                        Text(notificationsSummary)
                    } label: {
                        ReloSettingLabel(title: "Notifications", symbol: "bell.badge.fill", color: .reloCoral)
                    }
                }
                NavigationLink { EncryptionSettingsView(model: model) } label: {
                    ReloSettingLabel(title: "Security", symbol: "lock.shield.fill", color: .reloIndigo)
                }
            }
            .listRowBackground(ReloListRowBackground())
            Section {
                Picker(selection: $retentionRaw) {
                    ForEach(HistoryRetention.allCases) { Text($0.label).tag($0.rawValue) }
                } label: {
                    ReloSettingLabel(title: "Keep history", symbol: "clock.arrow.circlepath", color: .reloIndigo)
                }
                .pickerStyle(.menu).tint(Color.reloSecondaryText)
                Button(role: .destructive) { confirmsClear = true } label: {
                    ReloSettingLabel(title: "Clear history", symbol: "trash", color: .reloCoral)
                        .foregroundStyle(Color.reloErrorText)
                }
            } header: { Text("History") } footer: {
                Text(clearedAt > 0
                     ? "Cleared \(Date(timeIntervalSince1970: clearedAt).formatted(.relative(presentation: .named))). Hidden on this iPhone only; the Relo dashboard keeps everything."
                     : "Older notifications are hidden on this iPhone only; the Relo dashboard keeps everything. Requests waiting for you always stay.")
            }
            .listRowBackground(ReloListRowBackground())
            Section {
                NavigationLink { DiagnosticsView(model: model) } label: {
                    ReloSettingLabel(title: "Recovery & diagnostics", symbol: "stethoscope", color: Color(uiColor: .systemGray))
                }
                Link(destination: model.dashboardURL) {
                    HStack {
                        ReloSettingLabel(title: "Relo Dashboard", symbol: "safari.fill", color: .reloMagenta)
                        Spacer()
                        Image(systemName: "arrow.up.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                            .accessibilityHidden(true)
                    }
                }
                .tint(.primary)
            } footer: {
                Text("Relo \(appVersion) · Private notifications and decisions from your agents.")
                    .padding(.top, 4)
            }
            .listRowBackground(ReloListRowBackground())
        }
        .listStyle(.insetGrouped).listSectionSpacing(20)
        .confirmationDialog("Clear history on this iPhone?", isPresented: $confirmsClear, titleVisibility: .visible) {
            Button("Clear history", role: .destructive) { ReloHistoryPreferences.clear(&clearedAt) }
        } message: {
            Text("Past notifications and finished activities disappear from Now, History and Notification Center. Requests waiting for you stay, and the dashboard keeps everything.")
        }
        .reloGroupedScreen().navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
    }

    private var notificationsSummary: String {
        if model.permission == .allowed && model.liveActivitiesAuthorized { return "On" }
        if model.permission == .denied { return "Off" }
        return "Review"
    }

    private var notificationSettings: some View {
        Form {
            Section {
                LabeledContent("Access", value: model.permission == .allowed ? "Allowed" : model.permission == .denied ? "Off" : "Not requested")
                if model.permission == .unknown {
                    Button("Allow notifications") { Task { await model.requestNotifications() } }.frame(minHeight: 28)
                } else { Button("Open iPhone Settings", action: openSettings).frame(minHeight: 28) }
                if let error = model.pushRegistrationError { Text(error).foregroundStyle(Color.reloErrorText) }
            } header: { Text("Notifications") }
            .listRowBackground(ReloListRowBackground())
            Section {
                LabeledContent("Access", value: model.healthSnapshot.liveActivities.label)
                if let detail = model.healthSnapshot.liveActivities.detail { Text(detail).foregroundStyle(Color.reloSecondaryText) }
                Button("Open iPhone Settings", action: openSettings).frame(minHeight: 28)
            } header: { Text("Live Activities") }
            .listRowBackground(ReloListRowBackground())
        }
        .tint(.reloInteractive)
        .reloGroupedScreen().navigationTitle("Notifications").navigationBarTitleDisplayMode(.inline)
    }
    private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }
}

/// Who this phone belongs to and whether it is listening, in one glance.
private struct ReloAccountHeader: View {
    @Bindable var model: AppModel
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        let status = model.connectionStatus
        // At accessibility sizes the orb gives its width to the email and server, which then wrap in full.
        let large = typeSize.isAccessibilitySize
        HStack(spacing: 14) {
            if !large {
                ReloSignalOrb(state: status.healthy ? .clear : .needsYou, emissionTrigger: 0, live: false)
                    .frame(width: 72, height: 72)
                    .padding(-10)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(model.signedInEmail ?? "Relo account")
                    .font(.headline).foregroundStyle(.primary)
                    .lineLimit(large ? nil : 1).truncationMode(.middle)
                if let host = model.dashboardURL.host() {
                    Text(host).font(.subheadline).foregroundStyle(Color.reloSecondaryText)
                        .lineLimit(large ? nil : 1).truncationMode(.middle)
                }
                HStack(spacing: 6) {
                    Circle().fill(status.color).frame(width: 7, height: 7)
                        .shadow(color: status.color.opacity(0.6), radius: 3)
                        .accessibilityHidden(true)
                    Text(status.label)
                }
                .font(.footnote.weight(.medium)).foregroundStyle(Color.reloSecondaryText)
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens account settings")
    }
}
