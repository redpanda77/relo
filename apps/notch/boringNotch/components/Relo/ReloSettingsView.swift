//
//  ReloSettingsView.swift
//  Relo Notch
//
//  The Settings window's Relo pages, one sidebar entry each: Relo (who this Mac is signed in as, on which server,
//  sign-in or sign-out, updates), Alerts (what the closed notch shows, sounds, haptics) and Voice (the play button,
//  spoken updates and the Relo voice). Relo and Alerts are glass (docs/internal/product/mac-glass-study).
//

import Defaults
import ReloNotchKit
import ReloVoice
import SwiftUI

/// A glass settings page's title: the page's name and one line on what it holds, with the orb on Relo's own page.
struct ReloSettingsTitle: View {
    let title: String
    let detail: String
    var orb = false

    var body: some View {
        HStack(spacing: 14) {
            if orb { ReloOrb(mood: .clear).frame(width: 34, height: 34) }
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 24, weight: .bold)).tracking(-0.3).foregroundStyle(.white)
                    .accessibilityAddTraits(.isHeader)
                Text(detail).font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.55))
            }
        }
    }
}

/// A glass settings page: its title, then its groups, scrolling, building in as it opens.
struct ReloGlassPage<Content: View>: View {
    let title: String
    let detail: String
    var orb = false
    @ViewBuilder let content: Content
    @State private var appeared = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                ReloSettingsTitle(title: title, detail: detail, orb: orb).reloEntrance(0, appeared)
                content.reloEntrance(1, appeared)
            }
            .padding(.leading, 14).padding(.trailing, 30).padding(.top, 10).padding(.bottom, 24)
            .frame(maxWidth: 680, alignment: .leading)
        }
        .scrollIndicators(.never)
        .toggleStyle(ReloGlassToggleStyle())
        .onAppear { appeared = true }
    }
}

struct ReloSettingsView: View {
    private let store = ReloNotch.store

    @ObservedObject private var updater = ReloUpdater.shared
    /// Set when Relo was removed from this Mac: the page says so (and how to finish) instead of showing a sign-in.
    @State private var removal: ReloRemoval?

    private var localMode: Bool { store.isLocal && ReloServerService.shared.isBundled }

    var body: some View {
        ReloGlassPage(title: "Relo",
                      detail: localMode ? "Relo on this Mac, your agents, and how it stays current"
                                        : "Who this Mac is, where its cards go, and how it stays current", orb: true) {
            VStack(alignment: .leading, spacing: 22) {
                ReloModeSwitchGroup()
                ReloPendingApprovalGroup()
                if let removal { ReloRemovedSection(removal: removal) }
                else if localMode { ReloLocalSection(onUninstalled: { removal = ReloRemoval(problem: $0) }) }
                else {
                    account
                    if ReloServerService.shared.isBundled { runHereGroup }
                    if signedIn { encryptionGroup }
                }
                ReloGlassGroup(title: "Updates",
                               footer: updater.started
                                   ? (localMode ? "Relo for Mac keeps itself, Relo on this Mac and your agents' setup up to date."
                                                : "Updates come from your Relo server. Off: Relo for Mac asks before it installs one.")
                                   : "This build does not take updates. Download the latest Relo for Mac.") {
                    HStack(spacing: 14) {
                        ReloGlassLabel(title: "Relo for Mac", detail: ReloUpdater.versionLine)
                        Spacer(minLength: 8)
                        if updater.started {
                            Button { updater.checkForUpdates() } label: {
                                Label("Check for Updates…", systemImage: "arrow.down.circle")
                            }
                            .buttonStyle(ReloGlassButtonStyle())
                            .disabled(!updater.canCheck)
                        }
                    }
                    .reloGlassRow()
                    if updater.started {
                        ReloGlassDivider()
                        Toggle(isOn: Binding(get: { updater.installsAutomatically }, set: { updater.installsAutomatically = $0 })) {
                            ReloGlassLabel(title: "Install updates automatically")
                        }
                        .reloGlassRow()
                    }
                }
            }
        }
    }

