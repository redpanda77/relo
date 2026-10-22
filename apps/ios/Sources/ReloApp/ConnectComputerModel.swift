import Foundation
import Observation
import ReloCore

/// The Connect a computer wizard (docs/internal/product/plan/13-onboarding-wizard.md, journey E): makes a one-time code
/// with a bind half only this phone knows, follows it until the computer reports, checks the computer's key against
/// the bind and signs `approve-computer` for it. Owned by `AppModel`, so the check still runs when the wizard is
/// closed, the app was in the background or it was relaunched (the code and bind half wait in the Keychain).
@MainActor @Observable
final class ConnectComputerModel {
    enum KeyCheck: Equatable {
        /// Nothing to say yet.
        case pending
        /// This phone verified the binding and approved the computer.
        case approved
        /// The key is not the one the code vouched for: not approved.
        case mismatch
    }

    /// How the owner chose to start the computer, and how deep Relo goes there (step 1).
    var mode: ReloSetupMode = .command
    var level = "track"
    /// Options: also ask permission on this iPhone, and which agents relo setup sets up (every one found, or a chosen few).
    var approvals = false
    /// Relo for Mac (the notch) comes along by default; the install script skips it on anything but a Mac.
    var macApp = true
    var allAgents = true
    var chosenAgents: Set<String> = []
    /// Approving the waiting computer by hand is running.
    private(set) var approving = false

    /// Making a code needs at least one agent when the owner chose them.
    var canMake: Bool { ReloComputerSetup.agentsOption(all: allAgents, chosen: chosenAgents) != nil }

    private(set) var pending: ReloPendingComputerInvite?
    private(set) var status: ReloComputerInviteStatus?
    private(set) var keyCheck: KeyCheck = .pending
    private(set) var making = false
    var problem: String?
    /// When the code was shown, for "Run it yourself instead" after a quiet two minutes in the agent path.
    private(set) var shownAt: Date?
    /// The code ended (expired here, or the server forgot it).
    private(set) var expired = false

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private let activity = SetupActivityController()
    @ObservationIgnored private var activityToken: String?
    @ObservationIgnored private var registeredToken: String?
    @ObservationIgnored private var refreshing = false

    init(app: AppModel) { self.app = app }

    // MARK: What the screens show

    var progress: ReloSetupProgress {
        let approvedHere = keyCheck == .approved
        var progress = ReloSetupProgress(status: status, approvedHere: approvedHere)
        if expired, !progress.isFinished { progress = ReloSetupProgress(status: ReloComputerInviteStatus(
            inviteId: pending?.inviteId ?? "", state: .expired, expiresAt: "", computer: status?.computer), approvedHere: approvedHere) }
        return progress
    }

    var hasPending: Bool { pending != nil && !expired }

    /// The command, or the prompt for the owner's agent, with the full code.
    var text: String? {
        guard let pending, let app else { return nil }
        switch pending.mode {
        case .command: return pending.command
        case .agent: return ReloComputerSetup.agentPrompt(origin: app.serverURL, fullCode: pending.fullCode, level: pending.level,
                                                         macApp: pending.command.hasSuffix(" --mac-app"))
        }
    }

    var expiryLine: String? {
        pending.map { "until \($0.expiresAt.formatted(date: .omitted, time: .shortened))" }
    }

    /// The agent path offers the command after about two minutes without a computer.
    func offersCommandInstead(now: Date = Date()) -> Bool {
        guard let pending, pending.mode == .agent, progress.stage == .waiting, let shownAt else { return false }
        return now.timeIntervalSince(shownAt) >= 120
    }

    // MARK: Making a code

    func make() async {
        guard let agents = ReloComputerSetup.agentsOption(all: allAgents, chosen: chosenAgents) else {
            problem = "Choose at least one agent, or let Relo set up every agent it finds."
            return
        }
        guard let app, let credential = app.credential, let inviter = app.apiClient as? any ComputerInviting else {
            problem = "Relo could not make the code. Check the connection and try again."
            return
        }
        making = true
        defer { making = false }
        do {
            let invite = try await inviter.inviteComputer(credential: credential, level: level, approvals: approvals, agents: agents, macApp: macApp)
            let bind = ReloComputerBind.generate()
            let expiresAt = ReloComputerSetup.expiry(invite.expiresAt) ?? Date().addingTimeInterval(30 * 60)
            let record = ReloPendingComputerInvite(
                inviteId: invite.inviteId, code: invite.code, bind: bind,
                command: ReloComputerSetup.command(for: invite, bind: bind), level: invite.level, mode: mode, expiresAt: expiresAt)
            // The bind half is kept before the code is shown: a code nobody can vouch for for is worse than none.
            try app.computerInviteStore.save(record)
            pending = record
            status = nil
            keyCheck = .pending
            expired = false
            shownAt = Date()
            problem = nil
            startActivity()
            await refresh()
        } catch {
            problem = (error as? LocalizedError)?.errorDescription ?? "Relo could not make the code. Try again."
        }
    }

    /// The computer's key is here but this phone could not vouch for it by the binding (none was sent), and the server
    /// still counts no approval: the owner can approve it by hand, as in Settings → Devices. Never after a mismatch: a key
    /// that does not match its code may be one the server swapped in, so the wizard offers no shortcut to approve it.
    var needsManualApproval: Bool {
        guard keyCheck != .approved, keyCheck != .mismatch, progress.needsApproval, status?.computer?.identityKey != nil else { return false }
        return true
    }

