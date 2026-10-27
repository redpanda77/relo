//
//  ReloOnboardingScreens.swift
//  Relo
//
//  The onboarding's screens: few words, each choice heard or seen before it is read. Hello (the orb and the voice),
//  Sound, Where, the server sign-in, Agents, Setting up, Ready.
//

import AppKit
import Defaults
import LaunchAtLogin
import ReloNotchKit
import SwiftUI

struct ReloOnboardingScreens: View {
    let flow: ReloOnboardingFlow

    var body: some View {
        ZStack(alignment: .topLeading) {
            Group {
                switch flow.screen {
                case .hello: ReloHelloScreen(flow: flow)
                case .sound: ReloSoundScreen(flow: flow)
                case .where: ReloPlaceScreen(flow: flow)
                case .server: ReloServerScreen(flow: flow)
                case .agents: ReloAgentsScreen(flow: flow)
                case .setup: ReloSetupScreen(flow: flow)
                case .ready: ReloReadyScreen(flow: flow)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .id(flow.screen)
            .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 12)),
                                    removal: .opacity.animation(.easeOut(duration: 0.25))))
            if flow.canGoBack {
                Button(action: flow.back) {
                    Image(systemName: "chevron.left").font(.system(size: 13, weight: .semibold))
                        .frame(width: 30, height: 30).contentShape(Circle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white.opacity(0.6))
                .keyboardShortcut(.cancelAction)
                .accessibilityLabel("Back")
                .padding(.leading, 16).padding(.top, 40)
            }
        }
    }
}

/// The primary action at the foot of a screen.
/// The second choice beside a screen's main button: Relo on this Mac, as a real button with its icon.
private struct ReloTryHereButton: View {
    var title = "Try it on this Mac"
    let action: () -> Void

    var body: some View {
        Button(action: action) { Label(title, systemImage: "laptopcomputer") }
            .buttonStyle(ReloSecondaryButtonStyle())
            .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
    }
}

private struct ReloOnboardingFoot<Label: View>: View {
    let action: () -> Void
    var enabled = true
    @ViewBuilder let label: () -> Label

    var body: some View {
        Button(action: action, label: label)
            .buttonStyle(ReloPrimaryButtonStyle())
            .keyboardShortcut(.defaultAction)
            .disabled(!enabled)
            .opacity(enabled ? 1 : 0.4)
            .padding(.bottom, 40)
    }
}

/// The line that says what was just heard (muted Macs, offices) or what a choice means.
private struct ReloCaption: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 13))
            .foregroundStyle(.white.opacity(0.62))
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(minHeight: 18)
            .padding(.horizontal, 40)
            .contentTransition(.opacity)
            .animation(ReloMotion.base, value: text)
    }
}

/// A large choice: glass at rest, violet and lit when chosen; it presses in like the app's buttons.
private struct ReloChoiceTileStyle: ButtonStyle {
    let on: Bool
    var width: CGFloat = 124

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(.white)
            .frame(width: width)
            .padding(.vertical, 20)
            .background {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(on ? AnyShapeStyle(LinearGradient(colors: [ReloNotchTheme.running.opacity(0.32), ReloNotchTheme.running.opacity(0.12)],
                                                             startPoint: .top, endPoint: .bottom))
                         : AnyShapeStyle(Color.white.opacity(0.06)))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(on ? ReloNotchTheme.runningSoft.opacity(0.55) : .white.opacity(0.12), lineWidth: 0.5)
            }
            .shadow(color: ReloNotchTheme.running.opacity(on ? 0.28 : 0), radius: 15, y: 10)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(ReloMotion.press, value: configuration.isPressed)
            .animation(ReloMotion.snappy, value: on)
            .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

// MARK: Hello

private struct ReloHelloScreen: View {
    let flow: ReloOnboardingFlow
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                if flow.helloBeat >= 1 {
                    ReloOrb(mood: .clear)
                        .frame(width: 150, height: 150)
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.03).combined(with: .opacity))
                }
            }
            .frame(width: 150, height: 150)
            .padding(.top, 190)
            if flow.helloBeat >= 2 {
                ReloWordmark(size: 52).padding(.top, 40).transition(.opacity.combined(with: .offset(y: 12)))
                ReloCaption(text: flow.caption).padding(.top, 14)
            }
            Spacer()
            if flow.helloBeat >= 3 {
                ReloOnboardingFoot(action: flow.begin) { Text("Begin") }
                    .transition(.opacity.combined(with: .offset(y: 12)))
            }
        }
    }
}

