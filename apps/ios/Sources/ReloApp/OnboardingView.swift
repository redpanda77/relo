import ReloCore
import SwiftUI

/// First run, in the Now deck's voice: the same sphere, ring and dust, with the wordmark in the
/// lens where Now shows its count. The sphere rests in Relo's blue, ripples while the browser is
/// open, and turns orange when something went wrong.
struct OnboardingView: View {
    @Bindable var model: AppModel
    @State private var topInset: CGFloat = 59
    @Environment(\.dynamicTypeSize) private var typeSize

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
            Group {
                // One screen, no scrolling: the controls take their height first and the sphere scales
                // into what is left. Only accessibility text sizes, which cannot fit, scroll.
                if typeSize.isAccessibilitySize {
                    ScrollView {
                        VStack(spacing: 0) {
                            ReloWelcomeStage(state: state, status: status, working: model.isAuthenticating)
                                .frame(height: ReloWelcomeStage.fullHeight)
                                .padding(.top, topInset)
                            content.padding(.horizontal, ReloLayout.screenInset)
                        }
                        .padding(.bottom, 32)
                    }
                } else {
                    VStack(spacing: 0) {
                        ReloWelcomeStage(state: state, status: status, working: model.isAuthenticating)
                            .frame(minHeight: 150, maxHeight: ReloWelcomeStage.fullHeight)
                            .padding(.top, topInset)
                            .layoutPriority(0.5)
                        // Room the sphere does not need goes above the controls, keeping them in thumb reach.
                        Spacer(minLength: 0)
                        content.padding(.horizontal, ReloLayout.screenInset)
                            .fixedSize(horizontal: false, vertical: true)
                            .layoutPriority(1)
                    }
                    .padding(.bottom, 8)
                }
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
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Your agents.\nOne calm Inbox.")
                    .font(.system(.title, design: .rounded).weight(.bold))
                    .fixedSize(horizontal: false, vertical: true)
                Text("Get updates, follow work, and respond when your agents need you.")
                    .font(.subheadline).foregroundStyle(Color.reloSecondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            server
            VStack(spacing: 10) {
                if model.appleSignInAvailable && hasServer && model.chosenServerOrigin?.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == normalizedOrigin {
                    AppleSignInRow(model: model)
                }
                HStack(spacing: 10) {
                    Button { signIn() } label: {
                        HStack(spacing: 8) {
                            if model.isAuthenticating { ProgressView().tint(.reloOnAction) }
                            Text(model.isAuthenticating ? "Signing in…" : "Sign in")
                        }
                        .lineLimit(1).minimumScaleFactor(0.8)
                    }
                    .buttonStyle(.reloPrimary)
                    .disabled(!hasServer || model.isAuthenticating)
                    Button { signIn(signUp: true) } label: {
                        Text("Create account").lineLimit(1).minimumScaleFactor(0.8)
                    }
                    .buttonStyle(.reloSecondary)
                    .disabled(!hasServer || model.isAuthenticating)
                    .accessibilityIdentifier("create-account")
                }
                Text("Sign-in opens in the browser. You'll come straight back here.")
                    .font(.caption).foregroundStyle(Color.reloSecondaryText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity)
            if let error = model.authenticationError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline).foregroundStyle(Color.reloErrorText)
                    .fixedSize(horizontal: false, vertical: true)
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
        }
        .onAppear { if origin.isEmpty { origin = model.chosenServerOrigin ?? "" } }
        // The server the owner typed decides whether Sign in with Apple is on offer.
        .task(id: normalizedOrigin) {
            guard hasServer, model.chosenServerOrigin?.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == normalizedOrigin
                    || model.selectServerOrigin(normalizedOrigin) else { return }
            await model.refreshSignInMethods()
        }
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

    private func signIn(signUp: Bool = false) {
        guard hasServer, !model.isAuthenticating else { return }
        if model.chosenServerOrigin?.trimmingCharacters(in: CharacterSet(charactersIn: "/")) != normalizedOrigin {
            guard model.selectServerOrigin(normalizedOrigin) else { return }
        }
        Task { _ = await model.signInWithBrowser(signUp: signUp) }
    }

    /// Where this iPhone signs in: typed by the owner, never filled in for them. One row shows the
    /// address; tapping it opens a sheet to type one, so the keyboard never covers the screen. The
    /// dashboard link sits beside it once the address is valid.
    private var server: some View {
        HStack(spacing: 10) {
            Button { editingServer = true } label: {
                HStack(spacing: 10) {
                    Image(systemName: "server.rack")
                        .font(.footnote.weight(.semibold)).foregroundStyle(Color.reloSecondaryText)
                        .accessibilityHidden(true)
                    if hasServer {
                        // HTTPS is a given, so the row spends its width on the host.
                        Text(normalizedOrigin.replacingOccurrences(of: "https://", with: ""))
                            .font(.system(.callout, design: .monospaced)).foregroundStyle(.white)
                            .lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 0)
                        Text("Change").font(.subheadline.weight(.medium)).foregroundStyle(Color.reloInteractive)
                    } else {
                        Text("Add your server")
                            .font(.callout.weight(.medium)).foregroundStyle(Color.reloInteractive)
                        Spacer(minLength: 0)
                        ReloChevron()
                    }
                }
                .frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(ReloPressStyle())
            .disabled(model.isAuthenticating)
            .accessibilityLabel(hasServer ? "Your server, \(normalizedOrigin)" : "Add your server")
            .accessibilityHint(hasServer ? "Change the server address" : "")
            if let dashboardURL {
                Divider().frame(height: 20).overlay(Color.white.opacity(0.12))
                Link(destination: dashboardURL) {
                    Image(systemName: "arrow.up.right.square")
                        .font(.body.weight(.medium)).foregroundStyle(Color.reloInteractive)
                        .frame(minWidth: 32, minHeight: 44).contentShape(Rectangle())
                }
                .accessibilityLabel("Open dashboard")
                .transition(.opacity)
            }
        }
        .padding(.horizontal, ReloLayout.cardInset).padding(.vertical, 2)
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
        .presentationBackground(Color.reloSurface)
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
    static let fullHeight: CGFloat = 330
    private let height: CGFloat = fullHeight
    private let mix = NowMix(counts: [:])

    /// The stage is drawn at its full size and scaled to the height the screen leaves it, so the
    /// sphere, ring and ripples keep their proportions on every iPhone.
    var body: some View {
        GeometryReader { proxy in
            let scale = min(1, proxy.size.height / height)
            stage
                .frame(width: proxy.size.width / max(scale, 0.01), height: height)
                .scaleEffect(scale)
                .frame(width: proxy.size.width, height: proxy.size.height)
        }
    }

    private var stage: some View {
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
                    .font(.system(size: 60, weight: .bold, design: .rounded)).tracking(-1) // design: the wordmark
                    .foregroundStyle(.white)
                    .shadow(color: ReloHoloTheme.accent(for: state).opacity(0.55), radius: 16)
                if let status {
                    HStack(spacing: 6) {
                        Circle().fill(ReloHoloTheme.accent(for: state)).frame(width: 6, height: 6)
                        ReloMonoLabel(status, color: ReloHoloTheme.accent(for: state))
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