    /// The same approval the automatic path signs, for the owner's own decision.
    func approveByHand() async {
        guard let app, let credential = app.credential, let keys = app.encryptionKeys, let computer = status?.computer,
              let identityKey = computer.identityKey,
              let key = ReloClientKey.joining(clientID: computer.clientId, name: computer.name, identityKey: identityKey),
              !approving else { return }
        approving = true
        defer { approving = false }
        if await keys.approve(key, credential: credential) {
            if var record = pending {
                record.approved = ReloComputerBindCheck.marker(clientID: computer.clientId, identityKey: identityKey)
                pending = record
                try? app.computerInviteStore.save(record)
            }
            keyCheck = .approved
            problem = nil
            await app.refreshDevices()
            await refresh()
        } else {
            problem = "Relo could not approve \(computer.name). Try again."
        }
    }

    /// The command instead of the prompt, with the same code.
    func useCommandInstead() {
        guard var record = pending else { return }
        record.mode = .command
        pending = record
        try? app?.computerInviteStore.save(record)
    }

    // MARK: Following it

    /// Picks up the code kept in the Keychain (after a relaunch, or when the wizard opens).
    func restore(now: Date = Date()) {
        guard pending == nil, let app else { return }
        guard let record = try? app.computerInviteStore.load() else { return }
        if record.isExpired(now) && record.approved != nil {
            try? app.computerInviteStore.delete()
            return
        }
        pending = record
        expired = record.isExpired(now)
        keyCheck = record.approved == nil ? .pending : .approved
        shownAt = shownAt ?? now
        if !expired { startActivity() }
    }

    /// One look at the code's status: updates the screens, checks the bind and approves, or ends it.
    func refresh(now: Date = Date()) async {
        restore(now: now)
        guard let app, var record = pending, !refreshing else { return }
        guard let credential = app.credential, let tracker = app.apiClient as? any ComputerInviteTracking else { return }
        refreshing = true
        defer { refreshing = false }
        if record.isExpired(now), progress.stage < .connected { finishExpired(); return }
        let fetched: ReloComputerInviteStatus?
        do { fetched = try await tracker.inviteStatus(credential: credential, inviteId: record.inviteId) } catch { return }
        guard let fetched else { finishExpired(); return }
        status = fetched
        if fetched.state == .expired { finishExpired(); return }
        await registerActivityToken(credential: credential, tracker: tracker, inviteId: record.inviteId)

        switch ReloComputerBindCheck.evaluate(fetched, bind: record.bind) {
        case .notYet:
            break
        case .mismatch:
            // Unless the owner approved this key by hand since.
            keyCheck = record.approved == nil ? .mismatch : .approved
        case .verified(let clientID, let identityKey):
            let marker = ReloComputerBindCheck.marker(clientID: clientID, identityKey: identityKey)
            if record.approved == marker {
                keyCheck = .approved
            } else if let key = ReloClientKey.joining(clientID: clientID, name: fetched.computer?.name ?? "", identityKey: identityKey),
                      let keys = app.encryptionKeys, await keys.approve(key, credential: credential) {
                record.approved = marker
                pending = record
                try? app.computerInviteStore.save(record)
                keyCheck = .approved
                await app.refreshDevices()
            }
        }
        let shown = progress
        activity.update(.init(state: shown.activityState, computerName: shown.computerName,
                              agents: shown.connectedAgents),
                        staleDate: record.expiresAt)
        if shown.stage == .tested { finish() }
    }

    /// Done: the Lock Screen card ends and the wizard starts over next time. Closing the sheet instead keeps everything,
    /// so the code, its check and the Live Activity go on (Settings offers Resume). A computer that connected has been
    /// checked and approved by now; one whose approval did not go through is approved the ordinary way.
    func done() {
        activity.end()
        forget()
    }

    /// An expired code makes room for a new one.
    func startOver() {
        activity.end()
        forget()
    }

    private func finish() {
        activity.end(final: .init(state: "tested", computerName: progress.computerName), lingering: 20)
        if keyCheck != .pending { forgetStore() }
    }

    private func finishExpired() {
        expired = true
        activity.end(final: .init(state: "expired"), lingering: 60)
        forgetStore()
    }

    private func forget() {
        forgetStore()
        pending = nil
        status = nil
        keyCheck = .pending
        expired = false
        shownAt = nil
        problem = nil
    }

    private func forgetStore() { try? app?.computerInviteStore.delete() }

    // MARK: Live Activity

    private func startActivity() {
        guard let record = pending else { return }
        let shown = progress
        activity.start(inviteId: record.inviteId,
                       state: .init(state: shown.activityState, computerName: shown.computerName),
                       staleDate: record.expiresAt) { [weak self] token in
            self?.activityToken = token
            self?.registeredToken = nil
            Task { await self?.refresh() }
        }
    }

    private func registerActivityToken(credential: DeviceCredential, tracker: any ComputerInviteTracking, inviteId: String) async {
        guard let token = activityToken, token != registeredToken else { return }
        if (try? await tracker.registerSetupActivity(credential: credential, inviteId: inviteId, pushToken: token)) != nil {
            registeredToken = token
        }
    }
}