// MARK: Sound

private struct ReloSoundScreen: View {
    let flow: ReloOnboardingFlow
    @Default(.reloSounds) private var sounds
    @Default(.reloVoiceMode) private var voiceMode
    @Default(.reloVoiceDetail) private var detail
    @State private var touch = 0

    private enum Mode: String, CaseIterable { case silent, sounds, voice }
    private var mode: Mode { !sounds ? .silent : ReloVoiceMode(rawValue: voiceMode)?.speaks == true ? .voice : .sounds }

    private static let samples = ["brief": "Done: Login crash.", "full": "Done: Login crash. Fixed and tested.",
                                  "verbose": "Login crash. Three of five done, now the tests."]

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                ReloOrb(mood: .clear).frame(width: 92, height: 92)
                ReloTouchRipple(trigger: touch).frame(width: 92, height: 92)
            }
            .padding(.top, 92)
            HStack(spacing: 14) {
                tile(.silent, "Silent") { Image(systemName: "speaker.slash").font(.system(size: 22, weight: .regular)) }
                tile(.sounds, "Sounds") { Image(systemName: "speaker.wave.2").font(.system(size: 22, weight: .regular)) }
                tile(.voice, "Voice") { voiceGlyph }
            }
            .padding(.top, 38)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("When something happens")
            if mode == .voice {
                Picker("How much it says", selection: Binding(get: { detail }, set: pickDetail)) {
                    Text("Brief").tag("brief")
                    Text("Full").tag("full")
                    Text("Every step").tag("verbose")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 260)
                .padding(.top, 22)
                .transition(.opacity.combined(with: .offset(y: 8)))
            }
            ReloCaption(text: flow.caption).padding(.top, 16)
            Spacer()
            ReloOnboardingFoot(action: flow.advance) { Text("Continue") }
        }
        .animation(ReloMotion.smooth, value: mode)
        .onAppear {
            // The onboarding's default is Voice at Full; the owner hears it before choosing.
            if !flow.isPreview, ReloOnboardingProgress.screen == .sound, voiceMode == ReloVoiceMode.soundOnly.rawValue, sounds {
                voiceMode = ReloVoiceMode.soundThenVoice.rawValue
                detail = "full"
            }
        }
    }

    private var voiceGlyph: some View {
        ZStack {
            ReloVoiceWave(speaking: ReloNotch.voice.isActive("onboarding|sample") || ReloNotch.voice.isActive("onboarding|welcome"))
            if let progress = flow.setup.voiceProgress {
                Circle().stroke(.white.opacity(0.1), lineWidth: 2).frame(width: 50, height: 50)
                Circle().trim(from: 0, to: progress).stroke(ReloNotchTheme.runningSoft, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90)).frame(width: 50, height: 50)
                    .animation(ReloMotion.base, value: progress)
            }
        }
    }

    private func tile(_ choice: Mode, _ label: String, @ViewBuilder glyph: () -> some View) -> some View {
        Button { pick(choice) } label: {
            VStack(spacing: 12) {
                glyph().frame(width: 44, height: 44)
                Text(label).font(.system(size: 13, weight: .semibold))
            }
        }
        .buttonStyle(ReloChoiceTileStyle(on: mode == choice))
        .accessibilityAddTraits(mode == choice ? [.isSelected] : [])
    }

    /// Each choice plays itself: Sounds plays the done sound and the orb ripples; Voice speaks a line at the detail.
    private func pick(_ choice: Mode) {
        switch choice {
        case .silent:
            sounds = false
            ReloNotch.voice.stop()
            flow.setCaption("No sound")
        case .sounds:
            sounds = true; voiceMode = ReloVoiceMode.soundOnly.rawValue
            touch += 1
            ReloCuePlayer.shared.play(.done)
            flow.setCaption("A sound for each moment")
        case .voice:
            sounds = true; voiceMode = ReloVoiceMode.soundThenVoice.rawValue
            touch += 1
            ReloCuePlayer.shared.play(.done)
            speak(after: 0.45)
        }
    }

    private func pickDetail(_ value: String) {
        detail = value
        speak(after: 0)
    }

    private func speak(after delay: Double) {
        let line = Self.samples[detail] ?? Self.samples["full"]!
        flow.setCaption(line)
        Task {
            try? await Task.sleep(for: .seconds(delay))
            ReloNotch.voice.speak(id: "onboarding|sample", text: line)
        }
    }
}