    /// Who this Mac is signed in as, how it is connected, and the way in or out; then its server and its name.
    private var account: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(spacing: 0) {
                HStack(spacing: 16) {
                    avatar
                    VStack(alignment: .leading, spacing: 5) {
                        Text(store.accountEmail ?? accountLine)
                            .font(.system(size: 16, weight: .semibold)).foregroundStyle(.white)
                            .lineLimit(1).truncationMode(.middle)
                        Text(statusLine).font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.6))
                    }
                    Spacer(minLength: 8)
                    accountButton
                }
                .padding(20)
                if let problem = store.problem {
                    Text(problem)
                        .font(.system(size: 11.5)).foregroundStyle(ReloNotchTheme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 20).padding(.bottom, 14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                ReloGlassDivider()
                fact("server.rack", "Server", store.serverOrigin.map(ReloNotchStore.displayAddress(of:)) ?? "Not set", mono: true)
                if !isSignedOut {
                    ReloGlassDivider()
                    fact("laptopcomputer", "This Mac", Host.current().localizedName ?? "This Mac")
                }
            }
            .background {
                ZStack {
                    RadialGradient(colors: [ReloNotchTheme.running.opacity(0.22), .clear], center: .topLeading, startRadius: 0, endRadius: 320)
                    RadialGradient(colors: [ReloNotchTheme.done.opacity(0.1), .clear], center: .bottomTrailing, startRadius: 0, endRadius: 280)
                }
                .clipShape(RoundedRectangle(cornerRadius: ReloGlass.radius, style: .continuous))
            }
            .reloGlass()
            if isSignedOut {
                ReloServerChoice().frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
                Text("Sign in to your Relo account in the browser. If you use an iPhone, approve this Mac there to read private work.")
                    .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.48)).padding(.horizontal, 4)
            }
        }
    }

    private var avatar: some View {
        let initial = store.accountEmail?.first.map { String($0).uppercased() }
        return ZStack {
            Circle().fill(LinearGradient(colors: [Color(red: 0xA1 / 255, green: 0x94 / 255, blue: 1), Color(red: 0x5B / 255, green: 0x47 / 255, blue: 0xE0 / 255)],
                                         startPoint: .topLeading, endPoint: .bottomTrailing))
                .shadow(color: ReloNotchTheme.running.opacity(0.45), radius: 10, y: 4)
            if let initial {
                Text(initial).font(.system(size: 21, weight: .bold, design: .rounded)).foregroundStyle(.white)
            } else {
                Image(systemName: "person.fill").font(.system(size: 20)).foregroundStyle(.white)
            }
        }
        .frame(width: 52, height: 52)
        .overlay(alignment: .bottomTrailing) {
            if store.connection == .live {
                ReloLiveDot(color: ReloNotchTheme.done).padding(3)
            }
        }
        .accessibilityHidden(true)
    }

    private func fact(_ symbol: String, _ title: String, _ value: String, mono: Bool = false) -> some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .medium)).foregroundStyle(.white.opacity(0.75))
                .frame(width: 30, height: 30)
                .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(.white.opacity(0.07)))
            Text(title).font(.system(size: 13.5)).foregroundStyle(.white)
            Spacer(minLength: 8)
            Text(value)
                .font(mono ? .system(size: 12.5, weight: .medium, design: .monospaced) : .system(size: 12.5))
                .foregroundStyle(.white.opacity(0.62))
                .lineLimit(1).truncationMode(.middle)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 18).padding(.vertical, 11)
    }

    private var signedIn: Bool { [.connecting, .live, .offline].contains(store.connection) }

    /// The way back to Relo on this Mac, for a Mac that signs in to a server.
    private var runHereGroup: some View {
        ReloGlassGroup(title: "Relo on this Mac") {
            HStack(spacing: 14) {
                ReloGlassLabel(title: ModeSwitch.tryHereRowTitle, detail: ModeSwitch.tryHereRowDetail)
                Spacer(minLength: 8)
                Button(ModeSwitch.tryHereButton + "…") { ReloLocalSetupWindowController.shared.show() }.buttonStyle(ReloGlassButtonStyle())
            }
            .reloGlassRow()
        }
    }

    /// End-to-end encryption on the server: Automatic or Always from here; Off is the Dashboard's.
    private var encryptionGroup: some View {
        ReloEncryptionGroup()
    }

    private var isSignedOut: Bool {
        [.signedOut, .needsSignIn, .starting].contains(store.connection)
    }

    @ViewBuilder
    private var accountButton: some View {
        switch store.connection {
        case .signedOut, .needsSignIn, .starting:
            Button(store.connection == .needsSignIn ? "Sign in again" : "Sign in") {
                Task { await store.signIn() }
            }
            .buttonStyle(ReloPrimaryButtonStyle())
            .disabled(!store.originChosen)
        case .signingIn:
            Button("Signing in…") {}
                .buttonStyle(ReloGlassButtonStyle())
                .disabled(true)
        case .connecting, .live, .offline:
            Button("Sign out") {
                Task { await store.signOut() }
            }
            .buttonStyle(ReloGlassButtonStyle(tint: ReloNotchTheme.signalCoral.reloLight(0.3)))
        }
    }

    private var accountLine: String {
        switch store.connection {
        case .starting: return "Starting"
        case .signedOut: return "Signed out"
        case .needsSignIn: return "Sign in again"
        case .signingIn: return "Signing in"
        case .connecting: return "Connecting"
        case .live: return "Signed in"
        case .offline: return "Offline"
        }
    }

    /// How this Mac is connected now, under the account.
    private var statusLine: String {
        switch store.connection {
        case .starting: return "Starting"
        case .signedOut: return "Not signed in"
        case .needsSignIn: return "This Mac was signed out; sign in again"
        case .signingIn: return "Finish signing in in the browser"
        case .connecting: return "Connecting"
        case .live:
            return store.lastUpdated.map { "Live · synced \($0.formatted(date: .omitted, time: .shortened))" } ?? "Live"
        case .offline:
            return store.lastUpdated.map { "Offline · as of \($0.formatted(date: .omitted, time: .shortened))" } ?? "Offline"
        }
    }
}

