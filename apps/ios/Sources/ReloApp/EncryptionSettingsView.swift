import ReloCore
import ReloNotificationSupport
import SwiftUI

/// Settings → Devices (docs/END-TO-END-ENCRYPTION.md), laid out like WhatsApp's "Linked devices":
/// what waits for the owner first, one line about this iPhone, then phones, computers and browsers.
/// Key ids and security codes live in each row's Advanced area.
@MainActor @Observable
final class EncryptionSecurityModel {
    struct Computer: Identifiable, Equatable {
        let client: ReloClientKey
        var trust: ReloClientTrust
        let notice: ReloTrustedClient.Notice?
        let safetyNumber: String
        /// Still trusted on this iPhone, but the server no longer lists it.
        var unlisted = false
        var id: String { client.clientId }
    }

    /// A phone or computer waiting for the owner's approval on this iPhone.
    enum AccessRequest: Identifiable, Equatable {
        case phone(ReloPendingDevice)
        case computer(Computer)

        var id: String {
            switch self {
            case .phone(let device): device.deviceId
            case .computer(let computer): computer.client.clientId
            }
        }
        var isPhone: Bool { if case .phone = self { true } else { false } }
        var name: String {
            switch self {
            case .phone(let device): device.displayName
            case .computer(let computer): computer.client.name
            }
        }
        /// "iPhone Air · Simulator" when it adds something to the name.
        var modelLine: String? {
            guard case .phone(let device) = self, let line = device.modelLine, line != name else { return nil }
            return line
        }
        /// The big name on the request sheet: "iPhone Air · Simulator" rather than "iPhone Air" twice.
        var headline: String {
            if let modelLine, modelLine.hasPrefix(name) { return modelLine }
            return name
        }
        var subline: String? { headline == name ? modelLine : nil }
        var signedInAt: Date? {
            switch self {
            case .phone(let device): device.registeredDate
            case .computer(let computer): computer.notice?.at
            }
        }
        var signedInLine: String {
            guard let date = signedInAt else { return "Signed in recently" }
            return "Signed in \(date.formatted(.relative(presentation: .named)))"
        }
        var ask: String { isPhone ? "wants access" : "wants to send you encrypted cards" }
        var declineLine: String {
            isPhone ? "Sign it out. It won't be able to read anything." : "This iPhone won't open anything it sends."
        }
        var symbol: String { isPhone ? "iphone" : "laptopcomputer" }
    }

    enum Phase: Equatable { case loading, ready, unavailable(String) }

    private(set) var phase: Phase = .loading
    private(set) var phoneKeyID: String?
    private(set) var computers: [Computer] = []
    /// The account's phones from the server; nil until it answers, or when it is too old to list them.
    private(set) var accountPhones: [ReloAccountPhone]?
    /// Web Dashboard browsers this phone linked and keeps re-signing (the local list, not the server's).
    private(set) var browsers: [ReloLocalLinkedBrowser] = []
    /// Browsers the server lists as linked that this phone does not vouch for; nil until the server answers.
    private(set) var serverOnlyBrowsers: [ReloLinkedBrowser]?
    private(set) var browsersProblem: String?
    private(set) var linking = false
    var linkResult: LinkResult?
    /// Phones of this account waiting for this phone's approval.
    private(set) var pendingDevices: [ReloPendingDevice] = []
    /// True once the waiting phones were asked for at least once (the request sheet waits for it).
    private(set) var pendingLoaded = false
    /// Why loading, approving or declining a request failed.
    private(set) var pendingProblem: String?
    /// The request being approved or declined now.
    private(set) var answeringDevice: String?

    struct LinkResult: Identifiable, Equatable {
        let id = UUID()
        let title: String
        let message: String
    }
    /// A browser to unlink: one this phone vouches for, or one only the server lists.
    enum UnlinkTarget: Identifiable, Equatable {
        case local(ReloLocalLinkedBrowser)
        case serverOnly(ReloLinkedBrowser)

