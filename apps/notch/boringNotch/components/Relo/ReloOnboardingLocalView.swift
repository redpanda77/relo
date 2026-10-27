//
//  ReloOnboardingLocalView.swift
//  Relo Notch
//
//  "Run Relo on this Mac" from Settings: the local setup's live steps (plan 16).
//

import AppKit
import ReloNotchKit
import SwiftUI

/// "Run Relo on this Mac": its steps with live state, the agents to tick, and what to do when one fails.
struct ReloOnboardingLocalView: View {
    let onContinue: () -> Void
    let onBack: () -> Void
    @State private var setup: ReloLocalSetup

    @MainActor init(setup: ReloLocalSetup? = nil, onContinue: @escaping () -> Void, onBack: @escaping () -> Void) {
        _setup = State(initialValue: setup ?? ReloLocalSetup())
        self.onContinue = onContinue
        self.onBack = onBack
    }

    var body: some View {
        VStack(spacing: 18) {
            Spacer(minLength: 30)
            ReloOrb(mood: setup.step == .done ? .running : .clear).frame(width: 90, height: 90)
            Text(setup.step == .done ? "Relo is running on this Mac" : "Setting up Relo on this Mac")
                .font(.system(size: 26, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            VStack(alignment: .leading, spacing: 12) {
                ForEach(ReloLocalSetup.Step.allCases, id: \.self) { step in row(step) }
            }
            .frame(maxWidth: 380, alignment: .leading)
            if setup.step == .done {
                VStack(spacing: 6) {
                    Text("Relo runs on this Mac. Nothing leaves it.")
                    if let host = setup.replacedHost {
                        Text("Your agents report here now, not to \(host). You can switch back anytime in Settings.")
                    }
                    if let note = setup.launcherNote { Text(note) }
                }
                .font(.system(size: 14)).foregroundStyle(.white.opacity(0.68))
                .multilineTextAlignment(.center)
            }
            if let failure = setup.failure {
                VStack(spacing: 8) {
                    Text(failure).font(.system(size: 12.5)).foregroundStyle(ReloNotchTheme.warning)
                    Button("Show details") { ReloLocalMode.showDetails() }
                        .buttonStyle(.plain).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.6))
                }
                .multilineTextAlignment(.center)
                .frame(maxWidth: 400)
            }
            Spacer(minLength: 16)
            buttons
            Spacer(minLength: 8)
        }
        .padding(.horizontal, 40)
        .animation(ReloMotion.base, value: setup.step)
        .onAppear { setup.begin() }
        .task { await setup.watchApproval() }
    }

