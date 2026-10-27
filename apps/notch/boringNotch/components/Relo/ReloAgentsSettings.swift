//
//  ReloAgentsSettings.swift
//  Relo Notch
//
//  Settings' Agents page: every agent harness found on this Mac, whether it reports to Relo, and one button to set it
//  up or take Relo out of it. The relo command does the work (`relo setup --agent`, `relo uninstall --agent`); this page
//  only shows what it reads (`relo setup --show`). The notch asks once about a harness that appears later.
//

import AppKit
import Observation
import ReloNotchKit
import SwiftUI

/// The harnesses on this Mac and what is being done to them, shared by the Agents page and the notch's prompt.
@MainActor @Observable
final class ReloAgents {
    static let shared = ReloAgents()

    /// Every harness the relo command listed; the page shows the installed ones and folds the rest.
    private(set) var allHarnesses: [LocalServer.Harness]?
    var harnesses: [LocalServer.Harness]? { allHarnesses.map { $0.filter(\.installed) } }
    var notInstalled: [LocalServer.Harness] { (allHarnesses ?? []).filter { !$0.installed } }
    private(set) var commandSignIn: LocalServer.CommandSignIn?
    /// The harness being set up or removed.
    private(set) var busy: String?
    /// What the last action said, per harness: done (with any step the owner still takes) or what went wrong.
    private(set) var notes: [String: Note] = [:]

    struct Note: Equatable {
        let text: String
        let failed: Bool
    }

    private var server: LocalServer { ReloServerService.shared.server }

    #if DEBUG
    private var previewing = false
    /// Snapshots: harnesses and a sign-in without the relo command.
    func preview(_ harnesses: [LocalServer.Harness], signIn: LocalServer.CommandSignIn, notes: [String: Note] = [:]) {
        previewing = true
        allHarnesses = harnesses
        commandSignIn = signIn
        self.notes = notes
    }
    #endif

    /// Reads the harnesses again (a newly installed one shows up) and whether the relo command can report.
    func refresh() async {
        #if DEBUG
        if previewing { return }
        #endif
        guard ReloServerService.shared.isBundled else { allHarnesses = []; return }
        async let found = server.harnesses()
        async let signIn = server.commandSignIn()
        allHarnesses = await found
        commandSignIn = await signIn
        rememberSeen()
    }

    /// Connecting this Mac's relo command to the server the app is signed in to is running, and what it said.
    private(set) var connecting = false
    private(set) var connectNote: Note?

    /// Server mode, command not signed in to the app's server: writes the launcher, makes a one-time invite as this
    /// device and signs the relo command in with it. Never in local mode (it signs itself in).
    func connect() async {
        guard !connecting, let access = ReloNotch.store.deviceAccess else { return }
        connecting = true
        connectNote = nil
        defer { connecting = false }
        let name = Host.current().localizedName ?? "This Mac"
        do {
            let said = try await server.connectAgents(origin: access.origin, bearer: access.token, clientName: name)
            connectNote = Note(text: said, failed: false)
        } catch {
            connectNote = Note(text: (error as? LocalServer.Failure)?.message ?? "Relo could not connect this Mac's agents. Try again.", failed: true)
        }
        await refresh()
    }

    /// Whether Set up must wait for Connect agents: signed in to a server, relo command not signed in to it.
    var needsConnect: Bool {
        guard !ReloNotch.store.isLocal, let signIn = commandSignIn else { return false }
        return !signIn.signedIn
    }

    /// The setup sheet: which agent, whether it changes an existing setup, and how far the run has got.
    struct SetupSheet: Identifiable, Equatable {
        enum Phase: Equatable {
            case choosing
            case running
            case done(steps: [String], ownerSteps: [String])
            case failed(String)
        }
        let harness: LocalServer.Harness
        let isChange: Bool
        var phase: Phase = .choosing
        var id: String { harness.id }
    }

    var sheet: SetupSheet?

    /// Opens the sheet for a harness: Set up for a new one, Change setup for one already set up.
    func openSetup(_ harness: LocalServer.Harness) {
        guard busy == nil else { return }
        notes[harness.id] = nil
        sheet = SetupSheet(harness: harness, isChange: harness.isSetUp)
    }

    func closeSheet() {
        guard sheet?.phase != .running else { return }
        sheet = nil
    }