        var id: String { browserID }
        var browserID: String {
            switch self {
            case .local(let browser): browser.browserId
            case .serverOnly(let browser): browser.browserId
            }
        }
        var name: String {
            switch self {
            case .local(let browser): browser.name
            case .serverOnly(let browser): browser.name
            }
        }
    }

    private let ring: ReloKeyRing
    private let trust: ReloTrustedClients
    private let linked: ReloLinkedBrowsers

    init(ring: ReloKeyRing = .live(), trust: ReloTrustedClients = .live(), linked: ReloLinkedBrowsers = .live()) {
        self.ring = ring
        self.trust = trust
        self.linked = linked
    }

    /// Computers that appeared after this phone's first contact and wait for the owner here.
    var waitingComputers: [Computer] { computers.filter { $0.trust == .pending } }

    /// Everything waiting for the owner, phones first.
    var waitingRequests: [AccessRequest] {
        pendingDevices.map(AccessRequest.phone) + waitingComputers.map(AccessRequest.computer)
    }

    func request(id: String) -> AccessRequest? { waitingRequests.first { $0.id == id } }

    var trustedComputerCount: Int { computers.filter { $0.trust == .auto || $0.trust == .verified }.count }

    /// Other phones on the account that are not waiting for approval here (those are listed above).
    var otherPhones: [ReloAccountPhone] {
        let waiting = Set(pendingDevices.map(\.deviceId))
        return (accountPhones ?? []).filter { !$0.isCurrent && !waiting.contains($0.deviceId) }
    }

    var thisPhone: ReloAccountPhone? { accountPhones?.first(where: \.isCurrent) }

    func status(signedIn: Bool, keysProblem: String?) -> ReloThisPhoneStatus {
        ReloThisPhoneStatus.make(signedIn: signedIn, keysProblem: keysProblem, keysReady: phoneKeyID != nil,
                                 selfTrusted: thisPhone?.trusted, trustedComputers: trustedComputerCount)
    }

    /// Waiting phones, computers, the account's phones and browsers, in one pass.
    func refresh(credential: DeviceCredential?, client: Any?) async {
        await loadPending(credential: credential, approver: client as? any DeviceApproving)
        await load(credential: credential, directory: client as? any ClientKeyDirectory)
        await loadPhones(credential: credential, lister: client as? any AccountDeviceListing)
    }

    func loadPhones(credential: DeviceCredential?, lister: (any AccountDeviceListing)?) async {
        guard let credential, let lister else { accountPhones = nil; return }
        // Best effort: the rest of the screen works without it.
        if let phones = try? await lister.accountPhones(credential: credential) { accountPhones = phones }
    }

    func load(credential: DeviceCredential?, directory: (any ClientKeyDirectory)?) async {
        guard let credential, let directory else {
            phase = .unavailable("Sign in to see your devices.")
            return
        }
        do {
            let state = try ring.store.load() ?? ring.maintain()
            phoneKeyID = ReloE2EE.keyID(publicKeyX963: state.identity.publicKey)
            let clients = try await directory.clientKeys(credential: credential)
            try trust.autoTrust(clients)
            // A computer the phone still trusts but the server no longer lists stays visible.
            let listed = Set(clients.map(\.clientId))
            let unlisted = try trust.all().filter { !listed.contains($0.clientId) }.map {
                ReloClientKey(clientId: $0.clientId, name: $0.name, keyId: $0.keyId, publicKey: $0.publicKey, changedAt: "")
            }
            computers = try (clients.map { ($0, false) } + unlisted.map { ($0, true) }).map { client, unlisted in
                Computer(client: client, trust: try trust.trust(of: client), notice: try trust.notice(for: client),
                         safetyNumber: try trust.safetyNumber(phoneIdentity: state.identity.publicKey, client: client),
                         unlisted: unlisted)
            }
            phase = .ready
        } catch {
            phase = .unavailable("Relo could not load your devices. Check the connection and try again.")
        }
        await loadBrowsers(credential: credential, linker: directory as? any BrowserLinking)
    }

