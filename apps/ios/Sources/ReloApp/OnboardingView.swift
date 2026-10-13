import ReloCore
import SwiftUI

/// First run, in the Now deck's voice: the same sphere, ring and dust, with the wordmark in the
/// lens where Now shows its count. The sphere rests in Relo's blue, ripples while the browser is
/// open, and turns orange when something went wrong.
struct OnboardingView: View {
    @Bindable var model: AppModel
    @State private var topInset: CGFloat = 59

    private var state: ReloSignalState {
        if model.authenticationError != nil && !model.isAuthenticating { return .needsYou }
        return .clear
    }

    /// Shown under the wordmark only when something is happening; at rest the lens says just "relo".
    private var status: String? {
        if model.isAuthenticating { return "WAITING FOR BROWSER" }
        if model.authenticationError != nil { return "NOT SIGNED IN" }
        return nil
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    ReloWelcomeStage(state: state, status: status, working: model.isAuthenticating)
                        .padding(.top, topInset)
                    content.padding(.horizontal, ReloLayout.screenInset)
                }
                .padding(.bottom, 32)
            }
            .ignoresSafeArea(.container, edges: .top)
            .background { GeometryReader { proxy in Color.clear
                .onAppear { topInset = proxy.safeAreaInsets.top }
                .onChange(of: proxy.safeAreaInsets.top) { _, new in topInset = new } } }
            .reloScreenBackground()
            .navigationTitle("Welcome")
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $editingServer) {
                ServerAddressSheet(origin: origin, guide: Self.selfHostingGuide) { origin = $0 }
            }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Your agents.\nOne calm Inbox.")
                    .font(.system(.largeTitle, design: .rounded).weight(.bold))
                    .fixedSize(horizontal: false, vertical: true)
                Text("Get updates, follow work, and respond when your agents need you.")
                    .font(.body).foregroundStyle(Color.reloSecondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            server
            VStack(spacing: 10) {
                Button(action: signIn) {
                    HStack(spacing: 8) {
                        if model.isAuthenticating { ProgressView().tint(.white) }
                        Text(model.isAuthenticating ? "Signing in…" : "Sign in")
                    }
                    .font(.headline).foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 54)
                    .background { ReloSignInFill(shimmers: hasServer && !model.isAuthenticating) }
                    .shadow(color: ReloHoloTheme.blue.opacity(hasServer ? 0.4 : 0), radius: 18, y: 6)
                    .opacity(hasServer ? 1 : 0.45)
                }
                .buttonStyle(ReloPressStyle())
                .disabled(!hasServer || model.isAuthenticating)
                Text("Sign-in opens in the browser. You'll come straight back here.")
                    .font(.footnote).foregroundStyle(Color.reloSecondaryText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity)
            if let error = model.authenticationError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline).foregroundStyle(Color.reloErrorText)
            }
            if model.protectedRegistrationResetAvailable {
                NavigationLink("Repair this iPhone's registration") { ConnectionSettingsView(model: model) }
                    .font(.subheadline.weight(.medium)).tint(.reloInteractive)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            // Relo is self-hosted: someone without a server needs the guide, not a dead end. It sits
            // centred at the foot, the place iOS sign-in screens keep their "new here?" line.
            Link(destination: Self.selfHostingGuide) {
                (Text("New to Relo? ").foregroundStyle(Color.reloSecondaryText)
                    + Text("Set up a server ↗").foregroundStyle(Color.reloInteractive).fontWeight(.semibold))
                    .font(.footnote)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .padding(.top, 8)
        }
        .onAppear { if origin.isEmpty { origin = model.chosenServerOrigin ?? "" } }
    }

    private static let selfHostingGuide = URL(string: "https://github.com/redpanda77/relo/blob/main/docs/SELF-HOSTING.md")!

    @State private var origin = ""
    @State private var editingServer = false

    private var hasServer: Bool { !origin.trimmingCharacters(in: .whitespaces).isEmpty }

    private var normalizedOrigin: String { Self.normalize(origin) }

    /// What the owner typed, as an origin: a bare host gets HTTPS, as a browser would.
    static func normalize(_ origin: String) -> String {
        let value = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        let withScheme = value.contains("://") ? value : "https://\(value)"
        return withScheme.hasSuffix("/") ? String(withScheme.dropLast()) : withScheme
    }

    /// The dashboard of the server in the field, once it is a valid address. Nothing to open before.
    private var dashboardURL: URL? {
        guard hasServer, let url = URL(string: normalizedOrigin), url.host() != nil,
              ServerEndpointPolicy.accepts(url) else { return nil }
        return url.appendingPathComponent("dashboard")
    }

    private func signIn() {
        guard hasServer, !model.isAuthenticating else { return }
        if model.chosenServerOrigin?.trimmingCharacters(in: CharacterSet(charactersIn: "/")) != normalizedOrigin {
            guard model.selectServerOrigin(normalizedOrigin) else { return }
        }
        Task { _ = await model.signInWithBrowser() }
    }

    /// Where this iPhone signs in: typed by the owner, never filled in for them. The card shows the
    /// address; tapping it opens a sheet to type one, so the keyboard never covers the screen.
    private var server: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("YOUR SERVER")
                    .font(.system(.caption2, design: .monospaced).weight(.semibold)).tracking(2)
                    .foregroundStyle(Color.reloSecondaryText)
                Spacer()
                if let dashboardURL {
                    Link(destination: dashboardURL) {
                        Text("DASHBOARD ↗").font(.system(.caption2, design: .monospaced).weight(.semibold)).tracking(2)
                    }
                    .tint(.reloInteractive).frame(minHeight: 32)
                    .accessibilityLabel("Open dashboard")
                }
            }
            Button { editingServer = true } label: {
                HStack(spacing: 12) {
                    if hasServer {
                        // HTTPS is a given, so the card spends its width on the host.
                        Text(normalizedOrigin.replacingOccurrences(of: "https://", with: ""))
                            .font(.system(.body, design: .monospaced)).foregroundStyle(.white)
                            .lineLimit(1).truncationMode(.middle)
                    } else {
                        Label("Add your server", systemImage: "plus.circle.fill")
                            .font(.body.weight(.medium)).foregroundStyle(Color.reloInteractive)
                    }
                    Spacer(minLength: 0)
                    if hasServer {
                        Text("Change").font(.subheadline.weight(.medium)).foregroundStyle(Color.reloInteractive)
                    } else {
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
                            .foregroundStyle(Color.reloSecondaryText)
                    }
                }
                .frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(ReloPressStyle())
            .disabled(model.isAuthenticating)
            .accessibilityLabel(hasServer ? "Server address, \(normalizedOrigin)" : "Add your server")
            .accessibilityHint(hasServer ? "Change the server address" : "")
        }
        .padding(.horizontal, ReloLayout.cardInset).padding(.vertical, 14)
        .reloCard()
        .animation(.smooth(duration: 0.25), value: dashboardURL)
    }
}