/// The orb's own touch: one ring of light spreading over two seconds.
private struct ReloTouchRipple: View {
    let trigger: Int
    @State private var spread = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Circle()
            .stroke(ReloNotchTheme.ice.opacity(spread ? 0 : 0.6), lineWidth: 2)
            .scaleEffect(spread ? 1.6 : 0.4)
            .opacity(trigger == 0 || reduceMotion ? 0 : 1)
            .onChange(of: trigger) {
                spread = false
                withAnimation(.timingCurve(0.2, 0.7, 0.3, 1, duration: 2)) { spread = true }
            }
            .allowsHitTesting(false)
    }
}

/// Five bars that move only while the voice speaks.
private struct ReloVoiceWave: View {
    let speaking: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !speaking || reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 3) {
                ForEach(0..<5, id: \.self) { i in
                    Capsule().fill(ReloNotchTheme.runningSoft)
                        .frame(width: 3, height: speaking && !reduceMotion ? 5 + 15 * abs(sin(t * 3.5 + Double(i) * 0.8)) : 6)
                }
            }
            .frame(height: 22)
        }
        .accessibilityHidden(true)
    }
}

// MARK: Where

private struct ReloPlaceScreen: View {
    let flow: ReloOnboardingFlow

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 16) {
                tile(.mac, "This Mac", detail: "Try it now, no account", server: false)
                tile(.server, "My server", detail: "Needs a Relo account", server: true)
            }
            .padding(.top, 150)
            ReloCaption(text: flow.place == .mac ? "Nothing leaves this Mac" : "Your server reaches your iPhone, encrypted")
                .padding(.top, 22)
            Spacer()
            ReloOnboardingFoot(action: proceed) { Text("Continue") }
                .disabled(flow.place == .mac && problem != nil)
        }
    }

    private var problem: String? { ReloOnboardingFlow.localProblem }

    private func tile(_ place: ReloOnboardingFlow.Place, _ label: String, detail: String, server: Bool) -> some View {
        Button { flow.place = place } label: {
            VStack(spacing: 12) {
                HStack(spacing: 8) {
                    Image(systemName: "laptopcomputer").font(.system(size: 40, weight: .light))
                    if server {
                        ReloDottedLink().frame(width: 24, height: 4)
                        Image(systemName: "iphone").font(.system(size: 30, weight: .light))
                    }
                }
                .frame(height: 60)
                VStack(spacing: 3) {
                    Text(label).font(.system(size: 14, weight: .semibold))
                    Text(!server && problem != nil ? problem! : detail)
                        .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.6))
                        .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .disabled(!server && problem != nil)
        .buttonStyle(ReloChoiceTileStyle(on: flow.place == place, width: 196))
        .accessibilityAddTraits(flow.place == place ? [.isSelected] : [])
    }

    /// A Mac already signed in to a server of the owner's asks first: running Relo here moves its agents here.
    private func proceed() {
        if flow.place == .mac, let host = ReloLocalMode.remoteLoginHost() {
            ReloLocalMode.confirmRunHere(replacing: host) { flow.advance() }
        } else {
            flow.advance()
        }
    }
}

/// The dashes between the Mac and the iPhone, moving toward the phone.
private struct ReloDottedLink: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
            let phase = reduceMotion ? 0 : -context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.9) / 0.9 * 7
            Path { $0.move(to: CGPoint(x: 0, y: 2)); $0.addLine(to: CGPoint(x: 24, y: 2)) }
                .stroke(ReloNotchTheme.runningSoft, style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [3, 4], dashPhase: phase))
        }
    }
}