    @ViewBuilder private var buttons: some View {
        HStack(spacing: 12) {
            if setup.failure != nil {
                Button("Back") { setup.abandon(); onBack() }.buttonStyle(ReloSecondaryButtonStyle())
                if setup.needsApproval {
                    Button("Open Login Items") { setup.openLoginItems() }.buttonStyle(ReloSecondaryButtonStyle())
                    Text("Switch Relo on there; setup then continues by itself.")
                        .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
                }
                Button("Try again") { setup.begin() }
                    .buttonStyle(ReloPrimaryButtonStyle()).keyboardShortcut(.defaultAction)
            } else if setup.step == .done {
                Button("Continue", action: onContinue)
                    .buttonStyle(ReloPrimaryButtonStyle()).keyboardShortcut(.defaultAction)
            } else if setup.waitingForAgents {
                Button("Back") { setup.abandon(); onBack() }.buttonStyle(ReloSecondaryButtonStyle())
                Button("Skip agents for now") { setup.skipAgents() }.buttonStyle(ReloSecondaryButtonStyle())
                Button("Continue") { setup.chooseAgents() }
                    .buttonStyle(ReloPrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                    .disabled(setup.selected.isEmpty)
            } else {
                Button("Back") { setup.abandon(); onBack() }.buttonStyle(ReloSecondaryButtonStyle()).disabled(setup.running)
            }
        }
    }

    private func state(_ step: ReloLocalSetup.Step) -> RowState {
        if setup.failure != nil, setup.step == step { return .failed }
        if setup.step == .done || step.rawValue < setup.step.rawValue { return .done }
        if step == setup.step {
            return step == .agents && setup.waitingForAgents ? .waiting : .active
        }
        return .pending
    }

    private enum RowState { case pending, active, waiting, done, failed }

    private func row(_ step: ReloLocalSetup.Step) -> some View {
        let state = state(step)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                ZStack {
                    switch state {
                    case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(ReloNotchTheme.done)
                    case .failed: Image(systemName: "exclamationmark.circle.fill").foregroundStyle(ReloNotchTheme.warning)
                    case .active: ProgressView().controlSize(.small).tint(.white)
                    case .waiting: Image(systemName: "circle.dotted").foregroundStyle(.white.opacity(0.8))
                    case .pending: Image(systemName: "circle").foregroundStyle(.white.opacity(0.25))
                    }
                }
                .font(.system(size: 16))
                .frame(width: 20, height: 20)
                Text(step.title)
                    .font(.system(size: 14, weight: state == .pending ? .regular : .semibold))
                    .foregroundStyle(.white.opacity(state == .pending ? 0.45 : 0.95))
            }
            if step == .agents, setup.waitingForAgents {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(setup.agents) { agent in
                        Toggle(agent.name, isOn: Binding(
                            get: { setup.selected.contains(agent.id) },
                            set: { on in if on { setup.selected.insert(agent.id) } else { setup.selected.remove(agent.id) } }))
                            .toggleStyle(.checkbox)
                            .font(.system(size: 13)).foregroundStyle(.white.opacity(0.85))
                    }
                    Text("Relo adds a few lines to their instructions so they report to Relo on this Mac.")
                        .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
                }
                .padding(.leading, 32)
            } else if step == .agents, state == .done {
                Text(setup.noAgentsFound ? ReloLocalSetup.noAgentsText
                     : setup.skippedAgents ? "Skipped"
                     : setup.agents.filter { setup.selected.contains($0.id) }.map(\.name).joined(separator: ", "))
                    .font(.system(size: 12)).foregroundStyle(.white.opacity(0.5)).padding(.leading, 32)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// "Try it on this Mac" from Settings, the notch or the menu: the local setup in a window of its own, over the aurora.
/// One window at a time; closing it before the setup is done undoes what it started.
@MainActor
final class ReloLocalSetupWindowController: NSWindowController, NSWindowDelegate {
    static let shared = ReloLocalSetupWindowController()
    private var setup: ReloLocalSetup?

    private init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 600),
                              styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Relo on this Mac"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isRestorable = false
        window.identifier = NSUserInterfaceItemIdentifier("ReloLocalSetupWindow")
        super.init(window: window)
        window.delegate = self
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Asks first when this Mac is signed in to a server, then opens the setup. While it is open, a second ask only
    /// brings it to the front.
    func show() {
        guard let window else { return }
        if window.isVisible {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            return
        }
        ReloLocalMode.confirmRunHere(replacing: ReloLocalMode.remoteLoginHost()) { [weak self] in self?.open(window) }
    }

    private func open(_ window: NSWindow) {
        guard !window.isVisible else { return }
        let setup = ReloLocalSetup()
        self.setup = setup
        window.contentView = NSHostingView(rootView: ZStack {
            ReloAurora()
            ReloOnboardingLocalView(setup: setup, onContinue: { [weak self] in
                self?.close()
                ReloHomeWindowController.shared.show()
            }, onBack: { [weak self] in self?.close() })
        }
        .frame(width: 560, height: 600)
        .preferredColorScheme(.dark))
        window.center()
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// Closed before the setup finished (the close button, or Back): nothing stays half installed.
    func windowWillClose(_ notification: Notification) {
        setup?.abandon()
        setup = nil
    }
}
