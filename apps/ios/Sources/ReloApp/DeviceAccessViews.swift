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
        if let request {
            content(request)
        } else if !devices.pendingLoaded || devices.phase == .loading {
            ReloSheet {
                ReloSheetHeader(symbol: "lock.shield", tint: .reloSecondaryText, title: "Checking the request")
            } content: {
                ProgressView()
            } actions: {}
            .task { await model.refreshDevices() }
        } else {
            ReloSheet(cancelTitle: "Done") {
                ReloSheetHeader(symbol: "checkmark.shield", tint: .reloDone, title: "Nothing to approve",
                                message: "This request was already answered, or the device signed out.")
            } actions: {}
        }
    }

    private func content(_ request: EncryptionSecurityModel.AccessRequest) -> some View {
        ReloSheet(cancelTitle: "Not now", busy: working) {
            ReloSheetHeader(symbol: request.symbol, title: request.headline, message: request.ask)
                .accessibilityIdentifier("access-request-name")
        } content: {
            VStack(spacing: 16) {
                VStack(spacing: 4) {
                    if let subline = request.subline { ReloSheetFootnote(text: subline) }
                    ReloSheetFootnote(text: request.signedInLine)
                }
                if let code = request.linkCode {
                    VStack(spacing: 6) {
                        ReloMonoLabel("Link code")
                        Text(code)
                            .font(.system(.title, design: .rounded).weight(.bold).monospacedDigit())
                            .multilineTextAlignment(.center)
                            .minimumScaleFactor(0.7).lineLimit(1)
                            .textSelection(.enabled)
                            .accessibilityLabel("Link code \(code)")
                            .accessibilityIdentifier("access-request-link-code")
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14).padding(.horizontal, 20)
                    .reloCard(tint: .reloAttention)
                }
                Text(request.approveLine)
                    .font(request.isBrowser ? .subheadline.weight(.semibold) : .footnote)
                    .foregroundStyle(Color.reloSecondaryText).multilineTextAlignment(.center)
                if let problem = authProblem ?? devices.pendingProblem { ReloSheetProblem(text: problem) }
            }
        } actions: {
            Button { Task { await approve(request) } } label: {
                if working { ProgressView().tint(.reloOnAction) } else { Label("Approve", systemImage: "faceid") }
            }
            .buttonStyle(.reloPrimary)
            .disabled(model.credential == nil)
            .accessibilityIdentifier("approve-request")
            Button("Decline") { Task { await decline(request) } }
                .buttonStyle(.reloDestructive)
                .disabled(model.credential == nil)
                .accessibilityIdentifier("decline-request")
            ReloSheetFootnote(text: request.declineLine)
        }
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

/// Now's "Needs you" row for a phone, computer or browser waiting for approval.
struct DeviceAccessNeedsYouRow: View {
    let model: AppModel

    var body: some View {
        let requests = model.devices.waitingRequests
        if let first = requests.first {
            ReloCard(tint: .reloAttention) {
                HStack(alignment: .firstTextBaseline, spacing: ReloLayout.inlineGap) {
                    Image(systemName: first.symbol).foregroundStyle(Color.reloAttention).accessibilityHidden(true)
                    CardTitle(requests.count == 1 ? "\(first.name) \(first.ask)" : "\(requests.count) devices want access")
                }
                CardFooter(meta: Text(requests.count == 1 ? first.signedInLine : "Review them in Devices")) {
                    CardAction("Review", kind: .primary, action: review)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("needs-you-device-access")
        }
    }

    private func review() {
        let requests = model.devices.waitingRequests
        guard let first = requests.first else { return }
        if requests.count == 1 { model.openAccessRequest(id: first.id) } else { model.openSecuritySettings() }
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