    /// Runs the chosen depth from the sheet, then reads the page again: the result says done only when the relo command
    /// now reports the harness set up.
    func runSetup(_ choice: LocalServer.SetupChoice, approvals: Bool) async {
        guard busy == nil, var current = sheet else { return }
        let harness = current.harness
        busy = harness.id
        defer { busy = nil }
        current.phase = .running
        sheet = current
        let approvalsFlag: Bool? = choice.needsSessionTracking ? approvals : (harness.parts?.approvals == true ? false : nil)
        let (problem, ownerSteps, steps) = await ReloLocalMode.setUpAgents([harness.id], level: choice.level, approvals: approvalsFlag)
        if let problem {
            sheet?.phase = .failed(problem)
            return
        }
        await refresh()
        if allHarnesses?.first(where: { $0.id == harness.id })?.isSetUp == true {
            sheet?.phase = .done(steps: steps, ownerSteps: ownerSteps)
        } else {
            sheet?.phase = .failed("Relo couldn't confirm the setup. Try again.")
        }
    }

    /// The notch's one-tap setup at the recommended depth (no sheet): a failure or an unconfirmed setup shows on the row.
    func setUp(_ harness: LocalServer.Harness) async {
        guard busy == nil else { return }
        busy = harness.id
        defer { busy = nil }
        let choice = LocalServer.SetupChoice.recommended(for: harness)
        let (problem, steps, _) = await ReloLocalMode.setUpAgents([harness.id], level: choice.level)
        await refresh()
        if let problem {
            notes[harness.id] = Note(text: problem, failed: true)
        } else if allHarnesses?.first(where: { $0.id == harness.id })?.isSetUp != true {
            notes[harness.id] = Note(text: "Relo couldn't confirm the setup. Try again.", failed: true)
        } else {
            notes[harness.id] = steps.isEmpty ? nil : Note(text: steps.joined(separator: " "), failed: false)
        }
    }

    /// Asks first, then takes Relo's setup out of this one harness; the others keep reporting.
    func remove(_ harness: LocalServer.Harness) async {
        guard busy == nil else { return }
        let alert = NSAlert()
        alert.messageText = "Remove Relo from \(harness.name)?"
        alert.informativeText = "\(harness.name) stops reporting to Relo. Your other agents keep reporting, and you can set it up again here anytime."
        alert.addButton(withTitle: "Remove")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        busy = harness.id
        defer { busy = nil }
        do {
            try await server.removeAgent(harness.id)
            notes[harness.id] = Note(text: "Removed. Restart \(harness.name) if it is open.", failed: false)
        } catch {
            notes[harness.id] = Note(text: (error as? LocalServer.Failure)?.message ?? "Relo could not remove its setup from \(harness.name).",
                                     failed: true)
        }
        await refresh()
    }

    // MARK: A harness that appears later

    private var lastLook: Date?

    /// The notch opened: look for agents again now and then (a look runs the relo command), never more than every
    /// ten minutes.
    func lookIfDue(now: Date = Date()) {
        guard busy == nil, ReloServerService.shared.isBundled, lastLook.map({ now.timeIntervalSince($0) > 600 }) ?? true else { return }
        lastLook = now
        Task { await refresh() }
    }

    private static let seenKey = "relo.agents.seen"

    /// A harness found since Relo last looked, not set up: the notch offers it once. None on the first look (setup
    /// already asked about everything there was).
    var newlyFound: LocalServer.Harness? {
        // An agent set up now has to be able to report: local mode always can, a server only through the relo command.
        guard ReloNotch.store.isLocal || commandSignIn?.signedIn == true else { return nil }
        #if DEBUG
        if previewing { return harnesses?.first { !$0.isSetUp && !dismissed.contains($0.id) } }
        #endif
        guard let harnesses, let seen = UserDefaults.standard.stringArray(forKey: Self.seenKey) else { return nil }
        return harnesses.first { !$0.isSetUp && !seen.contains($0.id) && !dismissed.contains($0.id) }
    }

    /// Harnesses offered and set aside in this run, until they are remembered as seen.
    private var dismissed: Set<String> = []

    /// "Not now": the harness is remembered, and the notch does not ask about it again.
    func dismiss(_ harness: LocalServer.Harness) {
        dismissed.insert(harness.id)
        markSeen([harness.id])
    }

    private func rememberSeen() {
        guard let harnesses else { return }
        let defaults = UserDefaults.standard
        // The first look remembers everything there is; later looks remember only what is set up (a new harness
        // waits for the owner's answer in the notch).
        if defaults.stringArray(forKey: Self.seenKey) == nil { markSeen(harnesses.map(\.id)) }
        else { markSeen(harnesses.filter(\.isSetUp).map(\.id)) }
    }