// MARK: Server

private struct ReloServerScreen: View {
    let flow: ReloOnboardingFlow
    private let store = ReloNotch.store
    @State private var address = ReloServerAddress()

    private var signedIn: Bool { [.connecting, .live, .offline].contains(store.connection) }
    private var signingIn: Bool { store.connection == .signingIn }
    /// The account was created and waits for the server's owner: Relo works on this Mac meanwhile, and nothing blocks.
    private var waiting: Bool { store.pendingApproval != nil && !signedIn }

    var body: some View {
        VStack(spacing: 18) {
            ZStack {
                ReloOrb(mood: signedIn ? .clear : store.connection == .signingIn ? .running : .clear)
                    .frame(width: 72, height: 72)
                if signedIn {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 24, weight: .semibold))
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.black, ReloNotchTheme.done)
                        .offset(x: 26, y: 26)
                        .transition(.scale(scale: 0.4).combined(with: .opacity))
                }
            }
            .padding(.top, 130)
            .animation(ReloMotion.bouncy, value: signedIn)
            if !signedIn && !signingIn && !waiting { ReloServerChoice(address: address) }
            ReloCaption(text: line)
            if let problem = store.problem, !signedIn {
                Text(problem).font(.caption).foregroundStyle(ReloNotchTheme.warning).multilineTextAlignment(.center).frame(maxWidth: 380)
            }
            Spacer()
            if !signedIn, !waiting, ReloOnboardingFlow.localWorks {
                // The way out of a sign-in that fails, hangs or is not wanted after all: Relo on this Mac, said plainly.
                ReloCaption(text: "No account yet, or can't sign in? Try it on this Mac and sign in later.").padding(.bottom, 14)
            }
            HStack(spacing: 12) {
                if waiting {
                    Button(PendingApproval.cancelRequest) { store.cancelPendingApproval() }.buttonStyle(ReloGlassButtonStyle())
                    Button("Continue", action: flow.advance).buttonStyle(ReloPrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                } else if !signedIn {
                    if ReloOnboardingFlow.localWorks {
                        ReloTryHereButton(action: flow.useThisMac)
                    }
                    if signingIn {
                        Button("Cancel") { store.cancelSignIn() }.buttonStyle(ReloGlassButtonStyle())
                    }
                    Button(signingIn ? "Signing in…" : "Sign in") { address.signIn() }
                        .buttonStyle(ReloPrimaryButtonStyle())
                        .keyboardShortcut(.defaultAction)
                        .disabled(signingIn || (address.isEmpty && !store.originChosen))
                } else {
                    Button("Continue", action: flow.advance).buttonStyle(ReloPrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                }
            }
            .padding(.bottom, 40)
        }
    }

    private var line: String {
        if signedIn { return "Connected" }
        if let pending = store.pendingApproval {
            return PendingApproval.waitingLine(host: pending.host, localWorks: ReloOnboardingFlow.localWorks)
        }
        if store.connection == .signingIn { return "Finish in your browser, then approve this Mac on your iPhone" }
        return ""
    }
}

// MARK: Agents

private struct ReloAgentsScreen: View {
    let flow: ReloOnboardingFlow

    var body: some View {
        VStack(spacing: 0) {
            if flow.agents.isEmpty {
                Spacer()
                ReloOrb(mood: .clear).frame(width: 60, height: 60)
                ReloCaption(text: "No agents found on this Mac. You can add them later in Settings \u{25B8} Agents.").padding(.top, 18)
                Spacer()
                ReloOnboardingFoot(action: flow.advance) { Text("Continue") }
            } else {
                ZStack {
                    Circle().strokeBorder(.white.opacity(0.09), lineWidth: 1).frame(width: 190, height: 190)
                    ReloOrb(mood: .clear).frame(width: 52, height: 52)
                    ForEach(Array(flow.agents.enumerated()), id: \.element.id) { index, agent in
                        ReloAgentMark(agent: agent, on: flow.selected.contains(agent.id), index: index) {
                            if flow.selected.contains(agent.id) { flow.selected.remove(agent.id) } else { flow.selected.insert(agent.id) }
                            ReloCuePlayer.shared.play(flow.selected.contains(agent.id) ? .on : .off)
                        }
                        .offset(ReloOrbit.offset(index, of: flow.agents.count, radius: 95))
                    }
                }
                .frame(width: 300, height: 260)
                .padding(.top, 44)
                ReloCaption(text: "Found on this Mac").padding(.top, 6)
                if !flow.selected.isEmpty { ReloSetupChoice(flow: flow).padding(.top, 14).transition(.opacity) }
                Spacer(minLength: 8)
                ReloOnboardingFoot(action: flow.advance) { Text(flow.selected.isEmpty ? "Continue without agents" : "Set up") }
            }
        }
        .animation(ReloMotion.base, value: flow.selected.isEmpty)
    }
}

