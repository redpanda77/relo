import ReloCore
import ReloNotificationSupport
import SwiftUI

/// Settings → Devices (docs/ENCRYPTION-PROTOCOL.md), laid out like WhatsApp's "Linked devices":
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

    /// A phone, computer or browser waiting for the owner's approval on this iPhone.
    enum AccessRequest: Identifiable, Equatable {
        case phone(ReloPendingDevice)
        case computer(Computer)
        case browser(ReloPendingBrowser)

        var id: String {
            switch self {
            case .phone(let device): device.deviceId
            case .computer(let computer): computer.client.clientId
            case .browser(let browser): browser.browserId
            }
        }
        var isBrowser: Bool { if case .browser = self { true } else { false } }
        /// The code the owner compares with the one the browser shows.
        var linkCode: String? { if case .browser(let browser) = self { browser.linkCode } else { nil } }
        var isPhone: Bool { if case .phone = self { true } else { false } }
        var name: String {
            switch self {
            case .phone(let device): device.displayName
            case .computer(let computer): computer.client.name
            case .browser(let browser): browser.name
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
            case .browser(let browser): browser.requestedDate
            }
        }
        var signedInLine: String {
            if isBrowser {
                guard let date = signedInAt else { return "Asked recently" }
                return "Asked \(date.formatted(.relative(presentation: .named)))"
            }
            guard let date = signedInAt else { return "Signed in recently" }
            return "Signed in \(date.formatted(.relative(presentation: .named)))"
        }
        var ask: String {
            switch self {
            case .phone: "wants access"
            case .computer: "wants to send you encrypted cards"
            case .browser: "wants to read your Relo cards"
            }
        }
        var declineLine: String {
            switch self {
            case .phone: "Sign it out. It won't be able to read anything."
            case .computer: "This iPhone won't open anything it sends."
            case .browser: "It won't be able to read anything here. Remove it in Devices if you don't know it."
            }
        }
        /// Why to approve, and the check that has to pass first.
        var approveLine: String {
            switch self {
            case .phone: "Approve it only if you just signed in on it yourself. Then your computers can send it encrypted cards."
            case .computer: "Approve it only if you just signed in to Relo on it yourself. Then this iPhone opens what it sends."
            case .browser: "Approve only if your browser shows the same code."
            }
        }
        var symbol: String {
            switch self {
            case .phone: "iphone"
            case .computer(let computer): (computer.client.icon ?? .laptop).systemImageName
            case .browser: "globe"
            }
        }
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
    /// Browsers that asked, from their Dashboard, to be linked by this phone.
    private(set) var pendingBrowsers: [ReloPendingBrowser] = []
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
    /// Sends this phone's signed approval of a computer it approved, so it opens on every trusted device too.
    @ObservationIgnored var shareApproval: ((ReloClientKey) -> Void)?

    init(ring: ReloKeyRing = .live(), trust: ReloTrustedClients = .live(), linked: ReloLinkedBrowsers = .live()) {
        self.ring = ring
        self.trust = trust
        self.linked = linked
    }

    /// Computers that appeared after this phone's first contact and wait for the owner here.
    var waitingComputers: [Computer] { computers.filter { $0.trust == .pending } }

    /// Everything waiting for the owner: phones, browsers, then computers.
    var waitingRequests: [AccessRequest] {
        pendingDevices.map(AccessRequest.phone) + pendingBrowsers.map(AccessRequest.browser)
            + waitingComputers.map(AccessRequest.computer)
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
        await loadPending(credential: credential, approver: client as? any DeviceApproving,
                          linker: client as? any BrowserLinking)
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

    func loadPending(credential: DeviceCredential?, approver: (any DeviceApproving)?,
                     linker: (any BrowserLinking)? = nil) async {
        guard let credential, let approver else {
            pendingDevices = []
            pendingBrowsers = []
            pendingLoaded = true
            return
        }
        do {
            pendingDevices = try await approver.pendingDevices(credential: credential)
            pendingProblem = nil
        } catch {
            pendingProblem = Self.message(for: error, doing: "check for new devices")
        }
        if let linker {
            // Best effort: an older server has no link requests, and the rest keeps working.
            if let browsers = try? await linker.browserLinkRequests(credential: credential) {
                pendingBrowsers = browsers.filter { $0.linkCode != nil }
            }
        } else {
            pendingBrowsers = []
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
        case .browser(let browser): await approveBrowser(browser, credential: credential, approver: approver, signer: signer)
        }
    }

    @discardableResult
    func decline(_ request: AccessRequest, credential: DeviceCredential?, approver: (any DeviceApproving)?) async -> Bool {
        switch request {
        case .phone(let device): await decline(device, credential: credential, approver: approver)
        case .computer(let computer): declineComputer(computer)
        case .browser(let browser): await declineBrowser(browser, credential: credential, approver: approver)
        }
    }

    /// Signs the browser's key exactly like a scanned code (and remembers it to re-sign), then it leaves the list.
    private func approveBrowser(_ browser: ReloPendingBrowser, credential: DeviceCredential?,
                                approver: (any DeviceApproving)?, signer: (any ReloIdentitySigning)?) async -> Bool {
        guard let code = try? browser.code() else {
            pendingProblem = "This browser's code is damaged. Ask again from the Dashboard."
            return false
        }
        answeringDevice = browser.browserId
        defer { answeringDevice = nil }
        await link(code, credential: credential, linker: approver as? any BrowserLinking, signer: signer)
        // link() reports through linkResult; a request sheet shows the problem inline instead.
        let linkedOK = (try? linked.contains(browser.browserId)) ?? false
        if linkedOK {
            pendingBrowsers.removeAll { $0.browserId == browser.browserId }
            pendingProblem = nil
            linkResult = nil
        } else {
            pendingProblem = linkResult?.message ?? "Relo could not link \(browser.name). Try again."
            linkResult = nil
        }
        return linkedOK
    }

    private func declineBrowser(_ browser: ReloPendingBrowser, credential: DeviceCredential?,
                                approver: (any DeviceApproving)?) async -> Bool {
        guard let credential, let linker = approver as? any BrowserLinking else {
            pendingProblem = "Sign in to Relo on this iPhone first."
            return false
        }
        answeringDevice = browser.browserId
        defer { answeringDevice = nil }
        do {
            try await linker.declineBrowserLinkRequest(credential: credential, browserID: browser.browserId)
            pendingBrowsers.removeAll { $0.browserId == browser.browserId }
            pendingProblem = nil
            return true
        } catch {
            pendingProblem = Self.message(for: error, doing: "decline \(browser.name)")
            return false
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
        shareApproval?(computer.client)
        return true
    }

    /// Signs a computer out of the account on the server, then forgets it on this iPhone. Throws what the owner reads.
    func signOutComputer(_ computer: Computer, credential: DeviceCredential?, approving: (any ComputerApproving)?) async throws {
        if !computer.unlisted {
            guard let credential, let approving else { throw SignOutProblem("Sign in to Relo on this iPhone first.") }
            do {
                try await approving.revokeComputer(credential: credential, clientID: computer.client.clientId)
            } catch {
                throw SignOutProblem(Self.message(for: error, doing: "sign out \(computer.client.name)"))
            }
        }
        try? trust.forget(clientId: computer.client.clientId)
        computers.removeAll { $0.id == computer.id }
    }

    struct SignOutProblem: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    /// Removes a browser and reports the failure instead of an alert (the detail screen shows it inline).
    @discardableResult
    func removeBrowser(_ target: UnlinkTarget, credential: DeviceCredential?, linker: (any BrowserLinking)?) async -> Bool {
        await unlink(target, credential: credential, linker: linker)
        return linkResult == nil
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
    /// Sign in a computer: scanning its `relo auth login` QR code, then the request it made, to approve or deny.
    @State private var scanningSignIn = false
    @State private var signIn: ReloComputerSignIn.Request?
    /// A sign-in whose CLI sent its key: the number check and the connecting follow-up.
    @State private var numberedSignIn: ReloComputerSignIn.Request?
    @State private var signingIn = false
    @Environment(\.scenePhase) private var scenePhase

    private var security: EncryptionSecurityModel { model.devices }
    private var linker: (any BrowserLinking)? { model.apiClient as? any BrowserLinking }
    private var signInApprover: (any ComputerSignInApproving)? { model.apiClient as? any ComputerSignInApproving }
    private var inviter: (any ComputerInviting)? { model.apiClient as? any ComputerInviting }

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
            CodeScannerView(title: "Link a browser", hint: "Point the camera at the QR code on Relo's web Dashboard.",
                            source: "the code from the Dashboard", parse: ReloBrowserLink.parse) { code in
                scanning = false
                pendingCode = code
            }
        }
        .sheet(isPresented: $scanningSignIn) {
            CodeScannerView(title: "Sign in a computer", hint: "Point the camera at the QR code relo auth login shows on the computer.",
                            source: "the code relo auth login shows",
                            parse: { [serverURL = model.serverURL] in try ReloComputerSignIn.parse($0, server: serverURL) }) { code in
                scanningSignIn = false
                Task { await loadSignIn(code) }
            }
        }
        .sheet(item: $numberedSignIn) { request in
            if let credential = model.credential, let signInApprover {
                ComputerSignInNumberSheet(request: request, credential: credential, approver: signInApprover) { client in
                    await model.shareComputerApproval(client)
                    await model.refreshDevices()
                }
            }
        }
        .reloConfirmation(item: $signIn) { request in
            ReloConfirmSpec(
                title: "Sign in \u{201C}\(request.clientName)\u{201D}?",
                message: "Check that the computer shows \(request.userCode). It will be able to send you cards, questions and notifications.",
                symbol: "laptopcomputer.and.iphone", actionTitle: "Approve", destructive: false,
                alternative: .init(title: "Deny", destructive: true) { await decideSignIn(request, approve: false) },
                action: { await decideSignIn(request, approve: true) })
        }
        .reloConfirmation(item: $pendingCode) { code in
            ReloConfirmSpec(
                title: "Link this browser?", message: "It will be able to read your encrypted cards.",
                symbol: "globe", actionTitle: "Link Browser", destructive: false,
                action: { await security.link(code, credential: model.credential, linker: linker, signer: model.answerSigner?()) })
        }
        .reloConfirmation(item: $pendingUnlink) { target in
            ReloConfirmSpec(
                title: "Remove \(target.name)?", message: "It won't be able to read your encrypted cards anymore.",
                symbol: "globe", actionTitle: "Remove",
                action: { await security.unlink(target, credential: model.credential, linker: linker) })
        }
        .sheet(item: Binding(get: { security.linkResult }, set: { security.linkResult = $0 })) { result in
            ReloSheet(cancelTitle: "OK") {
                ReloSheetHeader(symbol: result.title.hasPrefix("Not") ? "exclamationmark.triangle" : "checkmark.circle",
                                tint: result.title.hasPrefix("Not") ? .reloAttention : .reloDone,
                                title: result.title, message: result.message)
            } actions: {
                EmptyView()
            }
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
                        DeviceRow(symbol: request.symbol, tint: Color.reloAttention, title: request.name,
                                  detail: [request.modelLine, request.linkCode.map { "Code \($0)" }, request.signedInLine]
                                    .compactMap { $0 }.joined(separator: " · "),
                                  status: request.isPhone ? "Wants access"
                                    : request.isBrowser ? "Wants to read your Relo cards" : "Wants to send you encrypted cards",
                                  statusColor: Color.reloAttention, chevron: true)
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
                        : status == .waitingForApproval ? Color.reloAttention : Color.reloErrorText,
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
                              statusColor: phone.trusted ? Color.reloSecondaryText : Color.reloAttention)
                }
            } header: { Text("Phones") }
            .listRowBackground(ReloListRowBackground())
        }
    }

    private var computersSection: some View {
        Section {
            ForEach(security.computers.filter { $0.trust != .pending }) { computer in
                NavigationLink { ComputerDetailView(model: model, computer: computer) } label: {
                    DeviceRow(symbol: (computer.client.icon ?? .laptop).systemImageName, tint: .reloIndigo, title: computer.client.name,
                              detail: ComputerDetailView.noticeLine(computer),
                              status: ComputerDetailView.statusLine(computer),
                              statusColor: computer.trust == .declined || computer.unlisted
                                ? Color.reloAttention : Color.reloSecondaryText)
                }
            }
            Button {
                scanningSignIn = true
            } label: {
                if signingIn {
                    HStack { ProgressView(); Text("Signing in…") }
                } else {
                    Label("Sign in a computer", systemImage: "qrcode.viewfinder")
                }
            }
            .disabled(signingIn || model.credential == nil || signInApprover == nil)
            .accessibilityIdentifier("sign-in-computer")
            Button {
                model.openComputerSetup()
            } label: {
                Label(model.computerSetup.hasPending ? "Resume connecting a computer" : "Add a computer",
                      systemImage: "plus.rectangle.on.rectangle")
            }
            .disabled(model.credential == nil || inviter == nil)
            .accessibilityIdentifier("add-computer")
        } header: { Text("Computers") } footer: {
            Text("Add a computer gives you one command, or a prompt for your agent, to connect a server or another computer. Sign in a computer scans the QR code relo auth login shows.")
        }
        .listRowBackground(ReloListRowBackground())
    }

    // MARK: Signing in a computer

    private func loadSignIn(_ code: String) async {
        guard let credential = model.credential, let signInApprover else { return }
        signingIn = true
        defer { signingIn = false }
        do {
            let request = try await signInApprover.computerSignIn(credential: credential, userCode: code)
            if request.isPending {
                if request.identityKey != nil { numberedSignIn = request } else { signIn = request }
            } else { security.linkResult = .init(title: "Not signed in", message: ReloComputerSignIn.DecisionError.alreadyDecided.localizedDescription) }
        } catch {
            security.linkResult = .init(title: "Not signed in", message: Self.describe(error))
        }
    }

    private func decideSignIn(_ request: ReloComputerSignIn.Request, approve: Bool) async {
        guard let credential = model.credential, let signInApprover else { return }
        signingIn = true
        defer { signingIn = false }
        do {
            try await signInApprover.decideComputerSignIn(credential: credential, userCode: request.userCode, approve: approve)
            security.linkResult = approve
                ? .init(title: "\(request.clientName) is signing in", message: "It finishes on the computer in a few seconds. If it is new to this account, approve its key when it asks.")
                : .init(title: "Sign-in denied", message: "\(request.clientName) was not signed in.")
            if approve { await model.refreshDevices() }
        } catch {
            security.linkResult = .init(title: "Not signed in", message: Self.describe(error))
        }
    }

    private static func describe(_ error: any Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? "Relo could not reach your server. Try again."
    }

    @ViewBuilder private var browsersSection: some View {
        Section {
            ForEach(security.browsers) { browser in
                NavigationLink { BrowserDetailView(model: model, target: .local(browser)) } label: {
                    DeviceRow(symbol: "globe", tint: .reloMagenta, title: browser.name,
                              detail: "Linked \(browser.linkedAt.formatted(.relative(presentation: .named)))",
                              status: "Can read encrypted cards", statusColor: Color.reloSecondaryText)
                }
                    .swipeActions { Button("Remove", role: .destructive) { pendingUnlink = .local(browser) } }
                    .contextMenu {
                        Button("Remove", systemImage: "xmark.circle", role: .destructive) { pendingUnlink = .local(browser) }
                    }
            }
            ForEach(security.serverOnlyBrowsers ?? []) { browser in
                NavigationLink { BrowserDetailView(model: model, target: .serverOnly(browser)) } label: {
                    DeviceRow(symbol: "globe", tint: .reloMagenta, title: browser.name,
                              detail: "Linked from another device",
                              status: "Stops working within 14 days", statusColor: Color.reloAttention)
                }
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
            Text("Scan the QR code on Relo's web Dashboard. Open a browser, or swipe it, to remove it.")
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
                ReloChevron()
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
    let model: AppModel
    let computer: EncryptionSecurityModel.Computer
    @Environment(\.dismiss) private var dismiss
    @State private var confirmsSignOut = false

    private var security: EncryptionSecurityModel { model.devices }

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
                DeviceRow(symbol: (current.client.icon ?? .laptop).systemImageName, tint: .reloIndigo, title: current.client.name,
                          detail: Self.noticeLine(current), status: Self.statusLine(current),
                          statusColor: Color.reloSecondaryText)
                if current.trust == .declined {
                    Button("Approve") { security.approveComputer(current) }
                } else if current.trust == .auto || current.trust == .verified {
                    Button("Stop opening its cards", role: .destructive) { security.declineComputer(current); dismiss() }
                }
                Button("Sign out this computer", role: .destructive) { confirmsSignOut = true }
                    .accessibilityIdentifier("sign-out-computer")
            } footer: {
                Text(current.unlisted
                     ? "The server no longer lists this computer. Signing it out here makes this iPhone forget it."
                     : "Signing out stops it sending and reading your encrypted cards until you sign it in again.")
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
        .reloConfirmation(isPresented: $confirmsSignOut) {
            let computer = current
            return ReloConfirmSpec(
                title: "Sign out \(computer.client.name)?",
                message: "It stops sending and reading your encrypted cards until you sign it in again.",
                symbol: "laptopcomputer.slash", actionTitle: "Sign out",
                ownerCheckReason: "Sign out \(computer.client.name)",
                action: {
                    try await security.signOutComputer(computer, credential: model.credential,
                                                       approving: model.apiClient as? any ComputerApproving)
                    dismiss()
                })
        }
    }

    private func formatted(_ number: String) -> String {
        let groups = number.split(separator: " ")
        return stride(from: 0, to: groups.count, by: 4)
            .map { groups[$0..<min($0 + 4, groups.count)].joined(separator: " ") }
            .joined(separator: "\n")
    }
}

/// One linked browser: when it was linked, by whom, and a Remove button behind the device-owner check.
private struct BrowserDetailView: View {
    let model: AppModel
    let target: EncryptionSecurityModel.UnlinkTarget
    @Environment(\.dismiss) private var dismiss
    @State private var confirmsRemoval = false

    private var linker: (any BrowserLinking)? { model.apiClient as? any BrowserLinking }
    private static let isoFormatter = ISO8601DateFormatter()

    private var linkedLine: String {
        switch target {
        case .local(let browser): "Linked \(browser.linkedAt.formatted(.relative(presentation: .named)))"
        case .serverOnly(let browser):
            Self.isoFormatter.date(from: browser.linkedAt)
                .map { "Linked \($0.formatted(.relative(presentation: .named)))" } ?? "Linked from another device"
        }
    }

    var body: some View {
        List {
            Section {
                switch target {
                case .local:
                    DeviceRow(symbol: "globe", tint: .reloMagenta, title: target.name, detail: linkedLine,
                              status: "Linked by this iPhone", statusColor: Color.reloSecondaryText)
                case .serverOnly:
                    DeviceRow(symbol: "globe", tint: .reloMagenta, title: target.name, detail: linkedLine,
                              status: "Linked elsewhere. Stops working within 14 days.", statusColor: Color.reloAttention)
                }
                Button("Remove browser", role: .destructive) { confirmsRemoval = true }
                    .accessibilityIdentifier("remove-browser")
            } footer: {
                Text("A removed browser can no longer read your encrypted cards. Link it again from the Dashboard to bring it back.")
            }
            .listRowBackground(ReloListRowBackground())
        }
        .listStyle(.insetGrouped)
        .navigationTitle(target.name)
        .navigationBarTitleDisplayMode(.inline)
        .reloConfirmation(isPresented: $confirmsRemoval) {
            ReloConfirmSpec(
                title: "Remove \(target.name)?", message: "It won't be able to read your encrypted cards anymore.",
                symbol: "globe", actionTitle: "Remove", ownerCheckReason: "Remove \(target.name)",
                action: {
                    if await model.devices.removeBrowser(target, credential: model.credential, linker: linker) { dismiss() }
                })
        }
    }
}


/// Approving a computer's sign-in by its number: the owner picks the number the terminal shows among two decoys, the
/// phone approves, then waits for the computer's login and key and approves that key too
/// (docs/ENCRYPTION-PROTOCOL.md, "Sign-in number").
struct ComputerSignInNumberSheet: View {
    let request: ReloComputerSignIn.Request
    let credential: DeviceCredential
    let approver: any ComputerSignInApproving
    let approveKey: (ReloClientKey) async -> Void
    @Environment(\.dismiss) private var dismiss

    private enum Phase: Equatable { case choosing, mismatch(retry: Bool), connecting, connected, later, failed(String), denied }

    @State private var phase = Phase.choosing
    @State private var choices: [String] = []
    @State private var retried = false
    @State private var working = false

    private var real: String { ReloComputerSignIn.Number.compute(userCode: request.userCode, identityKey: request.identityKey ?? "") }

    var body: some View {
        ReloSheet(cancelTitle: nil, busy: phase == .connecting || working, sizing: .detents([.medium, .large])) {
            ReloSheetHeader(symbol: icon, title: title, message: message)
        } content: {
            content
        } actions: {
            actions
        }
        .onAppear { if choices.isEmpty { choices = ReloComputerSignIn.Number.choices(real: real) } }
    }

    private var icon: String {
        switch phase {
        case .connected: "checkmark.circle"
        case .mismatch, .failed: "exclamationmark.triangle"
        default: "laptopcomputer.and.iphone"
        }
    }

    private var title: String {
        switch phase {
        case .choosing: "Sign in \u{201C}\(request.clientName)\u{201D}?"
        case .mismatch: "Wrong number"
        case .connecting: "Connecting\u{2026}"
        case .connected: "\u{2713} \(request.clientName) connected and approved"
        case .later: "It will ask for approval later"
        case .failed: "Not signed in"
        case .denied: "Sign-in denied"
        }
    }

    private var message: String {
        switch phase {
        case .choosing: "Which number does your terminal show?"
        case .mismatch: "That doesn't match. Deny this sign-in unless you're sure it's yours."
        case .connecting: "Waiting for \(request.clientName) to finish signing in."
        case .connected: "Its encrypted cards open on this iPhone."
        case .later: "\(request.clientName) is signed in. Approve its key from Devices when it asks."
        case .failed(let text): text
        case .denied: "\(request.clientName) was not signed in."
        }
    }

    @ViewBuilder private var content: some View {
        switch phase {
        case .choosing:
            HStack(spacing: 12) {
                ForEach(choices, id: \.self) { number in
                    Button { pick(number) } label: {
                        Text(number).font(.largeTitle.weight(.semibold).monospacedDigit()).frame(minHeight: 64)
                    }
                    .buttonStyle(.reloSecondary)
                    .accessibilityIdentifier("sign-in-number-\(number)")
                }
            }
            .disabled(working)
        case .connecting:
            ProgressView()
        default:
            EmptyView()
        }
    }

    @ViewBuilder private var actions: some View {
        switch phase {
        case .choosing:
            Button("Deny") { Task { await deny() } }.buttonStyle(.reloDestructive).disabled(working)
        case .mismatch(let retry):
            Button("Deny this sign-in") { Task { await deny() } }.buttonStyle(.reloDestructive).disabled(working)
            if retry {
                Button("Try again") { phase = .choosing }.buttonStyle(.reloSecondary)
            }
            Button("Cancel") { dismiss() }.buttonStyle(.reloSecondary)
        case .connecting:
            EmptyView()
        case .connected, .later, .failed, .denied:
            Button("Done") { dismiss() }.buttonStyle(.reloPrimary)
        }
    }

    private func pick(_ number: String) {
        guard number == real else {
            let allowRetry = !retried
            retried = true
            phase = .mismatch(retry: allowRetry)
            return
        }
        Task {
            working = true
            defer { working = false }
            guard await DeviceOwnerCheck.confirm(reason: "Sign in \(request.clientName)") else { return }
            do {
                try await approver.decideComputerSignIn(credential: credential, userCode: request.userCode, approve: true)
            } catch {
                phase = .failed((error as? LocalizedError)?.errorDescription ?? "Relo could not reach your server. Try again.")
                return
            }
            phase = .connecting
            await connect()
        }
    }

    private func deny() async {
        working = true
        defer { working = false }
        do {
            try await approver.decideComputerSignIn(credential: credential, userCode: request.userCode, approve: false)
            phase = .denied
        } catch {
            phase = .failed((error as? LocalizedError)?.errorDescription ?? "Relo could not reach your server. Try again.")
        }
    }

    /// Polls every 2 s for up to 2 minutes while this sheet is open, until the computer's login and key are there.
    private func connect() async {
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline, !Task.isCancelled {
            if let latest = try? await approver.computerSignIn(credential: credential, userCode: request.userCode),
               latest.keyPublished == true, let clientId = latest.clientId, let key = latest.identityKey {
                // The key the number came from, not whatever a later read says.
                guard key == request.identityKey,
                      let approved = ReloComputerSignIn.approvedKey(clientId: clientId, name: request.clientName, identityKey: key) else {
                    phase = .later
                    return
                }
                await approveKey(approved)
                phase = .connected
                return
            }
            try? await Task.sleep(for: .seconds(2))
        }
        phase = .later
    }
}
