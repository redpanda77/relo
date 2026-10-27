//
//  OnboardingView.swift
//  Relo
//
//  First launch, motion first (docs/internal/ui-studies/mac-onboarding-study.dc.html): the orb and the voice, then the
//  owner's choices (sound, where Relo runs, agents), the setup, and Ready. The window is the onboarding; the notch
//  carries it as one staged work (started, your turn on each choice, a step per choice, failed, done) and is never
//  needed to finish. The music step from boring.notch is shown only when macOS stopped the media source it relied on.
//

import AppKit
import Defaults
import LaunchAtLogin
import ReloNotchKit
import ReloVoice
import SwiftUI

enum OnboardingStep {
    case welcome
    case musicPermission
}

@MainActor @Observable
final class ReloOnboardingFlow {
    typealias Screen = ReloOnboardingProgress.Screen
    typealias Place = ReloOnboardingProgress.Place

    private(set) var screen: Screen = .hello
    /// Opened again after a quit part way: no bloom, no voice, straight to the first unanswered screen.
    private(set) var resumed = false
    var place: Place = .mac { didSet { if !isPreview { ReloOnboardingProgress.place = place } } }
    private(set) var agents: [LocalServer.Agent] = []
    /// How much Relo adds to each agent (`relo setup --level`); the recommended one unless the owner chooses.
    var level: ReloOnboardingSetup.Level = .guide { didSet { if level != .guide { approvals = false } } }
    /// Answer permission prompts from the iPhone; only with session tracking.
    var approvals = false
    var selected: Set<String> = [] { didSet { if !isPreview { ReloOnboardingProgress.agents = Array(selected) } } }
    /// A render of one screen (debug snapshots): nothing is saved, set up or changed on this Mac.
    let isPreview: Bool
    let setup = ReloOnboardingSetup()
    /// Hello's beats: 0 dark, 1 the orb, 2 the wordmark, 3 Begin.
    private(set) var helloBeat = 0
    private(set) var caption = ""
    private(set) var closing = false
    @ObservationIgnored var onFinish: () -> Void = {}

    /// This build carries the server: the Where screen offers This Mac (disabled, with the reason, when it cannot work here).
    @MainActor static var localAvailable: Bool { ReloLocalMode.isBundled }
    /// Relo on this Mac can be set up here now.
    @MainActor static var localWorks: Bool { ReloLocalMode.canRunHere }
    @MainActor static var localProblem: String? { ReloLocalMode.setupProblem }

    var screens: [Screen] {
        var list: [Screen] = [.hello, .sound]
        if Self.localAvailable { list.append(.where) }
        if place == .server || !Self.localWorks { list.append(.server) } else { list += [.agents, .setup] }
        return list + [.ready]
    }
    /// The staged work's plan: one step per screen between Hello and Ready.
    var stepsTotal: Int { screens.count - 2 }
    var canGoBack: Bool {
        if screen == .server { return screens.contains(.where) }
        return [.where, .agents].contains(screen)
    }

    /// `startAt: .server` opens straight on the server screen (a Mac that was set up before and signs in again): no
    /// bloom, no voice, no Sound or Where first; Back leads to the Where choice.
    init(startAt: Screen? = nil) {
        isPreview = false
        if startAt == .server {
            resumed = true
            place = .server
            screen = .server
            ReloOnboardingProgress.screen = .server
            helloBeat = 3
        } else if let saved = ReloOnboardingProgress.screen, saved != .hello {
            resumed = true
            place = ReloOnboardingProgress.place ?? .mac
            selected = Set(ReloOnboardingProgress.agents)
            // A setup cut short is run again from the agents; Ready is shown again.
            screen = saved == .setup ? .agents : saved
            helloBeat = 3
        }
    }

    #if DEBUG
    init(preview screen: Screen, place: Place = .mac, agents: [LocalServer.Agent] = [], helloBeat: Int = 3, caption: String = "") {
        isPreview = true
        self.screen = screen
        self.place = place
        self.agents = agents
        self.selected = Set(agents.prefix(2).map(\.id))
        self.helloBeat = helloBeat
        self.caption = caption
    }
    #endif

    // MARK: Hello