/// How much Relo adds to the chosen agents: three levels, and permission prompts from the iPhone with session tracking.
private struct ReloSetupChoice: View {
    @Bindable var flow: ReloOnboardingFlow

    var body: some View {
        VStack(spacing: 6) {
            Text("How much should Relo add?").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.white.opacity(0.85))
            ForEach(ReloOnboardingSetup.Level.allCases.reversed(), id: \.self) { level in
                let on = flow.level == level
                Button { flow.level = level } label: {
                    HStack(spacing: 10) {
                        Image(systemName: on ? "largecircle.fill.circle" : "circle")
                            .font(.system(size: 13)).foregroundStyle(on ? ReloNotchTheme.running : .white.opacity(0.4))
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 6) {
                                Text(level.title).font(.system(size: 12.5, weight: .medium)).foregroundStyle(.white)
                                if level == .guide {
                                    Text("Recommended").font(.system(size: 10, weight: .medium)).foregroundStyle(ReloNotchTheme.running)
                                }
                            }
                            Text(level.detail).font(.system(size: 11)).foregroundStyle(.white.opacity(0.55))
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(RoundedRectangle(cornerRadius: 9).fill(.white.opacity(on ? 0.09 : 0.04)))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
            Toggle("Answer permission prompts from your iPhone", isOn: $flow.approvals)
                .toggleStyle(.switch).controlSize(.mini)
                .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.7))
                .disabled(flow.level != .guide)
                .opacity(flow.level == .guide ? 1 : 0.4)
                .padding(.top, 2)
        }
        .frame(width: 380)
    }
}

enum ReloOrbit {
    /// A place on the orbit track, the first at the top, clockwise.
    static func offset(_ index: Int, of count: Int, radius: CGFloat) -> CGSize {
        let angle = -Double.pi / 2 + Double(index) * 2 * Double.pi / Double(max(count, 1))
        return CGSize(width: radius * cos(angle), height: radius * sin(angle))
    }
}

/// An agent on the orbit: its own mark in glass, a switch; lit when it will report, faded when not.
private struct ReloAgentMark: View {
    let agent: LocalServer.Agent
    let on: Bool
    let index: Int
    let toggle: () -> Void
    @State private var arrived = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: toggle) {
            ReloSourceMark(name: agent.name, size: 22)
                .frame(width: 52, height: 52)
                .background(Circle().fill(.white.opacity(0.07)))
                .overlay(Circle().strokeBorder(.white.opacity(on ? 0.22 : 0.1), lineWidth: 0.5))
                .shadow(color: ReloNotchTheme.running.opacity(on ? 0.35 : 0), radius: 9)
                .saturation(on ? 1 : 0)
                .opacity(on ? 1 : 0.35)
                .overlay(alignment: .bottom) {
                    Text(agent.name).font(.system(size: 11.5, weight: .medium)).foregroundStyle(.white.opacity(0.7))
                        .fixedSize().offset(y: 22)
                }
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(agent.name)
        .accessibilityValue(on ? "On" : "Off")
        .accessibilityAddTraits(.isToggle)
        .scaleEffect(arrived || reduceMotion ? 1 : 0.4)
        .opacity(arrived || reduceMotion ? 1 : 0)
        .animation(ReloMotion.snappy, value: on)
        .onAppear {
            withAnimation(ReloMotion.snappy.delay(0.25 + Double(index) * 0.04)) { arrived = true }
        }
    }
}

// MARK: Setting up

