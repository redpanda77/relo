//
//  ReloLocalMode.swift
//  Relo Notch
//
//  Relo for Mac's local mode (plan 16): the first-run setup that starts the server on this Mac, signs the app and the
//  relo command in, and sets up the owner's agents; what runs at each launch; and leaving or uninstalling.
//

import AppKit
import Foundation
import Defaults
import LaunchAtLogin
import Observation
import ReloNotchKit
import ReloVoice
import ServiceManagement

enum ReloLocalMode {
    static let defaultsKey = LocalMode.defaultsKey
    static let versionKey = "relo.localMode.lastRelease"

    /// This build's release as the launch check compares it ("0.1.2+257").
    static var releaseKey: String {
        let info = Bundle.main.infoDictionary ?? [:]
        return "\(info["CFBundleShortVersionString"] as? String ?? "?")+\(info["CFBundleVersion"] as? String ?? "?")"
    }

    static var isOn: Bool { LocalMode.isOn() }
    static func set(_ on: Bool) { UserDefaults.standard.set(on, forKey: defaultsKey) }

    // MARK: Signed out: never a dead end

    /// Every signed-out surface (the notch, the menu bar, the onboarding) offers Relo on this Mac when this build
    /// carries the server.
    @MainActor static var canRunHere: Bool { isBundled && setupProblem == nil }

