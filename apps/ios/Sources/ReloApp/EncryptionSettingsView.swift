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
    /// Web Dashboard browsers this phone linked; nil until the server answers.
    private(set) var browsers: [ReloLinkedBrowser]?
    private(set) var browsersProblem: String?
    private(set) var linking = false
    var linkResult: LinkResult?

    struct LinkResult: Identifiable, Equatable {
        let id = UUID()
        let title: String
        let message: String
    }
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
            var clients = try await directory.clientKeys(credential: credential)
            try trust.autoTrust(clients)
            // A computer the phone still trusts but the server no longer lists stays visible.
            let listed = Set(clients.map(\.clientId))
            clients += try trust.all().filter { !listed.contains($0.clientId) }.map {
                ReloClientKey(clientId: $0.clientId, name: "\($0.name) (no longer listed by the server)", keyId: $0.keyId,
                              publicKey: $0.publicKey, changedAt: "")
            }
            computers = try clients.map { client in
                Computer(client: client, trust: try trust.trust(of: client), notice: try trust.notice(for: client),
                         safetyNumber: try trust.safetyNumber(phoneIdentity: state.identity.publicKey, client: client))
            }
            phase = .ready
        } catch {
            phase = .unavailable("Relo could not load encryption keys. Check the connection and try again.")
        }
        await loadBrowsers(credential: credential, linker: directory as? any BrowserLinking)
    }

    func loadBrowsers(credential: DeviceCredential?, linker: (any BrowserLinking)?) async {
        guard let credential, let linker else { return }
        do {
            browsers = try await linker.linkedBrowsers(credential: credential)
            browsersProblem = nil
        } catch {
            browsersProblem = Self.message(for: error, doing: "load linked browsers")
        }
    }

    /// Signs the scanned code with this phone's identity key and asks the server to link it.
    func link(_ code: ReloBrowserLink.Code, credential: DeviceCredential?, linker: (any BrowserLinking)?,
              signer: (any ReloIdentitySigning)?) async {
        guard let credential, let linker else {
            linkResult = LinkResult(title: "Not linked", message: "Sign in to Relo on this iPhone first.")
            return
        }
        guard let signer else {
            linkResult = LinkResult(title: "Not linked",
                                    message: "This iPhone's encryption keys are not ready yet. Wait a moment and try again.")
            return
        }
        linking = true
        defer { linking = false }
        do {
            let request = try ReloBrowserLink.request(for: code, phoneDeviceID: credential.deviceId, signer: signer)
            let linked = try await linker.linkBrowser(credential: credential, request: request)
            var list = (browsers ?? []).filter { $0.browserId != linked.browserId }
            list.insert(linked, at: 0)
            browsers = list
            linkResult = LinkResult(title: "Browser linked",
                                    message: "\(linked.name) can now read your encrypted Relo messages.")
        } catch {
            linkResult = LinkResult(title: "Not linked", message: Self.message(for: error, doing: "link the browser"))
        }
    }

    func unlink(_ browser: ReloLinkedBrowser, credential: DeviceCredential?, linker: (any BrowserLinking)?) async {
        guard let credential, let linker else { return }
        do {
            try await linker.unlinkBrowser(credential: credential, browserID: browser.browserId)
            browsers?.removeAll { $0.browserId == browser.browserId }
        } catch {
            linkResult = LinkResult(title: "Not unlinked", message: Self.message(for: error, doing: "unlink \(browser.name)"))
        }
    }

    static func message(for error: Error, doing action: String) -> String {
        if let error = error as? LocalizedError, let description = error.errorDescription, error is BrowserLinkError {
            return description
        }
        switch error as? MobileAPIError {
        case .reauthenticationRequired?: return "Relo needs you to sign in again before it can \(action)."
        case .forbidden?: return "The server refused to \(action)."
        default: return "Relo could not \(action). Check the connection and try again."
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
    @State private var scanning = false
    @State private var pendingCode: ReloBrowserLink.Code?
    @State private var pendingUnlink: ReloLinkedBrowser?

    private var linker: (any BrowserLinking)? { model.apiClient as? any BrowserLinking }

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
                                        Text("\(notice.kind == "new_computer" ? "Added" : "Security code changed") \(notice.at.formatted(.relative(presentation: .named)))")
                                            .font(.footnote).foregroundStyle(Color.reloSecondaryText)
                                    }
                                }
                            }
                        }
                    } header: { Text("Computers") }
                    .listRowBackground(ReloListRowBackground())
                }
                browsersSection
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
        .sheet(isPresented: $scanning) {
            BrowserLinkScannerView { code in
                scanning = false
                pendingCode = code
            }
        }
        .confirmationDialog("Link this browser?", isPresented: Binding(
            get: { pendingCode != nil }, set: { if !$0 { pendingCode = nil } }
        ), titleVisibility: .visible, presenting: pendingCode) { code in
            Button("Link Browser") {
                pendingCode = nil
                Task {
                    await security.link(code, credential: model.credential, linker: linker, signer: model.answerSigner?())
                }
            }
            Button("Cancel", role: .cancel) { pendingCode = nil }
        } message: { _ in
            Text("It will be able to read your encrypted Relo messages.")
        }
        .confirmationDialog("Unlink this browser?", isPresented: Binding(
            get: { pendingUnlink != nil }, set: { if !$0 { pendingUnlink = nil } }
        ), titleVisibility: .visible, presenting: pendingUnlink) { browser in
            Button("Unlink \(browser.name)", role: .destructive) {
                pendingUnlink = nil
                Task { await security.unlink(browser, credential: model.credential, linker: linker) }
            }
            Button("Cancel", role: .cancel) { pendingUnlink = nil }
        } message: { _ in
            Text("It will no longer be able to read your encrypted Relo messages.")
        }
        .alert(item: Binding(get: { security.linkResult }, set: { security.linkResult = $0 })) { result in
            Alert(title: Text(result.title), message: Text(result.message))
        }
    }

    @ViewBuilder private var browsersSection: some View {
        Section {
            ForEach(security.browsers ?? []) { browser in
                VStack(alignment: .leading, spacing: 2) {
                    Text(browser.name)
                    if let linked = browser.linkedDate {
                        Text("Linked \(linked.formatted(.relative(presentation: .named)))")
                            .font(.footnote).foregroundStyle(Color.reloSecondaryText)
                    }
                }
                .swipeActions {
                    Button("Unlink", role: .destructive) { pendingUnlink = browser }
                }
                .contextMenu {
                    Button("Unlink", systemImage: "xmark.circle", role: .destructive) { pendingUnlink = browser }
                }
            }
            if let problem = security.browsersProblem {
                Text(problem).font(.footnote).foregroundStyle(Color.reloErrorText)
            }
            Button {
                scanning = true
            } label: {
                if security.linking {
                    HStack { ProgressView(); Text("Linking…") }
                } else {
                    Label("Link a browser", systemImage: "qrcode.viewfinder")
                }
            }
            .disabled(security.linking || model.credential == nil)
            .accessibilityIdentifier("link-browser")
        } header: { Text("Linked browsers") } footer: {
            Text("Scan the QR code on Relo's web Dashboard. A linked browser can read your encrypted messages until you unlink it.")
        }
        .listRowBackground(ReloListRowBackground())
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