/// The server address, typed in a sheet the way iOS asks for one (Mail's account server, Safari's
/// address): a short form, keyboard up at once, Cancel and Done in the bar.
private struct ServerAddressSheet: View {
    let guide: URL
    let save: (String) -> Void
    @State private var draft: String
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss

    init(origin: String, guide: URL, save: @escaping (String) -> Void) {
        self.guide = guide
        self.save = save
        _draft = State(initialValue: origin)
    }

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Done only for something that can be a server: empty, or a host Relo would never accept, stays.
    private var valid: Bool {
        guard !trimmed.isEmpty, let url = URL(string: OnboardingView.normalize(trimmed)), url.host() != nil
        else { return false }
        return ServerEndpointPolicy.accepts(url)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("relo.example.com", text: $draft)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL).textContentType(.URL).submitLabel(.done)
                        .focused($focused)
                        .onSubmit(commit)
                        .accessibilityLabel("Server address")
                } footer: {
                    Text("The address you open your Relo dashboard at.")
                }
                Section {
                    Link(destination: guide) {
                        Label("Set up a server", systemImage: "arrow.up.right.square")
                    }
                    .tint(.reloInteractive)
                } footer: {
                    Text("Relo runs on a server you host. The guide walks through it.")
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle("Your Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: commit).fontWeight(.semibold).disabled(!valid)
                }
            }
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
        .presentationBackground(.regularMaterial)
        .onAppear { focused = true }
    }

    private func commit() {
        guard valid else { return }
        save(trimmed)
        dismiss()
    }
}

/// The Now deck's stage without its numbers: dust, glow, plasma core, particle shell and the
/// instrument ring, with the wordmark in the lens. Tap it and a ripple runs through.
private struct ReloWelcomeStage: View {
    let state: ReloSignalState
    let status: String?
    /// While the browser is open the sphere pulses the way a tap makes it.
    var working = false
    @State private var waves: [ReloOrbWave] = []
    @State private var width: CGFloat = 393
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let height: CGFloat = 330
    private let mix = NowMix(counts: [:])