private struct ReloSetupScreen: View {
    let flow: ReloOnboardingFlow
    private var setup: ReloOnboardingSetup { flow.setup }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Circle().strokeBorder(.white.opacity(0.09), lineWidth: 1).frame(width: 220, height: 220)
                ReloOrb(mood: setup.failedItem != nil ? .needsYou : .running).frame(width: 110, height: 110)
                ForEach(Array(setup.items.enumerated()), id: \.element.id) { index, item in
                    if shows(item) {
                        ReloSetupMark(item: item)
                            .offset(ReloOrbit.offset(index, of: setup.items.count, radius: 110))
                            .transition(.asymmetric(insertion: .scale(scale: 0.2).combined(with: .opacity).combined(with: .offset(.zero)),
                                                    removal: .opacity))
                    }
                }
            }
            .frame(width: 300, height: 300)
            .padding(.top, 110)
            .animation(ReloMotion.snappy, value: setup.items)
            ReloCaption(text: line).padding(.top, 26)
            if setup.needsApproval {
                Button("Open Login Items", action: setup.openLoginItems)
                    .buttonStyle(ReloPrimaryButtonStyle()).keyboardShortcut(.defaultAction).padding(.top, 18)
            } else if let failed = setup.failedItem {
                HStack(spacing: 12) {
                    if !failed.isAgent, ReloOnboardingFlow.localProblem != nil {
                        Button("Show in Finder", action: ReloLocalMode.showAppInFinder).buttonStyle(ReloGlassButtonStyle())
                    }
                    if flow.screens.contains(.where) { Button("Back", action: flow.backToPlace).buttonStyle(ReloGlassButtonStyle()) }
                    if failed.isAgent { Button("Skip", action: setup.skip).buttonStyle(ReloGlassButtonStyle()) }
                    Button("Try again", action: setup.retry).buttonStyle(ReloPrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                }
                .padding(.top, 18)
                .transition(.opacity.combined(with: .offset(y: 8)))
            }
            Spacer()
        }
        .onChange(of: setup.items) { flow.setupChanged() }
        .onChange(of: setup.needsApproval) { flow.setupChanged() }
    }

    private func shows(_ item: ReloOnboardingSetup.Item) -> Bool {
        switch item.state {
        case .done, .failed: true
        default: false
        }
    }

    private var line: String {
        if setup.needsApproval { return "In System Settings, turn on Relo under Allow in the Background. Relo continues by itself." }
        if let failed = setup.failedItem, case .failed(let words) = failed.state { return words }
        if setup.isDone { return "Done" }
        if let current = setup.items.first(where: { $0.state == .running }) {
            return current.isAgent ? "\(current.name): \(setup.level.steps.joined(separator: ", "))" : "Setting up Relo"
        }
        return ""
    }
}

/// A piece set up, flown out of the orb into its place on the orbit; red with a decaying shake when it failed.
private struct ReloSetupMark: View {
    let item: ReloOnboardingSetup.Item
    @State private var shake = 0.0

    private var failed: Bool { if case .failed = item.state { true } else { false } }

    var body: some View {
        Group {
            if item.isAgent { ReloSourceMark(name: item.name, size: 22) } else { ReloOrb(mood: .clear).frame(width: 22, height: 22) }
        }
        .frame(width: 52, height: 52)
        .background(Circle().fill(.white.opacity(0.07)))
        .overlay(Circle().strokeBorder(failed ? ReloNotchTheme.problem.opacity(0.8) : .white.opacity(0.22), lineWidth: failed ? 1 : 0.5))
        .shadow(color: failed ? ReloNotchTheme.problem.opacity(0.5) : ReloNotchTheme.running.opacity(0.35), radius: 10)
        .modifier(ReloDecayingShake(progress: shake))
        .onChange(of: failed) { _, now in
            guard now else { return }
            shake = 0
            withAnimation(.linear(duration: 0.6)) { shake = 1 }
        }
        .accessibilityLabel(item.isAgent ? item.name : "Relo")
    }
}

/// sin(42t)·3.2·e^(-5.5t), the notch's own failure shake.
private struct ReloDecayingShake: GeometryEffect {
    var progress: Double
    var animatableData: Double { get { progress } set { progress = newValue } }