    func loadBrowsers(credential: DeviceCredential?, linker: (any BrowserLinking)?) async {
        do {
            browsers = try linked.all()
        } catch {
            browsersProblem = "Relo could not read the browsers this iPhone linked."
            return
        }
        guard let credential, let linker else { return }
        do {
            let listed = try await linker.linkedBrowsers(credential: credential)
            let mine = Set(browsers.map(\.browserId))
            serverOnlyBrowsers = listed.filter { !mine.contains($0.browserId) }
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
            let now = Date()
            let request = try ReloBrowserLink.request(for: code, phoneDeviceID: credential.deviceId, signer: signer, now: now)
            let accepted = try await linker.linkBrowser(credential: credential, request: request)
            // Only browsers in this list are ever re-signed; without it the link lapses in 14 days.
            try linked.remember(browserID: code.browserID, identityKey: code.identityKey, name: accepted.name, signedAt: now)
            browsers = (try? linked.all()) ?? browsers
            serverOnlyBrowsers?.removeAll { $0.browserId == accepted.browserId }
            linkResult = LinkResult(title: "Browser linked",
                                    message: "\(accepted.name) can now read your encrypted cards.")
        } catch {
            linkResult = LinkResult(title: "Not linked", message: Self.message(for: error, doing: "link the browser"))
        }
    }

    /// The local entry goes first, so this phone never re-signs the link even if the server keeps it.
    func unlink(_ target: UnlinkTarget, credential: DeviceCredential?, linker: (any BrowserLinking)?) async {
        if case .local(let browser) = target {
            do {
                try linked.forget(browserID: browser.browserId)
                browsers.removeAll { $0.browserId == browser.browserId }
            } catch {
                linkResult = LinkResult(title: "Not removed", message: "Relo could not update the browsers this iPhone linked.")
                return
            }
        }
        guard let credential, let linker else { return }
        do {
            try await linker.unlinkBrowser(credential: credential, browserID: target.browserID)
            serverOnlyBrowsers?.removeAll { $0.browserId == target.browserID }
        } catch {
            var message = Self.message(for: error, doing: "remove \(target.name)")
            if case .local = target {
                message += " This iPhone no longer renews it, so it stops working within 14 days."
            }
            linkResult = LinkResult(title: "Not removed on the server", message: message)
            if case .local(let browser) = target {
                let listed = ReloLinkedBrowser(browserId: browser.browserId, name: browser.name,
                                               linkedAt: browser.linkedAt.ISO8601Format())
                serverOnlyBrowsers = (serverOnlyBrowsers ?? []).filter { $0.browserId != browser.browserId } + [listed]
            }
        }
    }

    // MARK: Requests

    func loadPending(credential: DeviceCredential?, approver: (any DeviceApproving)?) async {
        guard let credential, let approver else { pendingDevices = []; pendingLoaded = true; return }
        do {
            pendingDevices = try await approver.pendingDevices(credential: credential)
            pendingProblem = nil
        } catch {
            pendingProblem = Self.message(for: error, doing: "check for new devices")
        }
        pendingLoaded = true
    }

    /// Approves a waiting phone (signs its key) or computer (trusts it on this iPhone). The owner has
    /// already passed the device-owner check.
    @discardableResult
    func approve(_ request: AccessRequest, credential: DeviceCredential?, approver: (any DeviceApproving)?,
                 signer: (any ReloIdentitySigning)?) async -> Bool {
        switch request {
        case .phone(let device): await approve(device, credential: credential, approver: approver, signer: signer)
        case .computer(let computer): approveComputer(computer)
        }
    }