    var body: some View {
        ZStack {
            ReloPlasmaOrb(state: state, mix: mix, wave: waves.last,
                          waveOffset: CGPoint(x: width / 2 - 150, y: height / 2 - 150))
                .frame(width: 300, height: 300)
            ReloSignalOrb(state: state, emissionTrigger: 0, mix: mix, waves: waves,
                          waveOffset: CGPoint(x: width / 2 - 165, y: height / 2 - 165), sparse: true)
                .frame(width: 330, height: 330)
                .opacity(0.75)
            ReloHoloRing(state: state, tasks: [])
                .frame(width: 286, height: 286)
            VStack(spacing: 4) {
                Text("relo")
                    .font(.system(size: 60, weight: .bold, design: .rounded)).tracking(-1)
                    .foregroundStyle(.white)
                    .shadow(color: ReloHoloTheme.accent(for: state).opacity(0.55), radius: 16)
                if let status {
                    HStack(spacing: 6) {
                        Circle().fill(ReloHoloTheme.accent(for: state)).frame(width: 6, height: 6)
                        Text(status)
                            .font(.system(.caption2, design: .monospaced).weight(.semibold)).tracking(2)
                            .foregroundStyle(ReloHoloTheme.accent(for: state))
                            .contentTransition(.numericText())
                    }
                    .lineLimit(1).minimumScaleFactor(0.6)
                    .transition(.opacity)
                }
            }
            .frame(width: 170)
            .animation(reduceMotion ? nil : .smooth(duration: 0.5), value: status)
        }
        .frame(maxWidth: .infinity).frame(height: height)
        .background { ReloDeckField(state: state, mix: mix, waves: waves).allowsHitTesting(false) }
        .background {
            RadialGradient(colors: [ReloHoloTheme.accent(for: state).opacity(0.16),
                                    ReloHoloTheme.accent(for: state).opacity(0.05), .clear],
                           center: .center, startRadius: 40, endRadius: 330)
                // Taller than the stage so the glow reaches clear before an edge cuts it.
                .frame(height: 700)
                .animation(reduceMotion ? nil : .smooth(duration: 0.9), value: state)
                .allowsHitTesting(false)
        }
        .background { GeometryReader { proxy in Color.clear.onAppear { width = proxy.size.width }
            .onChange(of: proxy.size.width) { _, new in width = new } } }
        .coordinateSpace(name: "welcome")
        .contentShape(Rectangle())
        .simultaneousGesture(SpatialTapGesture(coordinateSpace: .named("welcome")).onEnded { value in
            guard !reduceMotion else { return }
            ripple(at: value.location, strength: 1.3)
        })
        .task(id: working) {
            guard working, !reduceMotion else { return }
            // The first pulse a beat after waiting starts, so a quick browser hand-off stays still.
            try? await Task.sleep(for: .milliseconds(800))
            while !Task.isCancelled {
                ripple(at: CGPoint(x: width / 2, y: height / 2), strength: 0.8)
                try? await Task.sleep(for: .seconds(1.8))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Relo")
        .accessibilityValue(status?.capitalized ?? "")
    }

    private func ripple(at point: CGPoint, strength: Double) {
        let now = Date.now
        waves = waves.filter { now.timeIntervalSince($0.at) < 2.6 }.suffix(7)
            + [ReloOrbWave(origin: point, at: now, strength: strength)]
    }
}

/// The Sign in fill: the deck's blue into violet, deep enough for white text, with a highlight
/// that crosses now and then. The highlight is one gradient spanning the whole capsule whose
/// start and end points move (no band view with edges), so the light fades in and out softly.
private struct ReloSignInFill: View {
    var shimmers = true
    /// 0: the highlight waits off the leading edge; 1: it has left past the trailing edge.
    @State private var phase: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private static let deepBlue = Color(red: 0x2A / 255, green: 0x5F / 255, blue: 0xE8 / 255)
    private static let deepViolet = Color(red: 0x66 / 255, green: 0x50 / 255, blue: 0xE6 / 255)
    /// The highlight's width, as a share of the gradient line.
    private let band: CGFloat = 0.3

    var body: some View {
        Capsule()
            .fill(LinearGradient(colors: [Self.deepBlue, Self.deepViolet], startPoint: .leading, endPoint: .trailing))
            .overlay {
                // Both points travel from before the leading edge to beyond the trailing one, the
                // end leading the start by one band, so the highlight is never cut by the shape.
                LinearGradient(stops: [.init(color: .white.opacity(0), location: 0),
                                       .init(color: .white.opacity(0.3), location: 0.5),
                                       .init(color: .white.opacity(0), location: 1)],
                               startPoint: UnitPoint(x: -band + phase * (1 + band), y: 0.2),
                               endPoint: UnitPoint(x: phase * (1 + band), y: 0.8))
                    .clipShape(Capsule())
                    .blendMode(.plusLighter)
                    .opacity(shimmers ? 1 : 0)
            }
            .overlay { Capsule().strokeBorder(LinearGradient(colors: [.white.opacity(0.3), .clear],
                                                             startPoint: .top, endPoint: .center)) }
            .task(id: shimmers) {
                guard shimmers, !reduceMotion else { return }
                try? await Task.sleep(for: .seconds(1.2))
                while !Task.isCancelled {
                    var reset = Transaction(); reset.disablesAnimations = true
                    withTransaction(reset) { phase = 0 }
                    withAnimation(.easeInOut(duration: 1.4)) { phase = 1 }
                    try? await Task.sleep(for: .seconds(5))
                }
            }
    }
}
