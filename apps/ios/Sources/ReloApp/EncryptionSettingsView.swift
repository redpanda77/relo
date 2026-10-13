import ReloCore
import ReloNotificationSupport
import SwiftUI

/// Settings → Security: the computers whose sealed messages this iPhone opens
/// (docs/END-TO-END-ENCRYPTION.md, E2.4). The owner compares the safety number with
/// `relo keys verify` on that computer; only a match makes it trusted.
@MainActor @Observable
final class EncryptionSecurityModel {
    struct Computer: Identifiable, Equatable {
        let client: ReloClientKey
        var trust: ReloClientTrust
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

    func load(credential: DeviceCredential?, directory: (any ClientKeyDirectory)?) async {
        guard let credential, let directory else {
            phase = .unavailable("Sign in to see the computers that can send to this iPhone.")
            return
        }
        do {
            let state = try ring.store.load() ?? ring.maintain()
            phoneKeyID = ReloE2EE.keyID(publicKeyX963: state.identity.publicKey)
            let clients = try await directory.clientKeys(credential: credential)
            computers = try clients.map { client in
                Computer(client: client, trust: try trust.trust(of: client),
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
        computers[index].trust = .trusted
    }

    func forget(_ computer: Computer) {
        guard (try? trust.forget(clientId: computer.client.clientId)) != nil,
              let index = computers.firstIndex(of: computer) else { return }
        computers[index].trust = .unverified
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
                    if security.computers.isEmpty {
                        Text("No computer has an encryption key yet. Run relo keys status on a computer signed in to this account.")
                            .foregroundStyle(Color.reloSecondaryText)
                    }
                    ForEach(security.computers) { computer in
                        NavigationLink { ComputerVerificationView(security: security, computer: computer) } label: {
                            LabeledContent(computer.client.name) { Text(label(computer.trust)) }
                        }
                    }
                } header: { Text("Computers") } footer: {
                    Text("This iPhone opens end-to-end encrypted messages only from computers you verified. The server cannot read them or add a computer.")
                }
                .listRowBackground(ReloListRowBackground())
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

    private func label(_ trust: ReloClientTrust) -> String {
        switch trust {
        case .trusted: "Verified"
        case .unverified: "Not verified"
        case .changed: "Key changed"
        }
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
                Text(formatted(current.safetyNumber))
                    .font(.title3.monospacedDigit())
                    .frame(maxWidth: .infinity)
                    .textSelection(.enabled)
                    .accessibilityLabel("Safety number \(current.safetyNumber)")
            } header: { Text("Safety number") } footer: {
                Text("On \(computer.client.name), run relo keys verify with this iPhone's id. Trust it only if both screens show exactly these digits.")
            }
            .listRowBackground(ReloListRowBackground())
            if current.trust == .changed {
                Section {
                    Text("This computer's key changed since you verified it. Messages from it stay locked until you verify again.")
                        .foregroundStyle(Color.reloErrorText)
                }
                .listRowBackground(ReloListRowBackground())
            }
            Section {
                if current.trust == .trusted {
                    Button("Stop trusting this computer", role: .destructive) { security.forget(current); dismiss() }
                } else {
                    Button("The numbers match — trust this computer") { security.markVerified(current); dismiss() }
                }
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