    private func markSeen(_ ids: [String]) {
        let defaults = UserDefaults.standard
        let seen = Set(defaults.stringArray(forKey: Self.seenKey) ?? []).union(ids)
        defaults.set(seen.sorted(), forKey: Self.seenKey)
    }
}

/// The Agents page: each harness with its mark, whether it reports to Relo, and Set up or Remove.
struct ReloAgentsSettingsView: View {
    private let store = ReloNotch.store
    @State private var agents = ReloAgents.shared
    @State private var showNotInstalled = false

    var body: some View {
        ReloGlassPage(title: "Agents", detail: "The agents on this Mac and whether they report to Relo") {
            VStack(alignment: .leading, spacing: 22) {
                if let warning = reportingWarning { warningGroup(warning) }
                // Several copies of Relo's terminal tool: agents may run an old one (relo doctor's advice).
                if let relos = ReloLaunchHealing.shared.relosWarning {
                    ReloGlassGroup {
                        HStack(alignment: .top, spacing: 14) {
                            Image(systemName: "exclamationmark.circle").font(.system(size: 18)).foregroundStyle(ReloNotchTheme.warning)
                            ReloGlassLabel(title: "More than one copy of Relo's terminal tool", detail: relos.hint)
                        }
                        .reloGlassRow()
                    }
                }
                else if let note = agents.connectNote, !note.failed {
                    Text(note.text).font(.system(size: 12)).foregroundStyle(.white.opacity(0.6)).padding(.horizontal, 4)
                }
                ReloGlassGroup(title: "On this Mac", footer: footer) {
                    if let harnesses = agents.harnesses {
                        if harnesses.isEmpty {
                            Text(ReloServerService.shared.isBundled ? ReloLocalSetup.noAgentsText
                                 : "This build of Relo for Mac cannot set up agents. Download the latest Relo for Mac.")
                                .font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.6)).reloGlassRow()
                        } else {
                            ForEach(Array(harnesses.enumerated()), id: \.element.id) { index, harness in
                                if index > 0 { ReloGlassDivider() }
                                row(harness)
                            }
                        }
                    } else {
                        HStack(spacing: 10) {
                            ProgressView().controlSize(.small)
                            Text("Looking for agents on this Mac…").font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.6))
                        }
                        .reloGlassRow()
                    }
                }
                if !agents.notInstalled.isEmpty {
                    ReloGlassGroup {
                        DisclosureGroup(isExpanded: $showNotInstalled) {
                            ForEach(agents.notInstalled) { harness in
                                ReloGlassDivider()
                                notInstalledRow(harness)
                            }
                        } label: {
                            Text("Not on this Mac (\(agents.notInstalled.count))")
                                .font(.system(size: 13, weight: .medium)).foregroundStyle(.white.opacity(0.8))
                        }
                        .reloGlassRow()
                    }
                }
                HStack {
                    Spacer()
                    Button { Task { await agents.refresh() } } label: { Label("Look again", systemImage: "arrow.clockwise") }
                        .buttonStyle(ReloGlassButtonStyle()).disabled(agents.busy != nil)
                }
            }
        }
        .task { await agents.refresh() }
        .sheet(isPresented: Binding(get: { agents.sheet != nil }, set: { if !$0 { agents.closeSheet() } })) {
            ReloAgentSetupSheet()
        }
    }

    private func notInstalledRow(_ harness: LocalServer.Harness) -> some View {
        HStack(spacing: 14) {
            ReloSourceMark(name: harness.name, size: 18)
                .frame(width: 34, height: 34)
                .background(Circle().fill(.white.opacity(0.07)))
                .saturation(0.2)
            VStack(alignment: .leading, spacing: 3) {
                Text(harness.name).font(.system(size: 13.5, weight: .medium)).foregroundStyle(.white.opacity(0.7))
                Text("Not installed").font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.45))
            }
            Spacer(minLength: 8)
        }
        .padding(.vertical, 6)
    }

    private var footer: String {
        "Set up lets you choose how an agent reports: it shows its work in the notch"
            + (store.isLocal ? "." : " and on your iPhone.") + " Installed a new agent? Look again."
    }

    private func row(_ harness: LocalServer.Harness) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 14) {
                ReloSourceMark(name: harness.name, size: 18)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(.white.opacity(0.07)))
                    .saturation(harness.isSetUp ? 1 : 0.2)
                VStack(alignment: .leading, spacing: 3) {
                    Text(harness.name).font(.system(size: 13.5, weight: .medium)).foregroundStyle(.white)
                    HStack(spacing: 6) {
                        Circle().fill(harness.isSetUp ? ReloNotchTheme.done : .white.opacity(0.3)).frame(width: 6, height: 6)
                        Text(harness.statusLine).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55))
                    }
                    if let installed = harness.installedSummary {
                        Text(installed).font(.system(size: 11)).foregroundStyle(.white.opacity(0.4))
                    }
                    if let update = harness.updateReadyText {
                        Text(update).font(.system(size: 11)).foregroundStyle(ReloNotchTheme.warning)
                    }
                }
                Spacer(minLength: 8)
                actions(harness)
            }
            if let note = agents.notes[harness.id] {
                Text(note.text).font(.system(size: 11.5))
                    .foregroundStyle(note.failed ? ReloNotchTheme.warning : .white.opacity(0.6))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 48)
            }
        }
        .reloGlassRow()
    }

    @ViewBuilder private func actions(_ harness: LocalServer.Harness) -> some View {
        if agents.busy == harness.id {
            ProgressView().controlSize(.small)
        } else if harness.isSetUp {
            HStack(spacing: 8) {
                Button("Options") { agents.openSetup(harness) }
                    .buttonStyle(ReloGlassButtonStyle())
                    .disabled(agents.busy != nil || agents.needsConnect)
                Button("Remove") { Task { await agents.remove(harness) } }
                    .buttonStyle(ReloGlassButtonStyle(tint: ReloNotchTheme.signalCoral.reloLight(0.3)))
                    .disabled(agents.busy != nil)
            }
        } else {
            Button("Set up") { agents.openSetup(harness) }
                .buttonStyle(ReloGlassButtonStyle(tint: ReloNotchTheme.cyan.reloLight(0.2)))
                .disabled(agents.busy != nil || agents.needsConnect)
        }
    }

    // MARK: Reporting

    /// Signed in to a server while this Mac's relo command is not (or is signed in elsewhere): agents set up here have
    /// nowhere to report yet. Local mode signs the command in itself.
    private var reportingWarning: String? {
        guard !store.isLocal, let signIn = agents.commandSignIn else { return nil }
        let server = store.serverOrigin?.host()
        if !signIn.signedIn {
            return "Your agents can't report yet: this Mac's relo command is not connected to \(server ?? "your server"). Connect agents signs it in."
        }
        if let server, let commandServer = signIn.server?.host(), commandServer != server {
            return "Your agents report to \(commandServer), not \(server). Add this Mac in \(server)'s Dashboard to move them."
        }
        return nil
    }

    private func warningGroup(_ text: String) -> some View {
        ReloGlassGroup {
            HStack(spacing: 14) {
                Image(systemName: "exclamationmark.circle").font(.system(size: 18)).foregroundStyle(ReloNotchTheme.warning)
                ReloGlassLabel(title: "Not reporting yet", detail: text)
                Spacer(minLength: 8)
                if agents.connecting {
                    ProgressView().controlSize(.small)
                } else if agents.needsConnect {
                    Button("Connect agents") { Task { await agents.connect() } }.buttonStyle(ReloGlassButtonStyle(tint: ReloNotchTheme.cyan.reloLight(0.2)))
                } else if let url = store.dashboardURL {
                    Button("Open Dashboard") { NSWorkspace.shared.open(url) }.buttonStyle(ReloGlassButtonStyle())
                }
            }
            .reloGlassRow()
            if let note = agents.connectNote {
                Text(note.text).font(.system(size: 11.5))
                    .foregroundStyle(note.failed ? ReloNotchTheme.warning : .white.opacity(0.6))
                    .fixedSize(horizontal: false, vertical: true)
                    .reloGlassRow()
            }
        }
    }
}

