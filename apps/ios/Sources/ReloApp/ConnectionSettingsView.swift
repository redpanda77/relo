import SwiftUI

struct ConnectionSettingsView: View {
    @Bindable var model: AppModel
    @State private var confirmsReset = false
    var body: some View {
        Form {
            Section("Connection") {
                LabeledContent("Server") { Text(model.serverOrigin).textSelection(.enabled) }
                LabeledContent("Inbox", value: model.healthSnapshot.inboxSync.label)
                LabeledContent("This iPhone", value: model.healthSnapshot.registration.label)
                if let date = model.lastSyncedAt { LabeledContent("Last updated", value: date.formatted(date: .abbreviated, time: .shortened)) }
                Button("Refresh connection") { Task { _ = await model.refresh() } }.frame(minHeight: 28)
            }
            if case let .failed(message) = model.registrationState {
                Section {
                    Text(message).foregroundStyle(Color.reloSecondaryText)
                    Button("Retry registration") { Task { await model.retryDeviceRegistration() } }.frame(minHeight: 28)
                }
            }
            Section {
                DisclosureGroup("Technical details") {
                    LabeledContent("Responses waiting to send", value: model.pendingResponseCount.formatted())
                    LabeledContent("Apple Push token", value: model.apnsTokenAvailable ? "Current" : model.cachedAPNSTokenAvailable ? "Cached; awaiting Apple" : "Awaiting Apple")
                    LabeledContent("Delivery path", value: model.healthSnapshot.deliveryPath.label)
                    if let detail = model.healthSnapshot.deliveryPath.detail { Text(detail).foregroundStyle(Color.reloSecondaryText) }
                    if let error = model.deliveryTransportStatusError { Text(error).foregroundStyle(Color.reloSecondaryText) }
                }.frame(minHeight: 28)
            }
            if model.protectedRegistrationResetAvailable {
                Section {
                    Button("Reset device registration", role: .destructive) { confirmsReset = true }.frame(minHeight: 28)
                }
            }
        }
        .reloGroupedScreen().navigationTitle("Connection").navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Reset this iPhone's registration?", isPresented: $confirmsReset, titleVisibility: .visible) {
            Button("Reset device registration", role: .destructive) { Task { await model.resetProtectedDeviceRegistration() } }
        } message: { Text("Unreadable device identity and cache records are removed. Your authenticated account and pending responses are preserved.") }
    }
}