    func effectValue(size: CGSize) -> ProjectionTransform {
        let t = progress * 0.6
        let x = progress >= 1 ? 0 : sin(42 * t) * 3.2 * exp(-5.5 * t)
        return ProjectionTransform(CGAffineTransform(translationX: x, y: 0))
    }
}

// MARK: Ready

private struct ReloReadyScreen: View {
    let flow: ReloOnboardingFlow
    @ObservedObject private var updater = ReloUpdater.shared
    @State private var openAtLogin = LaunchAtLogin.isEnabled
    @State private var shown = false

    var body: some View {
        VStack(spacing: 0) {
            ReloOrb(mood: .clear).frame(width: 120, height: 120).padding(.top, 110).reloEntrance(0, shown)
            Text("Ready")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .padding(.top, 26)
                .reloEntrance(1, shown)
            ReloCaption(text: flow.place == .mac ? flow.readyLine
                        : ReloNotch.store.pendingApproval.map { PendingApproval.waitingLine(host: $0.host, localWorks: ReloOnboardingFlow.localWorks) }
                        ?? "Connected to your server").padding(.top, 10).reloEntrance(1, shown)
            if flow.place == .mac, !flow.setup.ownerSteps.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("One more step").font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.9))
                    ForEach(flow.setup.ownerSteps, id: \.self) { step in
                        Text(step).font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.7)).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(width: 360, alignment: .leading)
                .padding(.horizontal, 18).padding(.vertical, 12)
                .reloGlass()
                .padding(.top, 18)
                .reloEntrance(1, shown)
            }
            VStack(spacing: 0) {
                Toggle("Install updates automatically", isOn: Binding(get: { updater.installsAutomatically },
                                                                      set: { updater.installsAutomatically = $0 }))
                    .padding(.horizontal, 18).padding(.vertical, 13)
                Divider().overlay(.white.opacity(0.08)).padding(.horizontal, 18)
                Toggle("Open Relo when this Mac starts", isOn: $openAtLogin)
                    .padding(.horizontal, 18).padding(.vertical, 13)
            }
            .toggleStyle(ReloGlassToggleStyle())
            .font(.system(size: 13.5))
            .foregroundStyle(.white)
            .frame(width: 360)
            .reloGlass()
            .padding(.top, 36)
            .reloEntrance(2, shown)
            // Signed in to a server, setup asked nothing about agents: the way to them, in plain words.
            if flow.place == .server, ReloOnboardingFlow.localWorks {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Your agents").font(.system(size: 13.5)).foregroundStyle(.white)
                        Text("Choose which agents on this Mac report to Relo").font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55))
                    }
                    Spacer(minLength: 8)
                    Button("Set up agents") { SettingsWindowController.shared.showWindow(page: "Agents") }
                        .buttonStyle(ReloGlassButtonStyle())
                }
                .padding(.horizontal, 18).padding(.vertical, 12)
                .frame(width: 360)
                .reloGlass()
                .padding(.top, 12)
                .reloEntrance(2, shown)
            }
            Spacer()
            HStack(spacing: 18) {
                // Signed in to a server and changed their mind: Relo on this Mac, after naming the login it replaces.
                if flow.place == .server, ReloOnboardingFlow.localWorks {
                    ReloTryHereButton(title: "Use this Mac instead") {
                        ReloLocalMode.confirmRunHere(replacing: ReloLocalMode.remoteLoginHost()) { flow.useThisMac() }
                    }
                }
                Button("Start") { flow.finish(window: NSApp.windows.first { $0.identifier?.rawValue == "OnboardingWindow" }) }
                    .buttonStyle(ReloPrimaryButtonStyle())
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.bottom, 40)
            .reloEntrance(3, shown)
        }
        .onAppear {
            shown = true
            // Open at login is on unless the owner turns it off here: Relo is a notch app that should be there.
            if !flow.isPreview, !LaunchAtLogin.isEnabled { LaunchAtLogin.isEnabled = true; openAtLogin = true }
        }
        .onChange(of: openAtLogin) { _, on in if !flow.isPreview { LaunchAtLogin.isEnabled = on } }
    }
}
