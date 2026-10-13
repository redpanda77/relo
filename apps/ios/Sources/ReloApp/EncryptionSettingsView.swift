import ReloCore
import ReloNotificationSupport
import SwiftUI

/// Settings → Security (docs/END-TO-END-ENCRYPTION.md). Encryption is automatic, like WhatsApp: the
/// screen says what is protected, shows a "security code changed" line when a computer's key changes,
/// and keeps comparing security codes as an optional step.
@MainActor @Observable
final class EncryptionSecurityModel {
    struct Computer: Identifiable, Equatable {
        let client: ReloClientKey
        var trust: ReloClientTrust
        let notice: ReloTrustedClient.Notice?
        let safetyNumber: String
        var id: String { client.clientId }
    }

    enum Phase: Equatable { case loading, ready, unavailable(String) }

    private(set) var phase: Phase = .loading
    private(set) var phoneKeyID: String?
    private(set) var computers: [Computer] = []
    private let ring: ReloKeyRing
    private let trust: ReloTrustedClients

    init(ring: ReloKeyRing = .live(), trust: ReloTrustedClients = .live()) {
        self.ring = ring
        self.trust = trust
    }

    var statusLine: String {
        let names = computers.map(\.client.name)
        switch names.count {
        case 0: return "Messages are end-to-end encrypted as soon as a computer signs in to this account."
        case 1: return "End-to-end encrypted with \(names[0])."
        default: return "End-to-end encrypted with \(names.dropLast().joined(separator: ", ")) and \(names.last!)."
        }
    }

    func load(credential: DeviceCredential?, directory: (any ClientKeyDirectory)?) async {
        guard let credential, let directory else {
            phase = .unavailable("Sign in to see which computers send to this iPhone.")
            return
        }
        do {
            let state = try ring.store.load() ?? ring.maintain()
            phoneKeyID = ReloE2EE.keyID(publicKeyX963: state.identity.publicKey)
            let clients = try await directory.clientKeys(credential: credential)
            try trust.autoTrust(clients)
            computers = try clients.map { client in
                Computer(client: client, trust: try trust.trust(of: client), notice: try trust.notice(for: client),
                         safetyNumber: try trust.safetyNumber(phoneIdentity: state.identity.publicKey, client: client))
            }
            phase = .ready
        } catch {
            phase = .unavailable("Relo could not load encryption keys. Check the connection and try again.")
        }
    }

    func markVerified(_ computer: Computer) {
        guard (try? trust.markVerified(computer.client)) != nil,
              let index = computers.firstIndex(of: computer) else { return }
        computers[index].trust = .verified
    }
}

struct EncryptionSettingsView: View {
    let model: AppModel
    @State private var security = EncryptionSecurityModel()

    var body: some View {
        List {
            switch security.phase {
            case .loading:
                ProgressView().frame(maxWidth: .infinity)
            case .unavailable(let message):
                Text(message).foregroundStyle(Color.reloSecondaryText)
            case .ready:
                Section {
                    Label(security.statusLine, systemImage: "lock.fill")
                } footer: {
                    Text("Only this iPhone can read what your computers send. The Relo server, its operator and Apple cannot.")
                }
                .listRowBackground(ReloListRowBackground())
                if !security.computers.isEmpty {
                    Section {
                        ForEach(security.computers) { computer in
                            NavigationLink { ComputerVerificationView(security: security, computer: computer) } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    LabeledContent(computer.client.name) {
                                        if computer.trust == .verified { Text("Verified") }
                                    }
                                    if let notice = computer.notice {
                                        Text("Security code changed \(notice.at.formatted(.relative(presentation: .named)))")
                                            .font(.footnote).foregroundStyle(Color.reloSecondaryText)
                                    }
                                }
                            }
                        }
                    } header: { Text("Computers") }
                    .listRowBackground(ReloListRowBackground())
                }
                if let problem = model.encryptionKeysProblem {
                    Section {
                        Text(problem).foregroundStyle(Color.reloErrorText)
                    } header: { Text("Keys not published") }
                    .listRowBackground(ReloListRowBackground())
                }
                if let phoneKeyID = security.phoneKeyID {
                    Section {
                        LabeledContent("This iPhone", value: phoneKeyID).font(.footnote.monospaced())
                    } footer: {
                        Text("Keys live in this iPhone's Secure Enclave and rotate every 10 hours.")
                    }
                    .listRowBackground(ReloListRowBackground())
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Security")
        .task { await security.load(credential: model.credential, directory: model.apiClient as? any ClientKeyDirectory) }
        .refreshable { await security.load(credential: model.credential, directory: model.apiClient as? any ClientKeyDirectory) }
    }
}

private struct ComputerVerificationView: View {
    let security: EncryptionSecurityModel
    let computer: EncryptionSecurityModel.Computer
    @Environment(\.dismiss) private var dismiss

    private var current: EncryptionSecurityModel.Computer {
        security.computers.first { $0.id == computer.id } ?? computer
    }

    var body: some View {
        List {
            Section {
                Label("Messages from \(computer.client.name) are end-to-end encrypted.", systemImage: "lock.fill")
            }
            .listRowBackground(ReloListRowBackground())
            Section {
                Text(formatted(current.safetyNumber))
                    .font(.title3.monospacedDigit())
                    .frame(maxWidth: .infinity)
                    .textSelection(.enabled)
                    .accessibilityLabel("Security code \(current.safetyNumber)")
                if current.trust != .verified {
                    Button("Mark as verified") { security.markVerified(current); dismiss() }
                }
            } header: { Text("Verify security code (optional)") } footer: {
                Text("To check, run relo keys verify on \(computer.client.name) and compare the 60 digits. You never need to do this for encryption to work.")
            }
            .listRowBackground(ReloListRowBackground())
        }
        .listStyle(.insetGrouped)
        .navigationTitle(computer.client.name)
    }

    private func formatted(_ number: String) -> String {
        let groups = number.split(separator: " ")
        return stride(from: 0, to: groups.count, by: 4)
            .map { groups[$0..<min($0 + 4, groups.count)].joined(separator: " ") }
            .joined(separator: "\n")
    }
}