    /// This build carries the server (whether or not it can run here: see `setupProblem`).
    @MainActor static var isBundled: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--relo-preview-bundled") { return true }
        #endif
        return ReloServerService.shared.isBundled
    }

    /// Why Relo on this Mac cannot work here (the app is outside Applications, an Intel Mac), in words; nil when it can.
    @MainActor static var setupProblem: String? {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--relo-preview-bundled") { return nil }
        #endif
        return ReloServerService.shared.server.setupProblem()
    }

    /// Opens the folder holding this app, with the app selected (the cure for "Move Relo to your Applications folder").
    @MainActor static func showAppInFinder() {
        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
    }
    @MainActor static func runHere() {
        ReloNotch.store.cancelSignIn()
        // A switch to a server that was waiting for its sign-in is over: this Mac was chosen instead.
        ReloModeSwitch.shared.cancelPending()
        ReloLocalSetupWindowController.shared.show()
    }

    /// "Can't sign in?": no account yet, a forgotten password, a server that does not answer. Trying Relo on this Mac
    /// needs none of it, and signing in can wait (Settings, the notch and the menu bar all offer it later).
    @MainActor static func cantSignIn() {
        let alert = NSAlert()
        alert.messageText = "Can't sign in right now?"
        if canRunHere {
            alert.informativeText = "No problem. Try Relo on this Mac: it needs no account, and nothing leaves this Mac. You can sign in later from the notch or Relo's Settings."
            alert.addButton(withTitle: "Try it on this Mac")
            alert.addButton(withTitle: "Not now")
        } else {
            alert.informativeText = "Ask whoever runs your Relo server to reset your password or send you an invite, then sign in again."
            alert.addButton(withTitle: "OK")
        }
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn, canRunHere { runHere() }
    }

    /// Sign in to the chosen server; with none chosen yet, the onboarding asks for one (and offers this Mac too).
    @MainActor static func signInOrSetUp() {
        let store = ReloNotch.store
        if store.originChosen { Task { await store.signIn() } } else { NotificationCenter.default.post(name: .reloNeedsSetup, object: "server") }
    }

    /// Shows Relo's logs in Finder (the folder is made first, so the button always opens something).
    @MainActor static func showDetails() {
        let folder = ReloServerService.shared.server.logsFolder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        NSWorkspace.shared.open(folder)
    }

    /// This launch was opened by an install script that adds this Mac to a server of the owner's: the store leaves
    /// local mode and signs in there, so the local server is not started.
    static var leavingForInstaller: Bool {
        guard let launch = InstallerLaunch(arguments: CommandLine.arguments), let origin = launch.origin else { return false }
        return !UpdatePolicy.isLoopback(origin) && launch.signInCode != nil && launch.codeVerifier != nil
    }

    /// Says "Relo is ready" once per launch (a login launch stays quiet).
    private static var greeted = false

    /// Every launch: keep the background server current with this app, and refresh the agents after an update. The
    /// notch is already on screen (from the last Now when there is one); nothing here waits on the main actor. Until
    /// the server answers the notch says "Starting Relo…" only when it has nothing to show; when it cannot start, the
    /// notch and the home window say so, with Try again.
    @MainActor static func onLaunch() {
        guard isOn, !leavingForInstaller else { return }
        let service = ReloServerService.shared
        guard service.isBundled else { return }
        let store = ReloNotch.store
        store.setLocalStarting(true)
        let server = service.server
        Task { @MainActor in
            let problem = await start(server, restartCap: 20, onAnswering: { announceReady() })
            store.setLocalStartFailed(problem != nil, detail: problem)
            store.setLocalStarting(false)
            guard problem == nil else { return }
            if let port = server.port() { store.followLocalPort(port) }
            store.refreshNow()
            ReloLaunchHealing.onLaunch()
            // Off the main actor, every launch: the relo command is the app's (written again if it moved or went
            // missing, and an older relo there is replaced), and the agents are refreshed after an update (60 s at
            // most), which also points their hooks at that launcher; the result shows as the "Updated to …" moment.
            await Task.detached { _ = try? server.installLauncher() }.value
            let last = UserDefaults.standard.string(forKey: versionKey)
            if last != server.appRelease {
                if last != nil {
                    ReloUpdater.shared.announceUpdated(agents: .notApplicable)
                    do {
                        try await server.refreshAgents(timeout: 60)
                        // Saved only after the refresh worked: a failed or timed-out one is tried again at the next launch.
                        UserDefaults.standard.set(server.appRelease, forKey: versionKey)
                        ReloUpdater.shared.announceUpdated(agents: .refreshed)
                    } catch { ReloUpdater.shared.announceUpdated(agents: .failed) }
                } else {
                    UserDefaults.standard.set(server.appRelease, forKey: versionKey)
                }
            }
        }
    }

    /// The server answered: the notch follows its port and reads Now at once, and (once per launch, not at login) the
    /// voice says it is ready.
    @MainActor private static func announceReady() {
        let store = ReloNotch.store
        if let port = ReloServerService.shared.server.port() { store.followLocalPort(port) }
        store.setLocalStarting(false)
        store.refreshNow()
        guard !greeted else { return }
        greeted = true
        guard !LaunchAtLogin.wasLaunchedAtLogin, Defaults[.reloVoiceButton], ReloVoiceMode.current.speaks,
              !ReloMoments.quiet, !Microphone.inUse, ReloNotch.voice.models.state == .ready else { return }
        Task { @MainActor in
            // After the launch cue ends.
            try? await Task.sleep(for: .seconds(max(0, ReloCuePlayer.shared.endsAt.timeIntervalSinceNow) + 0.25))
            ReloNotch.voice.speak(id: "launch|ready", text: "Relo is ready")
        }
    }

    /// Registers the background item off the main actor (macOS can take a moment), in plain words when it will not.
    nonisolated private static func register(plist: String) throws {
        let service = SMAppService.agent(plistName: plist)
        let approval = LocalServer.Failure("macOS needs your approval: turn on Relo under Login Items in System Settings.")
        switch service.status {
        case .enabled: return
        case .requiresApproval: throw approval
        default:
            do { try service.register() } catch {
                if service.status == .requiresApproval { throw approval }
                throw LocalServer.Failure("macOS would not let Relo run in the background.")
            }
            if service.status == .requiresApproval { throw approval }
        }
    }

    /// Registers the background item, waits for it, and restarts it when it is an older release (at most `restartCap`
    /// seconds). `onAnswering` runs as soon as a server answers, an older one included, so the notch is live while a
    /// restart goes on. The words of why it will not run, or nil when it runs.
    @MainActor private static func start(_ server: LocalServer, restartCap: TimeInterval = 20,
                                         onAnswering: (@MainActor () -> Void)? = nil) async -> String? {
        func words(_ error: Error) -> String { (error as? LocalServer.Failure)?.message ?? error.localizedDescription }
        let plist = server.agentPlistName
        do { try await Task.detached { try register(plist: plist) }.value } catch { return words(error) }
        ReloServerService.shared.refreshState()
        let ready: (port: Int, health: LocalServer.Health)
        do { ready = try await server.waitUntilReady(timeout: 60) } catch { return words(error) }
        onAnswering?()
        guard server.needsRestart(runningRelease: ready.health.release) else { return nil }
        // The old server stops, the new one starts: the notch keeps what it shows while the release matches again.
        ReloNotch.store.setLocalStarting(true)
        try? await server.restartServer()
        let deadline = Date().addingTimeInterval(restartCap)
        var foreign = false
        var delay = 0.5
        while Date() < deadline {
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 1.5, 2)
            switch await server.probe() {
            case .ours(_, let health): if !server.needsRestart(runningRelease: health.release) { return nil }
            case .foreign: foreign = true
            case .silent: break
            }
        }
        return foreign ? LocalServer.foreignPortMessage : "Relo is taking longer than usual to start. Try again."
    }

    /// "Try again" after Relo could not start on this Mac.
    @MainActor static func retryStart() async -> Bool {
        let store = ReloNotch.store
        store.setLocalStarting(true)
        let problem = await start(ReloServerService.shared.server)
        store.setLocalStarting(false)
        store.setLocalStartFailed(problem != nil, detail: problem)
        if problem == nil {
            if let port = ReloServerService.shared.server.port() { store.followLocalPort(port) }
            store.refreshNow()
        }
        return problem == nil
    }

    /// Links this Mac's relo command and the app to Relo on this Mac: an invite, the join into the `local` profile (which
    /// sets up `agents`, or nothing when `setUp` is false), then the app's own sign-in. The owner is asked nothing. The
    /// local flag is set by the sign-in itself, once it worked; a login to another server is left first.
    @MainActor static func link(agents: [String], setUp: Bool) async throws {
        let server = ReloServerService.shared.server
        let store = ReloNotch.store
        let invite = try await server.invite(level: "guide", agents: agents)
        let pkce = LocalServer.pkce()
        let name = Host.current().localizedName ?? "This Mac"
        let code = try await server.join(code: invite.code, apiURL: invite.apiURL, challenge: pkce.challenge, clientName: String(name.prefix(80)),
                                         setUpAgents: setUp)
        // Everything on this Mac's side worked: only now is the app's login to another server left (last, so a failure
        // above leaves that login as it was), and its address is remembered for the way back.
        try Task.checkCancellation()
        if !isOn, [.connecting, .live, .offline, .needsSignIn].contains(store.connection) {
            ReloModeSwitch.rememberCurrentServer()
            await store.signOut()
        }
        await store.signInLocally(code: code, verifier: pkce.verifier, origin: invite.apiURL)
        switch store.connection {
        case .connecting, .live, .offline: return
        default: throw LocalServer.Failure("Relo could not link this Mac.")
        }
    }

    /// The notch lost its link to Relo on this Mac (credential refused or lost): link again without asking anything.
    /// Returns what went wrong, in words, or nil.
    @MainActor static func reconnect() async -> String? {
        let service = ReloServerService.shared
        do {
            try service.ensureRegistered()
            _ = try await service.server.waitUntilReady(timeout: 60)
            try await link(agents: [], setUp: false)
            ReloNotch.store.setLocalStartFailed(false)
            return nil
        } catch {
            return (error as? LocalServer.Failure)?.message ?? "Relo could not link this Mac."
        }
    }

    /// The relo command's own sign-in is to Relo on this Mac (agents report here). When it is not (after
    /// `relo auth switch`, or another login written over it) it is linked again quietly: the app stays signed in, and
    /// the owner is asked nothing. Called at every launch in local mode. True when the command reports here.
    @MainActor @discardableResult
    static func checkCommandReportsHere() async -> Bool {
        guard isOn, isBundled else { return true }
        let server = ReloServerService.shared.server
        // The server is not up: nothing can be judged or linked now (the launch check starts it first).
        guard let port = server.port() else { return true }
        if ModeSwitch.commandReportsHere(await server.commandSignIn(), localPort: port) { return true }
        do { try await relinkCommand(); return true } catch { return false }
    }

    /// Signs the relo command in to Relo on this Mac again (the `local` profile) without signing the app in again: the
    /// sign-in code the join returns for the app is simply not used.
    @MainActor private static func relinkCommand() async throws {
        let server = ReloServerService.shared.server
        let invite = try await server.invite(level: "guide", agents: [])
        let pkce = LocalServer.pkce()
        let name = Host.current().localizedName ?? "This Mac"
        _ = try await server.join(code: invite.code, apiURL: invite.apiURL, challenge: pkce.challenge,
                                  clientName: String(name.prefix(80)), setUpAgents: false)
    }

    /// "Go back to Relo on this Mac" after a switch to a server did not finish: starts the background item again, links
    /// the app and the relo command quietly (no agents list, no full setup) and refreshes the agents' setup. The words
    /// of what went wrong, or nil.
    @MainActor static func resumeLocal() async -> String? {
        let service = ReloServerService.shared
        let server = service.server
        let store = ReloNotch.store
        guard isBundled else { return "This build of Relo cannot run on this Mac." }
        do {
            try service.ensureRegistered()
            _ = try await server.waitUntilReady(timeout: 60)
            _ = try? server.installLauncher()
            try? await server.setManagedUpdates()
            store.cancelSignIn()
            try await link(agents: [], setUp: false)
            store.setLocalStartFailed(false)
            store.setLocalStarting(false)
            if let port = server.port() { store.followLocalPort(port) }
            store.refreshNow()
            try? await server.refreshAgents(timeout: 60)
            return nil
        } catch {
            return (error as? LocalServer.Failure)?.message ?? "Relo could not start on this Mac. Try again."
        }
    }

    /// Sets up the chosen agents (Settings, Agents): what went wrong, or what setup changed and what the owner still
    /// does once in an agent (Codex: trust Relo's hooks in /hooks).
    @MainActor static func setUpAgents(_ ids: [String], level: String = "guide", approvals: Bool? = nil)
        async -> (problem: String?, ownerSteps: [String], steps: [String]) {
        do {
            let result = try await ReloServerService.shared.server.setUpAgentsResult(
                ids, computer: Host.current().localizedName ?? "This Mac", level: level, approvals: approvals)
            return (nil, result.ownerSteps, result.steps)
        } catch {
            return ((error as? LocalServer.Failure)?.message ?? "Relo could not set up your agents.", [], [])
        }
    }

    /// Relo on this Mac stops and the app starts over against a server of the owner's. The CLI's `local` profile goes
    /// first (it works with the server down), so a failure there changes nothing. `ignoringProblems` is for an install
    /// script that is already signing this Mac in elsewhere. Returns what went wrong, or nil.
    @MainActor @discardableResult
    static func connectToServerInstead(ignoringProblems: Bool = false) async -> String? {
        let service = ReloServerService.shared
        let store = ReloNotch.store
        do {
            try await service.server.logoutLocalProfile()
            // The relo command goes back to updating itself, so a later CLI is not left managed by an app that is gone.
            try await service.server.setAutomaticUpdates()
        } catch {
            if !ignoringProblems { return (error as? LocalServer.Failure)?.message ?? "Relo could not leave Relo on this Mac." }
        }
        await store.signOut()
        await service.unregister()
        set(false)
        store.setLocalStartFailed(false)
        store.setLocalStarting(false)
        store.forgetServerOrigin()
        return nil
    }

    /// Asks, then leaves local mode and takes the owner to sign in (see `ReloModeSwitch`). True when it left.
    @MainActor static func confirmUseAnotherServer() async -> Bool {
        await ReloModeSwitch.shared.useServer()
    }

    /// The host of the server this Mac is signed in to now (the app's login, or the relo command's active profile), or
    /// nil when there is none to leave.
    @MainActor static func remoteLoginHost() -> String? {
        let store = ReloNotch.store
        if !isOn, [.connecting, .live, .offline, .needsSignIn].contains(store.connection),
           let host = (store.serverOrigin?.host()) { return host }
        return ReloServerService.shared.server.existingRemoteLoginHost()
    }

    /// Before Relo runs on this Mac: a login to a server of the owner's is named and left only after a yes.
    @MainActor static func confirmRunHere(replacing host: String?, then proceed: () -> Void) {
        guard let host else { proceed(); return }
        let alert = NSAlert()
        alert.messageText = ModeSwitch.tryHereTitle()
        alert.informativeText = ModeSwitch.tryHereBody(host: host)
        alert.addButton(withTitle: ModeSwitch.tryHereButton)
        alert.addButton(withTitle: "Cancel")
        // Asked from the notch or the menu bar, Relo is not the active app: the alert must come to the front.
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn {
            ReloModeSwitch.rememberCurrentServer()
            proceed()
        }
    }

    /// Removes what Relo set up on this Mac, after the owner confirmed it. Returns every problem in words, or nil.
    @MainActor static func uninstall(deleteData: Bool) async -> String? {
        let service = ReloServerService.shared
        let server = service.server
        var problems: [String] = []
        func attempt(_ work: () async throws -> Void) async {
            do { try await work() } catch {
                let text = (error as? LocalServer.Failure)?.message ?? error.localizedDescription
                if !problems.contains(text) { problems.append(text) }
            }
        }
        await ReloNotch.store.signOut()
        await attempt { try await server.uninstallAgents() }
        await attempt { try await server.logoutLocalProfile() }
        await attempt { try await server.setAutomaticUpdates() }
        await service.unregister()
        let stopped = await service.waitUntilStopped(timeout: 30)
        server.removeLauncher()
        if deleteData {
            if stopped {
                await attempt {
                    do { try FileManager.default.removeItem(at: server.dataRoot) }
                    catch { throw LocalServer.Failure("Relo could not delete its data folder.") }
                }
            } else {
                problems.append("Relo is still stopping, so its data was kept. Quit Relo and delete the Relo folder in Application Support.")
            }
        }
        set(false)
        UserDefaults.standard.removeObject(forKey: versionKey)
        // Set up again from the start next time: the onboarding, not a sign-in screen.
        BoringViewCoordinator.shared.firstLaunch = true
        ReloOnboardingProgress.reset()
        ReloNotch.store.setLocalStartFailed(false)
        ReloNotch.store.setLocalStarting(false)
        ReloNotch.store.forgetServerOrigin()
        return problems.isEmpty ? nil : problems.joined(separator: " ")
    }
}