/// What Relo shows in the closed notch and how it alerts: the notch, sounds, haptics.
struct ReloAlertsSettingsView: View {
    @Default(.reloClosedActivity) var reloClosedActivity
    @Default(.reloPeek) var reloPeek
    @Default(.reloSounds) var reloSounds
    @Default(.reloSoundQuestion) var reloSoundQuestion
    @Default(.reloSoundFailed) var reloSoundFailed
    @Default(.reloSoundYourTurn) var reloSoundYourTurn
    @Default(.reloSoundFinished) var reloSoundFinished
    @Default(.reloSoundStarted) var reloSoundStarted
    @Default(.reloSoundStep) var reloSoundStep
    @Default(.reloInterfaceSounds) var reloInterfaceSounds
    @Default(.reloHaptics) var reloHaptics
    @Default(.reloQuietInFullScreen) var reloQuietInFullScreen

    var body: some View {
        ReloGlassPage(title: "Alerts", detail: "What the notch does when work needs you, finishes or fails") {
            VStack(alignment: .leading, spacing: 22) {
                ReloAlertPreview()
                ReloGlassGroup(title: "Notch") {
                    Toggle(isOn: $reloClosedActivity) { ReloGlassLabel(title: "Show Relo in the closed notch") }
                        .reloGlassRow()
                    ReloGlassDivider()
                    Toggle(isOn: $reloPeek) {
                        ReloGlassLabel(title: "Expand for what matters", detail: "When work starts, needs you, finishes or fails")
                    }
                    .reloGlassRow()
                    .disabled(!reloClosedActivity)
                }
                ReloGlassGroup(title: "Sounds") {
                    Toggle(isOn: $reloSounds) {
                        Text("Play sounds").font(.system(size: 13.5, weight: .semibold)).foregroundStyle(.white)
                    }
                    .reloGlassRow()
                    ReloGlassDivider()
                    Group {
                        soundToggle("A question needs you", sound: .question, isOn: $reloSoundQuestion)
                        soundToggle("It's your turn", sound: .yourTurn, isOn: $reloSoundYourTurn)
                        soundToggle("Work failed", sound: .failed, isOn: $reloSoundFailed)
                        soundToggle("Work finished", sound: .finished, isOn: $reloSoundFinished)
                        soundToggle("Work started", sound: .started, isOn: $reloSoundStarted)
                        soundToggle("A step finished", detail: "At most every 3 minutes per card", sound: .progressed, isOn: $reloSoundStep)
                        ReloGlassDivider()
                        Toggle(isOn: $reloInterfaceSounds) {
                            ReloGlassLabel(title: "Interface sounds", detail: "The notch, cards, tabs, Settings, Relo launching and quitting")
                        }
                        .reloGlassRow()
                    }
                    .disabled(!reloSounds)
                }
                ReloGlassGroup(title: "Interruptions",
                               footer: "Progress and status changes update the notch quietly; only the updates above expand it.") {
                    Toggle(isOn: $reloHaptics) { ReloGlassLabel(title: "Tap the trackpad for questions and failures") }
                        .reloGlassRow()
                    ReloGlassDivider()
                    Toggle(isOn: $reloQuietInFullScreen) { ReloGlassLabel(title: "Stay quiet while a full-screen app is in front") }
                        .reloGlassRow()
                }
            }
        }
    }