    @discardableResult
    func decline(_ request: AccessRequest, credential: DeviceCredential?, approver: (any DeviceApproving)?) async -> Bool {
        switch request {
        case .phone(let device): await decline(device, credential: credential, approver: approver)
        case .computer(let computer): declineComputer(computer)
        }
    }

    /// Signs the device's identity key with this phone's identity key: computers then trust it.
    @discardableResult
    func approve(_ device: ReloPendingDevice, credential: DeviceCredential?, approver: (any DeviceApproving)?,
                 signer: (any ReloIdentitySigning)?) async -> Bool {
        guard let credential, let approver else {
            pendingProblem = "Sign in to Relo on this iPhone first."
            return false
        }
        guard let signer else {
            pendingProblem = "This iPhone's encryption keys are not ready yet. Wait a moment and try again."
            return false
        }
        answeringDevice = device.deviceId
        defer { answeringDevice = nil }
        do {
            let request = try ReloDeviceApproval.request(for: device, phoneDeviceID: credential.deviceId, signer: signer)
            try await approver.approveDevice(credential: credential, request: request)
            pendingDevices.removeAll { $0.deviceId == device.deviceId }
            pendingProblem = nil
            return true
        } catch {
            // Reload first: a successful reload clears the problem, and this one must stay on screen.
            if error as? DeviceApprovalError != nil { await loadPending(credential: credential, approver: approver) }
            pendingProblem = Self.message(for: error, doing: "approve \(device.displayName)")
            return false
        }
    }

    /// Signs the device out.
    @discardableResult
    func decline(_ device: ReloPendingDevice, credential: DeviceCredential?, approver: (any DeviceApproving)?) async -> Bool {
        guard let credential, let approver else {
            pendingProblem = "Sign in to Relo on this iPhone first."
            return false
        }
        answeringDevice = device.deviceId
        defer { answeringDevice = nil }
        do {
            try await approver.declineDevice(credential: credential, deviceID: device.deviceId)
            pendingDevices.removeAll { $0.deviceId == device.deviceId }
            accountPhones?.removeAll { $0.deviceId == device.deviceId }
            pendingProblem = nil
            return true
        } catch {
            pendingProblem = Self.message(for: error, doing: "decline \(device.displayName)")
            return false
        }
    }

    static func message(for error: Error, doing action: String) -> String {
        if let error = error as? LocalizedError, let description = error.errorDescription,
           error is BrowserLinkError || error is DeviceApprovalError {
            return description
        }
        switch error as? MobileAPIError {
        case .reauthenticationRequired?: return "Relo needs you to sign in again before it can \(action)."
        case .forbidden?: return "The server refused to \(action)."
        default: return "Relo could not \(action). Check the connection and try again."
        }
    }

    /// The owner approved a computer on this phone: its encrypted cards open from now on.
    @discardableResult
    func approveComputer(_ computer: Computer) -> Bool {
        guard (try? trust.approve(clientId: computer.client.clientId, keyId: computer.client.keyId)) != nil,
              let index = computers.firstIndex(where: { $0.id == computer.id }) else {
            pendingProblem = "Relo could not approve \(computer.client.name). Try again."
            return false
        }
        computers[index].trust = .auto
        pendingProblem = nil
        return true
    }

    /// Declined: the computer stays listed and opens nothing on this iPhone.
    @discardableResult
    func declineComputer(_ computer: Computer) -> Bool {
        guard (try? trust.decline(clientId: computer.client.clientId, keyId: computer.client.keyId)) != nil,
              let index = computers.firstIndex(where: { $0.id == computer.id }) else {
            pendingProblem = "Relo could not decline \(computer.client.name). Try again."
            return false
        }
        computers[index].trust = .declined
        pendingProblem = nil
        return true
    }

    func markVerified(_ computer: Computer) {
        guard (try? trust.markVerified(computer.client)) != nil,
              let index = computers.firstIndex(where: { $0.id == computer.id }) else { return }
        computers[index].trust = .verified
    }
}