/// The steps of "Relo on this Mac", with live state for the setup window. There is no sign-in: the app and the
/// relo command are linked to Relo on this Mac, and the owner is asked only which agents to set up. Closing the window
/// before it is done undoes what was started, so the Mac is as it was.
@MainActor @Observable
final class ReloLocalSetup {
    enum Step: Int, CaseIterable {
        case starting, agents, command, settingUp, done

        var title: String {
            switch self {
            case .starting: "Starting Relo on this Mac"
            case .agents: "Choosing your agents"
            case .command: "Connecting your terminal"
            case .settingUp: "Setting up your agents"
            case .done: "Done"
            }
        }
    }

    private(set) var step: Step = .starting
    /// Waiting on the owner (the agents list).
    private(set) var waitingForAgents = false
    private(set) var failure: String?
    private(set) var failedAt: Step?
    /// Set when the owner's own relo command stays in place: the done screen says so.
    private(set) var launcherNote: String?
    private(set) var agents: [LocalServer.Agent] = []
    var selected: Set<String> = []
    /// macOS waits for the owner to switch Relo on under Login Items (it follows the item's live state).
    var needsApproval: Bool { failure != nil && service.state == .needsApproval }
    private(set) var running = false
    /// The owner skipped agents (or none was found): Relo links the app and the command and sets up nothing.
    private(set) var skippedAgents = false
    /// The host of the server this Mac was signed in to when the setup began (the done screen says agents moved).
    private(set) var replacedHost: String?
    private var retryFrom: Step = .starting
    private var failedForApproval = false
    private var abandoned = false
    private var runTask: Task<Void, Never>?
    /// Relo ran on this Mac before this setup: undoing it must not stop that.
    private let wasLocal = ReloLocalMode.isOn
    private let hostAtStart = ReloLocalMode.remoteLoginHost()
    /// An undo still going on: the next setup waits for it, so the two never overlap.
    private static var pendingUndo: Task<Void, Never>?