/// The notch's one question about an agent installed since Relo last looked: set it up, or not now (asked once).
struct ReloAgentFoundBanner: View {
    @State private var agents = ReloAgents.shared

    var body: some View {
        if let harness = agents.newlyFound {
            HStack(spacing: 10) {
                ReloSourceMark(name: harness.name, size: 14).frame(width: 20)
                Text("\(harness.name) is on this Mac. Show its work here?")
                    .font(.callout.weight(.medium)).lineLimit(1)
                Spacer(minLength: 8)
                if agents.busy == harness.id {
                    ProgressView().controlSize(.small).tint(.white)
                } else {
                    Button("Not now") { agents.dismiss(harness) }.buttonStyle(ReloPillButtonStyle(prominent: false))
                    Button("Set up") { Task { await agents.setUp(harness) } }.buttonStyle(ReloPillButtonStyle(prominent: true))
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(.black.opacity(0.85), in: Capsule())
            .padding(.horizontal, 12).padding(.bottom, 6)
            .transition(.opacity)
        }
    }
}

/// "Set up <Agent>" / "Change setup": the depth to choose, then the run's progress and result.
struct ReloAgentSetupSheet: View {
    @State private var agents = ReloAgents.shared
    @State private var choice: LocalServer.SetupChoice?
    @State private var approvals = false

    var body: some View {
        if let sheet = agents.sheet {
            let harness = sheet.harness
            let choices = LocalServer.SetupChoice.all.filter { !$0.needsSessionTracking || !harness.lacksSessionTracking }
            let selected = choice ?? harness.currentChoice
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    ReloSourceMark(name: harness.name, size: 18).frame(width: 34, height: 34).background(Circle().fill(.white.opacity(0.07)))
                    Text(sheet.isChange ? "Change setup for \(harness.name)" : "Set up \(harness.name)")
                        .font(.system(size: 16, weight: .semibold)).foregroundStyle(.white)
                }
                switch sheet.phase {
                case .choosing:
                    chooser(choices: choices, selected: selected, sheet: sheet)
                case .running:
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text("Setting up \(harness.name)…").font(.system(size: 13)).foregroundStyle(.white.opacity(0.8))
                    }
                    .padding(.vertical, 20)
                case .done(let steps, let ownerSteps):
                    VStack(alignment: .leading, spacing: 8) {
                        Label("\(harness.name) is set up. Restart \(harness.name) to start.", systemImage: "checkmark.circle.fill")
                            .font(.system(size: 13, weight: .medium)).foregroundStyle(ReloNotchTheme.done)
                        ForEach(steps, id: \.self) { step in
                            Text(step).font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
                        }
                        ForEach(ownerSteps, id: \.self) { step in
                            Text(step).font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.85)).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    HStack { Spacer(); Button("Done") { agents.closeSheet() }.buttonStyle(ReloPrimaryButtonStyle()) }
                case .failed(let problem):
                    Label(problem, systemImage: "exclamationmark.circle").font(.system(size: 13)).foregroundStyle(ReloNotchTheme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Spacer()
                        Button("Cancel") { agents.closeSheet() }.buttonStyle(ReloGlassButtonStyle())
                        Button("Try again") { Task { await agents.runSetup(selected, approvals: approvals) } }
                            .buttonStyle(ReloPrimaryButtonStyle())
                    }
                }
            }
            .padding(24)
            .frame(width: 460)
            .background(Color(white: 0.1))
            .onAppear {
                choice = harness.currentChoice
                approvals = harness.parts?.approvals ?? false
            }
        }
    }

    @ViewBuilder private func chooser(choices: [LocalServer.SetupChoice], selected: LocalServer.SetupChoice,
                                      sheet: ReloAgents.SetupSheet) -> some View {
        VStack(spacing: 8) {
            ForEach(choices) { option in
                Button { choice = option } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: option == selected ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(option == selected ? ReloNotchTheme.done : .white.opacity(0.4))
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                Text(option.title).font(.system(size: 13, weight: .medium)).foregroundStyle(.white)
                                if option == LocalServer.SetupChoice.recommended(for: sheet.harness) {
                                    Text("Recommended").font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.5))
                                }
                            }
                            Text(option.detail).font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(option == selected ? 0.1 : 0.04)))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(.white.opacity(option == selected ? 0.3 : 0.08)))
                }
                .buttonStyle(.plain)
            }
        }
        Toggle("Answer permission prompts from your iPhone", isOn: $approvals)
            .toggleStyle(.switch).font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.85))
            .disabled(!selected.needsSessionTracking)
            .opacity(selected.needsSessionTracking ? 1 : 0.4)
        HStack {
            Spacer()
            Button("Cancel") { agents.closeSheet() }.buttonStyle(ReloGlassButtonStyle())
            Button("Set up") { Task { await agents.runSetup(selected, approvals: approvals) } }
                .buttonStyle(ReloPrimaryButtonStyle())
        }
    }
}