struct EncryptionSettingsView: View {
    let model: AppModel
    @State private var scanning = false
    @State private var pendingCode: ReloBrowserLink.Code?
    @State private var pendingUnlink: EncryptionSecurityModel.UnlinkTarget?
    @Environment(\.scenePhase) private var scenePhase

    private var security: EncryptionSecurityModel { model.devices }
    private var linker: (any BrowserLinking)? { model.apiClient as? any BrowserLinking }

    var body: some View {
        list
            .task { await model.refreshDevices() }
            .refreshable { await model.refreshDevices() }
            // The list refreshes on foreground and when a notification or link opens it.
            .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await model.refreshDevices() } } }
            .onChange(of: model.securitySettingsRequests) { _, _ in Task { await model.refreshDevices() } }
    }

    private var list: some View {
        List {
            needsApprovalSection
            thisPhoneSection
            switch security.phase {
            case .loading:
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            case .unavailable(let message):
                Text(message).foregroundStyle(Color.reloSecondaryText).listRowBackground(ReloListRowBackground())
            case .ready:
                phonesSection
                computersSection
                browsersSection
                advancedSection
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Devices")
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
            Text("It will be able to read your encrypted cards.")
        }
        .confirmationDialog(pendingUnlink.map { "Remove \($0.name)?" } ?? "", isPresented: Binding(
            get: { pendingUnlink != nil }, set: { if !$0 { pendingUnlink = nil } }
        ), titleVisibility: .visible, presenting: pendingUnlink) { target in
            Button("Remove", role: .destructive) {
                pendingUnlink = nil
                Task { await security.unlink(target, credential: model.credential, linker: linker) }
            }
            Button("Cancel", role: .cancel) { pendingUnlink = nil }
        } message: { _ in
            Text("It won't be able to read your encrypted cards anymore.")
        }
        .alert(item: Binding(get: { security.linkResult }, set: { security.linkResult = $0 })) { result in
            Alert(title: Text(result.title), message: Text(result.message))
        }
    }

    // MARK: Sections

    /// Only when something waits: each row opens the request sheet.
    @ViewBuilder private var needsApprovalSection: some View {
        let requests = security.waitingRequests
        if !requests.isEmpty {
            Section {
                ForEach(requests) { request in
                    Button { model.openAccessRequest(id: request.id) } label: {
                        DeviceRow(symbol: request.symbol, tint: ReloHoloTheme.orange, title: request.name,
                                  detail: [request.modelLine, request.signedInLine].compactMap { $0 }.joined(separator: " · "),
                                  status: request.isPhone ? "Wants access" : "Wants to send you encrypted cards",
                                  statusColor: ReloHoloTheme.orange, chevron: true)
                    }
                    .foregroundStyle(.primary)
                    .accessibilityIdentifier("review-\(request.id)")
                }
            } header: { Text("Needs your approval") }
            .listRowBackground(ReloListRowBackground())
        } else if let problem = security.pendingProblem {
            Section {
                Text(problem).font(.footnote).foregroundStyle(Color.reloErrorText)
            }
            .listRowBackground(ReloListRowBackground())
        }
    }

    private var thisPhoneSection: some View {
        let status = security.status(signedIn: model.credential != nil, keysProblem: model.encryptionKeysProblem)
        let hardware = ReloDeviceModelName.current()
        let name = security.thisPhone?.name
            ?? ReloDeviceModelName.deviceName(systemName: UIDevice.current.name, identifier: hardware.identifier)
        let line = ReloDeviceModelName.displayModel(hardware.identifier, isSimulator: hardware.isSimulator)
        return Section {
            DeviceRow(symbol: "iphone", tint: .reloIndigo, title: name,
                      detail: line == name ? nil : line,
                      status: status.line,
                      statusColor: status.isGood ? Color.reloSecondaryText
                        : status == .waitingForApproval ? ReloHoloTheme.orange : Color.reloErrorText,
                      statusSymbol: status.isGood ? "lock.fill" : nil)
                .accessibilityIdentifier("this-iphone-status")
        } header: { Text("This iPhone") } footer: {
            Text("Only your approved devices can read encrypted cards. The Relo server can't.")
        }
        .listRowBackground(ReloListRowBackground())
    }

    @ViewBuilder private var phonesSection: some View {
        let phones = security.otherPhones
        if !phones.isEmpty {
            Section {
                ForEach(phones) { phone in
                    DeviceRow(symbol: "iphone", tint: .reloIndigo, title: phone.name,
                              detail: [phone.modelLine == phone.name ? nil : phone.modelLine, lastSeen(phone.lastSeenDate)]
                                .compactMap { $0 }.joined(separator: " · "),
                              status: phone.trusted ? "Can read encrypted cards" : "Waiting for approval",
                              statusColor: phone.trusted ? Color.reloSecondaryText : ReloHoloTheme.orange)
                }
            } header: { Text("Phones") }
            .listRowBackground(ReloListRowBackground())
        }
    }

    @ViewBuilder private var computersSection: some View {
        let computers = security.computers.filter { $0.trust != .pending }
        if !computers.isEmpty {
            Section {
                ForEach(computers) { computer in
                    NavigationLink { ComputerDetailView(security: security, computer: computer) } label: {
                        DeviceRow(symbol: "laptopcomputer", tint: .reloIndigo, title: computer.client.name,
                                  detail: ComputerDetailView.noticeLine(computer),
                                  status: ComputerDetailView.statusLine(computer),
                                  statusColor: computer.trust == .declined || computer.unlisted
                                    ? ReloHoloTheme.orange : Color.reloSecondaryText)
                    }
                }
            } header: { Text("Computers") }
            .listRowBackground(ReloListRowBackground())
        }
    }

    @ViewBuilder private var browsersSection: some View {
        Section {
            ForEach(security.browsers) { browser in
                DeviceRow(symbol: "globe", tint: .reloMagenta, title: browser.name,
                          detail: "Linked \(browser.linkedAt.formatted(.relative(presentation: .named)))",
                          status: "Can read encrypted cards", statusColor: Color.reloSecondaryText)
                    .swipeActions { Button("Remove", role: .destructive) { pendingUnlink = .local(browser) } }
                    .contextMenu {
                        Button("Remove", systemImage: "xmark.circle", role: .destructive) { pendingUnlink = .local(browser) }
                    }
            }
            ForEach(security.serverOnlyBrowsers ?? []) { browser in
                DeviceRow(symbol: "globe", tint: .reloMagenta, title: browser.name,
                          detail: "Linked from another device",
                          status: "Stops working within 14 days", statusColor: ReloHoloTheme.orange)
                    .swipeActions { Button("Remove", role: .destructive) { pendingUnlink = .serverOnly(browser) } }
                    .contextMenu {
                        Button("Remove", systemImage: "xmark.circle", role: .destructive) { pendingUnlink = .serverOnly(browser) }
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
        } header: { Text("Browsers") } footer: {
            Text("Scan the QR code on Relo's web Dashboard. Swipe a browser to remove it.")
        }
        .listRowBackground(ReloListRowBackground())
    }

    /// Key ids and the keys' fine print, out of the way.
    private var advancedSection: some View {
        Section {
            DisclosureGroup("Advanced") {
                if let phoneKeyID = security.phoneKeyID {
                    LabeledContent("This iPhone's key", value: phoneKeyID).font(.footnote.monospaced())
                }
                Text("Keys live in this iPhone's Secure Enclave and rotate every 10 hours. Browsers stay linked while this iPhone renews them; that happens on its own.")
                    .font(.footnote).foregroundStyle(Color.reloSecondaryText)
            }
        }
        .listRowBackground(ReloListRowBackground())
    }

    private func lastSeen(_ date: Date?) -> String? {
        date.map { "Active \($0.formatted(.relative(presentation: .named)))" }
    }
}

/// One device: icon, name, a detail line and a plain status line.
struct DeviceRow: View {
    let symbol: String
    let tint: Color
    let title: String
    var detail: String?
    let status: String
    let statusColor: Color
    var statusSymbol: String?
    var chevron = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.title3).foregroundStyle(tint).frame(width: 30)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.semibold))
                if let detail, !detail.isEmpty {
                    Text(detail).font(.footnote).foregroundStyle(Color.reloSecondaryText)
                }
                Label {
                    Text(status)
                } icon: {
                    if let statusSymbol { Image(systemName: statusSymbol) }
                }
                .labelStyle(StatusLabelStyle(showsIcon: statusSymbol != nil))
                .font(.footnote).foregroundStyle(statusColor)
                .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            if chevron {
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private struct StatusLabelStyle: LabelStyle {
        let showsIcon: Bool
        func makeBody(configuration: Configuration) -> some View {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                if showsIcon { configuration.icon }
                configuration.title
            }
        }
    }
}