    static let noAgentsText = "No agents found yet. Install Claude Code or OpenCode, then choose Set up agents again in Settings."

    private let service = ReloServerService.shared
    private var server: LocalServer { service.server }

    /// Past detection with nothing found: the row says where to set agents up later.
    var noAgentsFound: Bool { agents.isEmpty && step.rawValue >= Step.agents.rawValue }
    var chosen: [String] { agents.map(\.id).filter(selected.contains) }
    var isDone: Bool { step == .done && failure == nil }

    func begin() {
        guard !running, !abandoned else { return }
        failure = nil; failedAt = nil; failedForApproval = false
        replacedHost = hostAtStart
        running = true
        runTask = Task { await run(from: retryFrom) }
    }

    func chooseAgents() {
        guard waitingForAgents, !selected.isEmpty, !running else { return }
        waitingForAgents = false
        running = true
        runTask = Task { await run(from: .command) }
    }

    func skipAgents() {
        guard waitingForAgents, !running else { return }
        waitingForAgents = false
        skippedAgents = true
        running = true
        runTask = Task { await run(from: .command) }
    }

    /// Back out of a setup that did not finish (Back, or the window closing): what it started is stopped and undone, so
    /// nothing stays half installed. Safe to call twice, and after the setup finished it does nothing.
    func abandon() {
        guard !abandoned, !isDone else { return }
        abandoned = true
        waitingForAgents = false
        let task = runTask
        task?.cancel()
        let note = hostAtStart
        Self.pendingUndo = Task { @MainActor in
            await task?.value
            await self.undo(hostAtStart: note)
        }
    }

