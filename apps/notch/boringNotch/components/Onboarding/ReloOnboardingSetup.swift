//
//  ReloOnboardingSetup.swift
//  Relo Notch
//
//  The plumbing behind Relo for Mac's onboarding (Hello, Sound, Where, Agents, Setting up, Ready): getting ready early,
//  finding agents, the setup as ordered items with live state, resuming across relaunches, and the voice download.
//  The server sign-in path does not use this.
//

import Defaults
import Foundation
import Observation
import ReloNotchKit
import ReloVoice

/// What is remembered between launches, so a relaunch resumes at the last answered screen.
enum ReloOnboardingProgress {
    enum Screen: String { case hello, sound, `where`, server, agents, setup, ready }
    enum Place: String { case mac, server }

    static var screen: Screen? {
        get { Screen(rawValue: Defaults[.reloOnboardingScreen]) }
        set { Defaults[.reloOnboardingScreen] = newValue?.rawValue ?? "" }
    }
    static var place: Place? {
        get { Place(rawValue: Defaults[.reloOnboardingPlace]) }
        set { Defaults[.reloOnboardingPlace] = newValue?.rawValue ?? "" }
    }
    static var agents: [String] {
        get { Defaults[.reloOnboardingAgents] }
        set { Defaults[.reloOnboardingAgents] = newValue }
    }

    static func reset() {
        Defaults[.reloOnboardingScreen] = ""
        Defaults[.reloOnboardingPlace] = ""
        Defaults[.reloOnboardingAgents] = []
    }

    /// First launch finds the background item registered but local mode off: a setup quit half way. The item goes
    /// (an orphan server must not keep running) and so does any `local` profile; the owner starts over.
    @MainActor static func cleanUpHalfSetup() async {
        let service = ReloServerService.shared
        service.refreshState()
        guard service.isBundled, !ReloLocalMode.isOn, [.enabled, .needsApproval].contains(service.state) else { return }
        try? await service.server.logoutLocalProfile()
        await service.unregister()
    }
}

@MainActor @Observable
final class ReloOnboardingSetup {
    enum ItemState: Equatable { case pending, running, done, failed(String), skipped }

    struct Item: Identifiable, Equatable {
        let id: String
        var name: String
        var state: ItemState = .pending
        var isAgent: Bool { id != ReloOnboardingSetup.reloItemID }
    }

    static let reloItemID = "relo"

    /// How much Relo adds to an agent, the CLI's `--level`.
    enum Level: String, CaseIterable {
        case notify, track, guide

        var title: String {
            switch self {
            case .notify: "Notifications and questions"
            case .track: "Live cards"
            case .guide: "Live cards and session tracking"
            }
        }
        var detail: String {
            switch self {
            case .notify: "Your agent can notify you and ask you things."
            case .track: "Adds a card on your iPhone that shows what it is doing."
            case .guide: "Also tracks each session, so cards stay current."
            }
        }
        /// What setup adds to an agent, in plain words, in the order it happens.
        var steps: [String] {
            switch self {
            case .notify, .track: ["Adding instructions", "Installing the Relo skill"]
            case .guide: ["Adding instructions", "Installing the Relo skill", "Adding session tracking"]
            }
        }
    }

    private(set) var items: [Item] = []
    private(set) var launcherNote: String?
    /// What the owner still does once in an agent after setup (Codex: trust Relo's hooks in /hooks), for Ready.
    private(set) var ownerSteps: [String] = []
    /// What stops local setup here (Apple silicon, Applications), found early; nil when nothing does.
    private(set) var problem: String?
    private(set) var detected: [LocalServer.Agent] = []
    private(set) var running = false
    private(set) var level: Level = .guide
    private(set) var approvals = false

    private let service = ReloServerService.shared
    private var server: LocalServer { service.server }
    @ObservationIgnored private var runTask: Task<Void, Never>?
    @ObservationIgnored private var watchTask: Task<Void, Never>?
    @ObservationIgnored private var prepareTask: Task<String?, Never>?
    @ObservationIgnored private var names: [String: String] = [:]

    // MARK: Early

    /// Hello, local mode: look for a problem and prepare Relo's data (no login item, nothing serving), off the main
    /// actor. Registers nothing; the problem is kept to show when the owner gets there.
    func prepareEarly() {
        guard prepareTask == nil else { return }
        let server = server
        prepareTask = Task.detached {
            if let problem = server.setupProblem() { return problem }
            // Only a head start: the server prepares itself again when it first runs, so a failure here stops nothing.
            try? await server.prepare()
            return nil
        }
        Task { problem = await prepareTask?.value }
    }