    func appear() {
        if Self.localAvailable { setup.prepareEarly() }
        setup.startVoiceDownload()
        Task { agents = await setup.detectAgents(); if selected.isEmpty { selected = Set(agents.map(\.id)) } }
        if resumed {
            if screen != .hello { ReloOnboardingNotch.resume(done: doneSteps, total: stepsTotal) }
            return
        }
        Task {
            try? await Task.sleep(for: .seconds(0.5))
            // The pilot light drops a spark into the window; it blooms into the orb.
            ReloOnboardingSpark.shared.fly(from: ReloOnboardingSpark.notchPoint, to: windowPoint(x: 280, y: 265), color: ReloNotchTheme.info,
                                           duration: 0.6, rising: false) { [weak self] in
                guard let self else { return }
                ReloCuePlayer.shared.play(.linked)
                withAnimation(ReloMotion.smooth) { self.helloBeat = 1 }
                Task {
                    try? await Task.sleep(for: .seconds(0.8))
                    withAnimation(ReloMotion.smooth) { self.helloBeat = 2 }
                    try? await Task.sleep(for: .seconds(0.4))
                    self.welcome()
                    try? await Task.sleep(for: .seconds(1.3))
                    withAnimation(ReloMotion.smooth) { self.helloBeat = 3 }
                }
            }
        }
    }

    /// "Welcome to Relo", once, under 3 s; the caption shows it either way. Quiet while the microphone is in use or
    /// the screen is shared. Relo's own voice may not be here yet on a first launch: the system voice says it then.
    private func welcome() {
        caption = "Welcome to Relo"
        guard !Microphone.inUse, !ReloMoments.quiet else { return }
        ReloNotch.voice.speak(id: "onboarding|welcome", text: "Welcome to Relo")
    }

    func begin() {
        ReloCuePlayer.shared.play(.turn)
        ReloOnboardingNotch.start(total: stepsTotal)
        go(to: .sound)
        Task {
            try? await Task.sleep(for: .seconds(4.5))
            if screen == .sound { ReloOnboardingNotch.yourTurn() }
        }
    }

    // MARK: Moving on

    /// Continue: the button's light travels up to the notch, and the step lands there.
    func advance() {
        guard let index = screens.firstIndex(of: screen), index + 1 < screens.count else { return }
        let next = screens[index + 1]
        ReloOnboardingNotch.working()
        ReloOnboardingSpark.shared.fly(from: windowPoint(x: 280, y: 620), to: ReloOnboardingSpark.notchPoint, color: ReloNotchTheme.running,
                                       rising: true) {
            ReloOnboardingNotch.stepDone()
        }
        go(to: next)
        if next == .setup {
            setup.run(agents: agents.map(\.id).filter(selected.contains), level: level, approvals: approvals && level == .guide)
        } else if next == .ready {
            ReloOnboardingNotch.done()
        } else {
            Task {
                try? await Task.sleep(for: .seconds(1.9))
                if screen == next { ReloOnboardingNotch.yourTurn() }
            }
        }
    }

    func back() {
        guard canGoBack, let index = screens.firstIndex(of: screen), index > 1 else { return }
        // A sign-in in progress is given up with the screen.
        if screen == .server { ReloNotch.store.cancelSignIn() }
        ReloCuePlayer.shared.play(.turn)
        go(to: screens[index - 1])
        ReloOnboardingNotch.set(stepsDone: doneSteps)
    }

    /// From a local setup that failed: back to choosing where Relo runs.
    func backToPlace() {
        guard !setup.running, screens.contains(.where) else { return }
        ReloCuePlayer.shared.play(.turn)
        go(to: .where)
        ReloOnboardingNotch.set(stepsDone: doneSteps)
    }

    /// "Later" on the server sign-in: Relo runs on this Mac after all.
    func useThisMac() {
        ReloNotch.store.cancelSignIn()
        place = .mac
        go(to: .agents)
        ReloOnboardingNotch.set(stepsDone: doneSteps)
    }

    /// Steps done for the screen shown: the choices before it.
    private var doneSteps: Int { max(0, (screens.firstIndex(of: screen) ?? 1) - 1) }

    private func go(to next: Screen) {
        withAnimation(ReloMotion.smooth) { screen = next }
        ReloOnboardingProgress.screen = next
        caption = ""
    }

    // MARK: Setup

    /// The setup's items changed: the notch follows (failed, waiting on approval, running), and Ready comes when done.
    func setupChanged() {
        if let failed = setup.failedItem, case .failed(let words) = failed.state {
            ReloOnboardingNotch.failed(setup.needsApproval ? "Turn on Relo in System Settings" : words)
            if setup.needsApproval { ReloOnboardingNotch.yourTurn() }
        } else if setup.isDone, screen == .setup {
            ReloOnboardingNotch.stepDone()
            ReloOnboardingNotch.done(title: readyLine)
            Task {
                try? await Task.sleep(for: .seconds(1.8))
                go(to: .ready)
                try? await Task.sleep(for: .seconds(0.4))
                if ReloVoiceMode.current.speaks, !Microphone.inUse, !ReloMoments.quiet {
                    ReloNotch.voice.speak(id: "onboarding|ready", text: readyLine)
                }
            }
        } else if setup.running {
            ReloOnboardingNotch.working()
        }
    }