    /// A kind's row: its state colour and symbol (the cards' own), its name, a preview, its switch.
    private func soundToggle(_ title: String, detail: String? = nil, sound: NotchEvent.Kind, isOn: Binding<Bool>) -> some View {
        let tone = ReloAlertPreview.tone(sound)
        let color = ReloNotchTheme.color(tone)
        return Toggle(isOn: isOn) {
            HStack(spacing: 12) {
                Image(systemName: sound == .progressed ? "arrow.right" : ReloNotchTheme.symbol(tone))
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(color.reloLight(0.3))
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(color.opacity(0.17)))
                ReloGlassLabel(title: title, detail: detail)
                Spacer(minLength: 6)
                Button { ReloSounds.preview(sound) } label: {
                    Image(systemName: "play.fill").font(.system(size: 9)).foregroundStyle(.white.opacity(0.75))
                        .frame(width: 26, height: 26)
                        .reloGlass(radius: 13)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .help("Play this sound")
                .accessibilityLabel("Play the sound for \(title.lowercased())")
            }
        }
        .padding(.horizontal, 18).padding(.vertical, 9)
    }
}

/// The closed notch in small, playing an alert: its wings washed in the kind's colour, the beams climbing its sides,
/// and the kind's sound. Pick a kind to see and hear it.
struct ReloAlertPreview: View {
    @State private var kind: NotchEvent.Kind = .question
    @State private var plays = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let kinds: [(NotchEvent.Kind, String)] = [(.question, "Question"), (.yourTurn, "Your turn"), (.finished, "Finished"), (.failed, "Failed")]

    static func tone(_ kind: NotchEvent.Kind) -> NotchPresentation.Tone {
        switch kind {
        case .question: .needsYou
        case .yourTurn: .yourTurn
        case .failed: .failed
        case .finished: .done
        case .started, .progressed: .working
        }
    }

    var body: some View {
        let tone = Self.tone(kind)
        let color = ReloNotchTheme.color(tone)
        let notch = UnevenRoundedRectangle(bottomLeadingRadius: 16, bottomTrailingRadius: 16, style: .continuous)
        VStack(spacing: 14) {
            ZStack {
                notch.fill(.black)
                HStack {
                    Circle().fill(color).frame(width: 11, height: 11).shadow(color: color, radius: 6)
                    Spacer()
                    Text(ReloNotchTheme.label(tone))
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .foregroundStyle(color.reloLight(0.2))
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(Capsule().fill(color.opacity(0.22)))
                }
                .padding(.horizontal, 20)
                ReloEdgeBeams(color: color, radius: 16, trigger: plays)
                    .mask(Rectangle().padding(.top, 3))
            }
            .background(alignment: .bottom) {
                EllipticalGradient(colors: [color.opacity(0.5), .clear], center: .bottom, startRadiusFraction: 0, endRadiusFraction: 0.6)
                    .frame(height: 70).offset(y: 34).blur(radius: 8)
            }
            .frame(width: 320, height: 34)
            .animation(ReloMotion.base, value: kind)
            HStack(spacing: 12) {
                Text("Preview").font(.system(size: 12)).foregroundStyle(.white.opacity(0.55))
                HStack(spacing: 3) {
                    ForEach(Self.kinds, id: \.1) { item in
                        let selected = item.0 == kind
                        let tint = ReloNotchTheme.color(Self.tone(item.0))
                        Button(item.1) {
                            kind = item.0
                            plays += 1
                            ReloSounds.preview(item.0)
                        }
                        .buttonStyle(.plain)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(selected ? tint.reloLight(0.35) : .white.opacity(0.6))
                        .padding(.horizontal, 12).padding(.vertical, 5)
                        .background(Capsule().fill(selected ? tint.opacity(0.22) : .clear))
                        .contentShape(Capsule())
                    }
                }
                .padding(3)
                .reloGlass(radius: 999)
            }
        }
        .padding(.bottom, 18)
        .frame(maxWidth: .infinity)
        .background {
            EllipticalGradient(colors: [color.opacity(0.2), .clear], center: .top, startRadiusFraction: 0, endRadiusFraction: 0.6)
                .clipShape(RoundedRectangle(cornerRadius: ReloGlass.radius, style: .continuous))
        }
        .reloGlass()
        .onAppear { plays += 1 }
    }
}


