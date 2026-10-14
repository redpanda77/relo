import LocalAuthentication
import ReloCore
import SwiftUI
import UserNotifications

/// One Face ID / Touch ID / passcode check before approving a device, in place of a second
/// "Are you sure?" dialog.
enum DeviceOwnerCheck {
    static func confirm(reason: String) async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            // No passcode on this device (a fresh Simulator): there is nothing stronger to ask for.
            return (error as? LAError)?.code == .passcodeNotSet
        }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }
}

/// The request sheet: who wants access, one prominent Approve behind the device-owner check, and
/// Decline as the quiet alternative that says what it does.
struct AccessRequestSheet: View {
    let model: AppModel
    let id: String
    @Environment(\.dismiss) private var dismiss
    @State private var working = false
    @State private var authProblem: String?

    private var devices: EncryptionSecurityModel { model.devices }
    private var request: EncryptionSecurityModel.AccessRequest? { devices.request(id: id) }

    var body: some View {
        NavigationStack {
            Group {
                if let request {
                    content(request)
                } else if !devices.pendingLoaded || devices.phase == .loading {
                    ProgressView("Checking…").frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ContentUnavailableView("Nothing to approve", systemImage: "checkmark.shield",
                        description: Text("This request was already answered, or the device signed out."))
                }
            }
            .reloScreenBackground()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(request == nil ? "Done" : "Not now") { dismiss() } }
            }
        }
        .task { if request == nil { await model.refreshDevices() } }
        .presentationDetents([.large])
    }

    private func content(_ request: EncryptionSecurityModel.AccessRequest) -> some View {
        VStack(spacing: 24) {
            Spacer(minLength: 12)
            Image(systemName: request.symbol)
                .font(.system(size: 60, weight: .light))
                .foregroundStyle(ReloHoloTheme.orange)
                .accessibilityHidden(true)
            VStack(spacing: 8) {
                Text(request.headline)
                    .font(.title.weight(.bold)).multilineTextAlignment(.center)
                    .accessibilityIdentifier("access-request-name")
                Text(request.ask).font(.title3).foregroundStyle(Color.reloSecondaryText).multilineTextAlignment(.center)
                if let subline = request.subline {
                    Text(subline).font(.subheadline).foregroundStyle(Color.reloSecondaryText)
                }
                Text(request.signedInLine).font(.subheadline).foregroundStyle(Color.reloSecondaryText)
            }
            Text(request.isPhone
                 ? "Approve it only if you just signed in on it yourself. Then your computers can send it encrypted cards."
                 : "Approve it only if you just signed in to Relo on it yourself. Then this iPhone opens what it sends.")
                .font(.footnote).foregroundStyle(Color.reloSecondaryText).multilineTextAlignment(.center)
            Spacer(minLength: 12)
            if let problem = authProblem ?? devices.pendingProblem {
                Text(problem).font(.footnote).foregroundStyle(Color.reloErrorText).multilineTextAlignment(.center)
            }
            VStack(spacing: 12) {
                Button { Task { await approve(request) } } label: {
                    Group {
                        if working { ProgressView() } else { Label("Approve", systemImage: "faceid") }
                    }
                    .font(.headline).frame(maxWidth: .infinity, minHeight: 50)
                }
                .buttonStyle(.borderedProminent).tint(.reloInteractive)
                .accessibilityIdentifier("approve-request")
                Button(role: .destructive) { Task { await decline(request) } } label: {
                    Text("Decline").font(.body.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("decline-request")
                Text(request.declineLine).font(.footnote).foregroundStyle(Color.reloSecondaryText)
                    .multilineTextAlignment(.center)
            }
            .disabled(working || model.credential == nil)
        }
        .padding(.horizontal, 24).padding(.bottom, 16)
    }

    private func approve(_ request: EncryptionSecurityModel.AccessRequest) async {
        authProblem = nil
        guard await DeviceOwnerCheck.confirm(reason: "Approve \(request.name)") else {
            authProblem = "Not approved. Try again."
            return
        }
        working = true
        defer { working = false }
        if await devices.approve(request, credential: model.credential, approver: model.apiClient as? any DeviceApproving,
                                 signer: model.answerSigner?()) {
            dismiss()
            Task { await model.refreshDevices() }
        }
    }

    private func decline(_ request: EncryptionSecurityModel.AccessRequest) async {
        authProblem = nil
        working = true
        defer { working = false }
        if await devices.decline(request, credential: model.credential, approver: model.apiClient as? any DeviceApproving) {
            dismiss()
        }
    }
}

/// Now's "Needs you" row for a phone or computer waiting for approval.
struct DeviceAccessNeedsYouRow: View {
    let model: AppModel

    var body: some View {
        let requests = model.devices.waitingRequests
        if let first = requests.first {
            Button {
                if requests.count == 1 { model.openAccessRequest(id: first.id) } else { model.openSecuritySettings() }
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: first.symbol)
                        .font(.title3).foregroundStyle(ReloHoloTheme.orange).frame(width: 28)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("NEEDS YOU").font(.caption2.weight(.bold)).tracking(1).foregroundStyle(ReloHoloTheme.orange)
                        Text(requests.count == 1 ? "\(first.name) \(first.ask)" : "\(requests.count) devices want access")
                            .font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                            .multilineTextAlignment(.leading)
                        Text(requests.count == 1 ? first.signedInLine : "Review them in Devices")
                            .font(.footnote).foregroundStyle(Color.reloSecondaryText)
                    }
                    Spacer(minLength: 0)
                    Text("Review")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                        .padding(.horizontal, 14).frame(minHeight: 36)
                        .background(ReloHoloTheme.orange.opacity(0.85), in: Capsule())
                }
                .padding(14)
                .reloCard(tint: ReloHoloTheme.orange)
                .contentShape(Rectangle())
            }
            .buttonStyle(ReloPressStyle())
            .accessibilityIdentifier("needs-you-device-access")
        }
    }
}

/// The notification's Approve, run without opening Relo. When it cannot finish, a quiet notification
/// takes the owner to the request sheet instead.
@MainActor
final class DeviceAccessActionCoordinator {
    static let shared = DeviceAccessActionCoordinator()
    private weak var model: AppModel?

    func install(model: AppModel) { self.model = model }

    func approve(_ id: String) async {
        guard let model else { return }
        let approved = await BoundedDecisionAttempt.run(waitForDeadline: { try await Task.sleep(for: .seconds(20)) }) {
            await model.approveAccessRequestInBackground(id: id).approved
        }
        guard !approved, let url = ReloDeepLink.accessRequestURL(id: id) else { return }
        let content = UNMutableNotificationContent()
        content.title = "Not approved yet"
        content.body = model.devices.request(id: id).map { "Open Relo to approve \($0.name)." }
            ?? "Open Relo to review the request."
        content.userInfo = ["relo": ["deepLink": url.absoluteString]]
        try? await UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "relo.access-request.\(id)", content: content, trigger: nil))
    }
}

/// Lets `.sheet(item:)` present a request by its id.
struct AccessRequestRoute: Identifiable, Equatable {
    let id: String
}