    /// What Ready says, in the notch, on the screen and aloud: the agents now reporting, by name.
    var readyLine: String {
        let names = setup.items.filter { $0.isAgent && $0.state == .done }.map(\.name)
        guard let last = names.last else { return "Relo is ready" }
        let list = names.count == 1 ? last : names.dropLast().joined(separator: ", ") + " and " + last
        return "Ready to use with \(list)"
    }

    // MARK: Start

    /// Start: the window shrinks toward the notch while the orb flies up into it and becomes the pilot light.
    func finish(window: NSWindow?) {
        guard !closing else { return }
        closing = true
        ReloCuePlayer.shared.play(.close)
        ReloOnboardingProgress.reset()
        BoringViewCoordinator.shared.firstLaunch = false
        ReloOnboardingSpark.shared.fly(from: windowPoint(x: 280, y: 170), to: ReloOnboardingSpark.notchPoint, color: ReloNotchTheme.sky,
                                       duration: 0.55, rising: true, orb: true) {
            ReloOnboardingNotch.clear()
        }
        if let window {
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0.2 : 0.45
                context.timingFunction = CAMediaTimingFunction(controlPoints: 0.4, 0, 0.2, 1)
                window.animator().alphaValue = 0
                if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                    let notch = ReloOnboardingSpark.notchPoint
                    window.animator().setFrame(NSRect(x: notch.x - 28, y: notch.y - 34, width: 56, height: 68), display: true)
                }
            }, completionHandler: { [weak self] in self?.onFinish() })
        } else {
            onFinish()
        }
    }

    /// The window closed part way: the staged work stays as Your turn until Relo opens it again; quitting during the
    /// setup rolls it back so nothing is left half installed.
    func windowClosed() {
        guard !closing else { return }
        if screen == .setup, !setup.isDone { setup.abandon(); ReloOnboardingProgress.screen = .agents }
        ReloOnboardingNotch.clear()
        // The server path ended with no sign-in and Relo never ran on this Mac: it starts quietly, so the app is usable.
        if place == .server, !isPreview { ReloPendingApproval.shared.onboardingEndedWithoutSignIn() }
    }

    // MARK: Geometry

    /// A point in the window's content (top-left origin, points) in screen coordinates.
    func windowPoint(x: CGFloat, y: CGFloat) -> CGPoint {
        guard let window = NSApp.windows.first(where: { $0.identifier?.rawValue == OnboardingWindow.identifier }) else { return .zero }
        return CGPoint(x: window.frame.minX + x, y: window.frame.maxY - y)
    }

    func setCaption(_ text: String) { caption = text }
}

/// The onboarding window, for the rest of the app: whether it is open, and a way to bring it forward.
@MainActor
enum OnboardingWindow {
    static let identifier = "OnboardingWindow"

    private static var window: NSWindow? { NSApp.windows.first { $0.identifier?.rawValue == identifier } }

    static var isOpen: Bool { window?.isVisible == true }

    @discardableResult
    static func bringForward() -> Bool {
        guard let window, window.isVisible else { return false }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        return true
    }
}

struct OnboardingView: View {
    @State var step: OnboardingStep = .welcome
    let onFinish: () -> Void
    let onOpenSettings: () -> Void
    @State private var flow: ReloOnboardingFlow

    init(step: OnboardingStep = .welcome, startAt: ReloOnboardingProgress.Screen? = nil,
         onFinish: @escaping () -> Void, onOpenSettings: @escaping () -> Void) {
        _step = State(initialValue: step)
        self.onFinish = onFinish
        self.onOpenSettings = onOpenSettings
        _flow = State(initialValue: ReloOnboardingFlow(startAt: startAt))
    }

    var body: some View {
        ZStack {
            ReloAurora()
            if step == .musicPermission {
                MusicControllerSelectionView(onContinue: {
                    BoringViewCoordinator.shared.firstLaunch = false
                    onFinish()
                })
                .transition(.opacity)
            } else {
                ReloOnboardingScreens(flow: flow)
            }
        }
        .frame(width: 560, height: 680)
        .preferredColorScheme(.dark)
        .onAppear {
            flow.onFinish = onFinish
            if step == .welcome { flow.appear() }
        }
        .onDisappear { flow.windowClosed() }
    }
}