/// The play button on cards, updates said aloud and the Relo voice.
struct ReloVoiceSettingsView: View {
    private let voice = ReloNotch.voice

    @Default(.reloVoiceButton) var reloVoiceButton
    @Default(.reloVoiceMode) var reloVoiceMode
    @Default(.reloVoiceDetail) var reloVoiceDetail
    @Default(.reloVoiceEngine) var reloVoiceEngine
    @Default(.reloVoiceSpeaker) var reloVoiceSpeaker

    var body: some View {
        Form {
            Section {
                Toggle("Show a play button on cards", isOn: $reloVoiceButton)
                    .onChange(of: reloVoiceButton) { _, on in if on { voice.start() } }
                Group {
                    Picker("Updates", selection: $reloVoiceMode) {
                        Text("Sound only").tag(ReloVoiceMode.soundOnly.rawValue)
                        Text("Sound, then voice").tag(ReloVoiceMode.soundThenVoice.rawValue)
                        Text("Sound as the kind, then voice").tag(ReloVoiceMode.soundAsKind.rawValue)
                        Text("Voice only").tag(ReloVoiceMode.voiceOnly.rawValue)
                    }
                    Picker("Spoken detail", selection: $reloVoiceDetail) {
                        Text("Brief: the kind and the work").tag("brief")
                        Text("Full: and what happened").tag("full")
                        Text("Verbose: and each finished step").tag("verbose")
                    }
                    .disabled(reloVoiceMode == ReloVoiceMode.soundOnly.rawValue)
                    Picker("Voice", selection: $reloVoiceEngine) {
                        Text("Relo voice").tag(ReloVoice.Engine.relo.rawValue)
                        Text("System voice").tag(ReloVoice.Engine.system.rawValue)
                    }
                    .onChange(of: reloVoiceEngine) { _, value in voice.engine = ReloVoice.Engine(rawValue: value) ?? .relo }
                    if reloVoiceEngine == ReloVoice.Engine.relo.rawValue {
                        voiceModelRow
                        speakerPicker
                    }
                    HStack {
                        if let error = voice.lastError {
                            Text(error).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button(voice.phase == nil ? "Preview" : "Stop") {
                            if voice.phase == nil { voice.preview() } else { voice.stop() }
                        }
                    }
                }
                .disabled(!reloVoiceButton)
            } header: {
                Text("Voice")
            } footer: {
                Text("Every line starts with what kind of update it is: Needs you, Failed, Your turn or Finished. With Sound as the kind, the sound says that and the line starts at the work's name; with Voice only, those updates play no sound. A project set to say less with relo voice says less here too. Lines are made and played on this Mac from what its cards show; nothing is sent anywhere. Updates are not said during a call or dictation. The Relo voice (Phonon by Gradium) downloads on its own over Wi-Fi; until then the system voice speaks. Other speakers come from Gradium's voice catalog; picking one downloads its voice (256 KB) and plays the preview.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accentColor(.effectiveAccent)
        .navigationTitle("Voice")
    }

    /// Who the Relo voice speaks as. Picking one fetches its small file and says the preview in it.
    @ViewBuilder
    private var speakerPicker: some View {
        let choice = Binding(get: { reloVoiceSpeaker }, set: { id in
            reloVoiceSpeaker = id
            voice.choose(speaker: id)
        })
        Picker("Speaker", selection: choice) {
            Text("Relo (default)").tag(PhononVoice.defaultID)
            Section("Women") { speakers(.female) }
            Section("Men") { speakers(.male) }
            Section("Characters") { speakers(.character) }
        }
        if let picked = PhononVoice.named(reloVoiceSpeaker) {
            VStack(alignment: .leading, spacing: 2) {
                if voice.fetchingSpeaker == picked.id {
                    Text("Downloading \(picked.name)'s voice…")
                } else if let problem = voice.speakerProblem {
                    Text(problem)
                }
                Text(picked.description)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private func speakers(_ kind: PhononVoice.Kind) -> some View {
        ForEach(PhononVoice.english.filter { $0.kind == kind }) { speaker in
            Text([speaker.name, speaker.accent].compactMap { $0 }.joined(separator: " · ")).tag(speaker.id)
        }
    }

    @ViewBuilder
    private var voiceModelRow: some View {
        let models = voice.models
        HStack {
            Text("Relo voice")
            Spacer()
            switch models.state {
            case .missing:
                Text(models.waitingForNetwork ? "Waiting for Wi-Fi" : ByteCountFormatter.string(fromByteCount: models.model.bytes, countStyle: .file))
                    .foregroundStyle(.secondary)
                Button(models.waitingForNetwork ? "Download Now" : "Download") { models.download() }
            case .downloading(let fraction):
                ProgressView(value: fraction).frame(width: 120)
                Button("Cancel") { models.cancel() }
            case .ready:
                Text("Downloaded").foregroundStyle(.secondary)
                Button("Delete") { voice.deleteModel() }
            case .failed(let message):
                Text(message).foregroundStyle(.secondary).lineLimit(1)
                Button("Try Again") { models.download() }
            }
        }
    }
}

/// Relo on this Mac (local mode): whether it runs, its version, setting up agents again, another server, and the way out.
/// No account, no server address and no sign-out: there is nothing to sign in to.
struct ReloLocalSection: View {
    /// Relo was removed from this Mac; the problems on the way, in words, or nil.
    let onUninstalled: (String?) -> Void
    @State private var running: Bool?
    @State private var busy = false
    @State private var problem: String?
    @State private var confirmingUninstall = false

    private let service = ReloServerService.shared

    var body: some View {
        ReloGlassGroup(title: "Relo on this Mac",
                       footer: "Relo runs in the background whenever you are logged in to this Mac. Nothing leaves this Mac.") {
            HStack(spacing: 14) {
                ReloGlassLabel(title: running == false ? "Not running" : "Running",
                               detail: UpdatePolicy.versionText(LocalServer.shortVersion(ofRelease: service.server.appRelease)))
                Spacer(minLength: 8)
                if service.state == .needsApproval {
                    Button("Open Login Items") { service.openLoginItems() }.buttonStyle(ReloGlassButtonStyle())
                }
                if running == false {
                    Button("Try again") {
                        busy = true
                        Task {
                            let ok = await ReloLocalMode.retryStart()
                            problem = ok ? nil : "Relo is still not running."
                            busy = false
                            await refresh()
                        }
                    }
                    .buttonStyle(ReloGlassButtonStyle()).disabled(busy)
                }
            }
            .reloGlassRow()
            if let problem {
                Text(problem).font(.system(size: 11.5)).foregroundStyle(ReloNotchTheme.warning)
                    .padding(.horizontal, 18).padding(.bottom, 10)
                Button("Show details") { ReloLocalMode.showDetails() }
                    .buttonStyle(.plain).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55))
                    .padding(.horizontal, 18).padding(.bottom, 10)
            }
            ReloGlassDivider()
            HStack(spacing: 14) {
                ReloGlassLabel(title: ModeSwitch.useServerRowTitle, detail: ModeSwitch.useServerRowDetail)
                Spacer(minLength: 8)
                Button("Connect…") {
                    busy = true
                    Task {
                        _ = await ReloLocalMode.confirmUseAnotherServer()
                        busy = false
                    }
                }
                .buttonStyle(ReloGlassButtonStyle()).disabled(busy)
            }
            .reloGlassRow()
            ReloGlassDivider()
            HStack(spacing: 14) {
                ReloGlassLabel(title: "Uninstall Relo from this Mac…")
                Spacer(minLength: 8)
                Button("Uninstall…") { confirmUninstall() }
                    .buttonStyle(ReloGlassButtonStyle(tint: ReloNotchTheme.signalCoral.reloLight(0.3))).disabled(busy)
            }
            .reloGlassRow()
        }
        .task { await refresh() }
        .task { await service.watchState() }
    }

    private func refresh() async {
        running = await service.server.currentHealth() != nil
    }

    private func confirmUninstall() {
        let alert = NSAlert()
        alert.messageText = "Uninstall Relo from this Mac?"
        alert.informativeText = """
        This removes:
        \u{2022} Relo's setup in your agents
        \u{2022} Relo running in the background
        \u{2022} Relo's terminal shortcut, when Relo for Mac added it
        \u{2022} Relo's care of your agents' updates (they update themselves again)
        \u{2022} the link between this app and Relo on this Mac

        Your cards and their history stay on this Mac unless you tick the box below.
        """
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Uninstall")
        alert.addButton(withTitle: "Cancel")
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = "Also delete Relo's data on this Mac"
        alert.suppressionButton?.state = .off
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let deleteData = alert.suppressionButton?.state == .on
        busy = true
        Task {
            let problem = await ReloLocalMode.uninstall(deleteData: deleteData)
            busy = false
            // Always leave this page: it is the end of Relo on this Mac, with what went wrong, if anything, shown there.
            onUninstalled(problem)
        }
    }
}

/// What Relo says once it is removed from this Mac.
struct ReloRemoval: Equatable {
    let problem: String?
}

struct ReloRemovedSection: View {
    let removal: ReloRemoval

    var body: some View {
        ReloGlassGroup(title: "Relo on this Mac") {
            VStack(alignment: .leading, spacing: 12) {
                if let problem = removal.problem {
                    Text(problem).font(.system(size: 12)).foregroundStyle(ReloNotchTheme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(LocalMode.removed).font(.system(size: 13.5)).foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    Spacer()
                    Button("Quit Relo") { NSApp.terminate(nil) }.buttonStyle(ReloPrimaryButtonStyle())
                }
            }
            .reloGlassRow()
        }
    }
}

/// Settings, remote only: whether Relo seals cards end to end. Automatic seals once an iPhone is trusted; Always seals
/// from the start; Off is turned on only in the Dashboard (a stolen credential must not be able to weaken it).
struct ReloEncryptionGroup: View {
    private let store = ReloNotch.store
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        let policy = store.encryption
        ReloGlassGroup(title: "Encryption") {
            HStack(spacing: 14) {
                ReloGlassLabel(title: "Encryption", detail: policy.map { detail($0) } ?? "Reading the server's choice…")
                Spacer(minLength: 8)
                if let policy {
                    Menu {
                        Button("Automatic") { choose(always: false) }
                        Button("Always") { choose(always: true) }
                    } label: {
                        Text(policy.title)
                    }
                    .menuStyle(.button)
                    .buttonStyle(ReloGlassButtonStyle())
                    .fixedSize()
                    .disabled(busy)
                    .accessibilityLabel("Encryption: \(policy.title)")
                }
            }
            .reloGlassRow()
            if let note = policy?.note(phoneTrusted: store.phoneTrusted) {
                Text(note).font(.system(size: 11.5)).foregroundStyle(ReloNotchTheme.warning)
                    .padding(.horizontal, 18).padding(.bottom, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let problem {
                Text(problem).font(.system(size: 11.5)).foregroundStyle(ReloNotchTheme.warning)
                    .padding(.horizontal, 18).padding(.bottom, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ReloGlassDivider()
            HStack(spacing: 14) {
                ReloGlassLabel(title: "Turn off in the Dashboard", detail: "Turning encryption off needs you signed in there.")
                Spacer(minLength: 8)
                Button { if let url = store.securityURL { NSWorkspace.shared.open(url) } } label: {
                    Label("Open", systemImage: "arrow.up.right.square")
                }
                .buttonStyle(ReloGlassButtonStyle())
                .disabled(store.securityURL == nil)
            }
            .reloGlassRow()
        }
        .task { await store.refreshEncryption() }
    }

    private func detail(_ policy: EncryptionPolicy) -> String {
        switch policy.mode {
        case .auto: EncryptionPolicy.automaticDetail
        case .on: "Always: every card is sealed for your trusted devices"
        case .off: "Off: cards are stored readable on the server"
        }
    }

    private func choose(always: Bool) {
        busy = true
        problem = nil
        Task {
            problem = await store.setEncryption(always: always)
            busy = false
        }
    }
}