    /// The agents on this Mac. `relo setup --show --json` only reads the agents' config folders, so it needs neither
    /// the server nor a login.
    func detectAgents() async -> [LocalServer.Agent] {
        let found = await server.detectAgents()
        detected = found
        for agent in found { names[agent.id] = agent.name }
        return found
    }

    // MARK: Setup

    var needsApproval: Bool {
        guard service.state == .needsApproval, case .failed = items.first?.state else { return false }
        return true
    }

    var isDone: Bool { !items.isEmpty && items.allSatisfy { $0.state == .done || $0.state == .skipped } }
    var failedItem: Item? { items.first { if case .failed = $0.state { true } else { false } } }

    /// Sets Relo up on this Mac: the item "relo", then one item per agent, each failing on its own.
    func run(agents: [String], level: Level = .guide, approvals: Bool = false) {
        guard !running else { return }
        self.level = level
        self.approvals = approvals
        names = names.merging(Dictionary(uniqueKeysWithValues: detected.map { ($0.id, $0.name) })) { $1 }
        items = [Item(id: Self.reloItemID, name: "Relo")]
            + agents.map { Item(id: $0, name: names[$0] ?? $0) }
        start()
        watchApproval()
    }

    /// Resumes from the failed item.
    func retry() {
        guard !running, failedItem != nil else { return }
        start()
    }

    /// Skips the failed agent and goes on (the "relo" item cannot be skipped).
    func skip() {
        guard !running, let index = items.firstIndex(where: { if case .failed = $0.state { true } else { false } }),
              items[index].isAgent else { return }
        items[index].state = .skipped
        start()
    }

    func openLoginItems() { service.openLoginItems() }

    /// Quitting mid-setup: nothing half installed stays (the background item, a `local` profile, the local flag).
    func abandon() {
        runTask?.cancel(); watchTask?.cancel()
        let server = server
        Task {
            try? await server.logoutLocalProfile()
            await service.unregister()
            ReloLocalMode.set(false)
        }
    }

    private func start() {
        running = true
        runTask = Task { await process(); running = false }
    }

    /// While setup is on screen: when the owner switches Relo on under Login Items, the setup goes on by itself.
    private func watchApproval() {
        watchTask?.cancel()
        watchTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                service.refreshState()
                if !running, service.state == .enabled, case .failed = items.first?.state { retry() }
                if isDone { return }
                try? await Task.sleep(for: .seconds(1.5))
            }
        }
    }

    private func process() async {
        for index in items.indices {
            switch items[index].state {
            case .done, .skipped: continue
            default: break
            }
            items[index].state = .running
            do {
                if items[index].id == Self.reloItemID { try await setUpRelo() } else {
                    let steps = try await server.setUpAgents([items[index].id], computer: Host.current().localizedName ?? "This Mac",
                                                             level: level.rawValue, approvals: level == .guide ? approvals : nil)
                    ownerSteps += steps.filter { !ownerSteps.contains($0) }
                }
                items[index].state = .done
            } catch {
                if Task.isCancelled { items[index].state = .pending; return }
                let words = (error as? LocalServer.Failure)?.message
                    ?? (items[index].isAgent ? "Relo could not set up \(items[index].name)." : "Relo could not finish setting up on this Mac.")
                items[index].state = .failed(words)
                return
            }
        }
        UserDefaults.standard.set(server.appRelease, forKey: ReloLocalMode.versionKey)
    }

    private func setUpRelo() async throws {
        if let problem = await currentProblem() { throw LocalServer.Failure(problem) }
        try service.ensureRegistered()
        _ = try await server.waitUntilReady(timeout: 60)
        // The relo command comes before the agents: their instructions call `relo`.
        let launcher = try server.installLauncher()
        try await server.setUpPath()
        if launcher == .written {
            launcherNote = nil
            try await server.setManagedUpdates()
        } else {
            launcherNote = LocalServer.otherLauncherNote
        }
        try await ReloLocalMode.link(agents: [], setUp: false)
    }

    private func currentProblem() async -> String? {
        if let problem { return problem }
        return server.setupProblem()
    }

    #if DEBUG
    /// Debug snapshots: a setup frozen in the given states, with nothing run.
    func preview(_ items: [Item]) { self.items = items }
    #endif

    // MARK: Voice

    /// Starts the Relo voice download at Hello (unmetered networks only, as at launch).
    func startVoiceDownload() {
        let voice = ReloNotch.voice
        if voice.models.state != .ready { voice.models.downloadWhenUnmetered() }
    }

    /// Fraction downloaded (it moves as each file lands); nil when unknown or done.
    var voiceProgress: Double? {
        if case .downloading(let fraction) = ReloNotch.voice.models.state { return fraction }
        return nil
    }

    var voiceReady: Bool { ReloNotch.voice.models.state == .ready }
}