    /// The Mac as it was before this setup: no `local` profile, no background item, no app link to Relo on this Mac, and
    /// the last server's address back in the sign-in field.
    private func undo(hostAtStart: String?) async {
        guard !wasLocal else { return }
        let store = ReloNotch.store
        try? await server.logoutLocalProfile()
        if LocalMode.isOn() { await store.signOut() }
        await service.unregister()
        ReloLocalMode.set(false)
        store.setLocalStartFailed(false)
        store.setLocalStarting(false)
        try? await server.setAutomaticUpdates()
        // The sign-in to the server survives an early failure; after the app already left it, the address is back.
        let signedIn = [.connecting, .live, .offline].contains(store.connection)
        if !signedIn, hostAtStart != nil {
            let address = ModeSwitch.lastServerAddress()
            if !address.isEmpty { _ = store.setServerOrigin(address) }
            let alert = NSAlert()
            alert.messageText = "Relo on this Mac was not set up"
            alert.informativeText = ModeSwitch.setupUndone(host: hostAtStart)
            alert.addButton(withTitle: "OK")
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
    }

    func openLoginItems() { service.openLoginItems() }

    /// While the setup is on screen: when the owner switches Relo on under Login Items, the setup goes on by itself.
    func watchApproval() async {
        while !Task.isCancelled {
            service.refreshState()
            if failedForApproval, !running, !abandoned, service.state == .enabled { begin() }
            try? await Task.sleep(for: .seconds(1.5))
        }
    }

    private func run(from start: Step) async {
        defer { running = false }
        await Self.pendingUndo?.value
        var current = start
        do {
            if start == .starting {
                step = .starting; current = .starting
                if let problem = server.setupProblem() { throw LocalServer.Failure(problem) }
                try service.ensureRegistered()
                _ = try await server.waitUntilReady(timeout: 60)
                try Task.checkCancellation()
                agents = await server.detectAgents()
                if selected.isEmpty { selected = Set(agents.map(\.id)) }
                step = .agents; current = .agents
                if !agents.isEmpty { waitingForAgents = true; return }
                skippedAgents = true
            }
            try Task.checkCancellation()
            // The relo command comes before the agents: their instructions call `relo`.
            if start.rawValue <= Step.command.rawValue {
                step = .command; current = .command
                let launcher = try server.installLauncher()
                try await server.setUpPath()
                // Another relo command keeps updating itself: it is the owner's, not the app's.
                if launcher == .written {
                    launcherNote = nil
                    try await server.setManagedUpdates()
                } else {
                    launcherNote = LocalServer.otherLauncherNote
                }
            }
            try Task.checkCancellation()
            step = .settingUp; current = .settingUp
            try await ReloLocalMode.link(agents: skippedAgents ? [] : chosen, setUp: !skippedAgents)
            // Closed during the link: the undo (queued by the close) takes the link back out.
            if abandoned { return }
            // Agents that reported to the server now report here: make their setup say so, and make sure the relo command
            // really points here. Neither is worth failing a setup that worked.
            await ReloLocalMode.checkCommandReportsHere()
            if (try? await server.refreshAgents(timeout: 60)) == nil {
                launcherNote = [launcherNote, "Your agents' setup could not be refreshed. Choose Set up agents in Settings."]
                    .compactMap { $0 }.joined(separator: " ")
            }
            UserDefaults.standard.set(server.appRelease, forKey: ReloLocalMode.versionKey)
            step = .done
        } catch {
            if abandoned { return }
            failedAt = current
            failure = (error as? LocalServer.Failure)?.message ?? "Relo could not finish setting up on this Mac."
            failedForApproval = service.state == .needsApproval
            // A retry resumes where it stopped; the agents list is answered already once past it.
            retryFrom = current == .command || current == .settingUp ? current : .starting
            step = retryFrom
        }
    }
}