private struct ComputerDetailView: View {
    let security: EncryptionSecurityModel
    let computer: EncryptionSecurityModel.Computer
    @Environment(\.dismiss) private var dismiss

    private var current: EncryptionSecurityModel.Computer {
        security.computers.first { $0.id == computer.id } ?? computer
    }

    static func statusLine(_ computer: EncryptionSecurityModel.Computer) -> String {
        if computer.unlisted { return "Signed out. This iPhone still recognizes it." }
        switch computer.trust {
        case .verified: return "Sends encrypted cards · Verified"
        case .declined: return "Declined. This iPhone doesn't open what it sends."
        case .pending: return "Waiting for approval"
        case .auto, .new: return "Sends encrypted cards"
        }
    }

    static func noticeLine(_ computer: EncryptionSecurityModel.Computer) -> String? {
        guard let notice = computer.notice else { return nil }
        let when = notice.at.formatted(.relative(presentation: .named))
        return notice.kind == "new_computer" ? "Added \(when)" : "Security code changed \(when)"
    }

    var body: some View {
        List {
            Section {
                DeviceRow(symbol: "laptopcomputer", tint: .reloIndigo, title: current.client.name,
                          detail: Self.noticeLine(current), status: Self.statusLine(current),
                          statusColor: Color.reloSecondaryText)
                if current.trust == .declined {
                    Button("Approve") { security.approveComputer(current) }
                } else if current.trust == .auto || current.trust == .verified {
                    Button("Stop opening its cards", role: .destructive) { security.declineComputer(current); dismiss() }
                }
            } footer: {
                Text("To sign a computer out, remove it in the Relo Dashboard.")
            }
            .listRowBackground(ReloListRowBackground())
            Section {
                DisclosureGroup("Advanced") {
                    Text(formatted(current.safetyNumber))
                        .font(.body.monospacedDigit())
                        .frame(maxWidth: .infinity)
                        .textSelection(.enabled)
                        .accessibilityLabel("Security code \(current.safetyNumber)")
                    LabeledContent("Key", value: current.client.keyId).font(.footnote.monospaced())
                    if current.trust != .verified {
                        Button("Mark as verified") { security.markVerified(current); dismiss() }
                    }
                    Text("Optional. Run relo keys verify on \(current.client.name) and compare the 60 digits. Encryption works without it.")
                        .font(.footnote).foregroundStyle(Color.reloSecondaryText)
                }
            }
            .listRowBackground(ReloListRowBackground())
        }
        .listStyle(.insetGrouped)
        .navigationTitle(current.client.name)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func formatted(_ number: String) -> String {
        let groups = number.split(separator: " ")
        return stride(from: 0, to: groups.count, by: 4)
            .map { groups[$0..<min($0 + 4, groups.count)].joined(separator: " ") }
            .joined(separator: "\n")
    }
}
