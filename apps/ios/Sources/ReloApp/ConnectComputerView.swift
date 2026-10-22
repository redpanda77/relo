import ReloCore
import SwiftUI

/// Connect a computer: how (a command, or the owner's agent) and how deep, then the command or prompt with Copy and
/// Share, then the computer, its agents and the first notification as they happen, then the other apps. The same steps
/// as the Dashboard's wizard; it follows the code until the computer reports.
struct ConnectComputerView: View {
    let model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var copied = false
    /// Step 1's third choice: the computer ran relo auth login and shows a code (the Settings → Devices sign-in).
    @State private var showsCode = false
    @State private var scanningSignIn = false
    @State private var signIn: ReloComputerSignIn.Request?
    @State private var numberedSignIn: ReloComputerSignIn.Request?
    @State private var signingIn = false
    @State private var signInProblem: String?

    private var setup: ConnectComputerModel { model.computerSetup }

    private var signInApprover: (any ComputerSignInApproving)? { model.apiClient as? any ComputerSignInApproving }

    private let depths: [(value: String, title: String, detail: String)] = [
        ("notify", "Notify", "Questions and notifications only"),
        ("track", "Track", "Live cards with plans (recommended)"),
        ("guide", "Guide", "Track, plus continuity and sessions (hooks)"),
        ("optimize", "Optimize", "Guide, with lean context"),
    ]

    var body: some View {
        NavigationStack {
            List {
                if setup.pending == nil {
                    howSection
                } else {
                    codeSection
                    progressSections
                }
            }
            .scrollContentBackground(.hidden)
            .reloScreenBackground()
            .navigationTitle("Connect a computer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
        }
        .sheet(isPresented: $scanningSignIn) {
            CodeScannerView(title: "Sign in a computer", hint: "Point the camera at the QR code relo auth login shows on the computer.",
                            source: "the code relo auth login shows",
                            parse: { [serverURL = model.serverURL] in try ReloComputerSignIn.parse($0, server: serverURL) }) { code in
                scanningSignIn = false
                Task { await loadSignIn(code) }
            }
        }
        .sheet(item: $numberedSignIn) { request in
            if let credential = model.credential, let signInApprover {
                ComputerSignInNumberSheet(request: request, credential: credential, approver: signInApprover) { client in
                    await model.shareComputerApproval(client)
                    await model.refreshDevices()
                }
            }
        }
        .reloConfirmation(item: $signIn) { request in
            ReloConfirmSpec(
                title: "Sign in \u{201C}\(request.clientName)\u{201D}?",
                message: "Check that the computer shows \(request.userCode). It will be able to send you cards, questions and notifications.",
                symbol: "laptopcomputer.and.iphone", actionTitle: "Approve", destructive: false,
                alternative: .init(title: "Deny", destructive: true) { await decideSignIn(request, approve: false) },
                action: { await decideSignIn(request, approve: true) })
        }
        .task { setup.restore() }
        // Follows the code while this sheet is up and the app is in front; a push brings the next look sooner.
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled, setup.pending != nil, !setup.progress.isFinished {
                await setup.refresh()
                try? await Task.sleep(for: .seconds(3))
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .reloPushReceived)) { _ in Task { await setup.refresh() } }
    }

    // MARK: Toolbar

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button(setup.pending == nil ? "Cancel" : "Close") { dismiss() }
        }
        if setup.pending != nil, setup.progress.isFinished {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { setup.done(); dismiss() }.fontWeight(.semibold).accessibilityIdentifier("connect-computer-done")
            }
        }
    }

    // MARK: 1. How

    @ViewBuilder private var howSection: some View {
        @Bindable var setup = setup
        Section {
            Picker("How", selection: Binding(
                get: { showsCode ? Route.code : (setup.mode == .command ? .command : .agent) },
                set: { route in
                    showsCode = route == .code
                    if route == .command { setup.mode = .command } else if route == .agent { setup.mode = .agent }
                })) {
                Text("Command").tag(Route.command)
                Text("My agent").tag(Route.agent)
                Text("Shows a code").tag(Route.code)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("connect-computer-how")
            .listRowBackground(Color.clear)
        } footer: {
            Text(showsCode
                 ? "Use this when the computer ran relo auth login and shows a code."
                 : setup.mode == .command
                 ? "One command installs Relo on a computer or server, signs it in and sets up its agents. You paste it where you work, for example over SSH."
                 : "You get a prompt to give your agent. It installs Relo and signs in with a one-time code, never with your password.")
        }
        if showsCode {
            Section {
                Button {
                    scanningSignIn = true
                } label: {
                    if signingIn {
                        HStack { ProgressView(); Text("Signing in…") }.frame(maxWidth: .infinity)
                    } else {
                        Label("Scan or paste the code", systemImage: "qrcode.viewfinder").fontWeight(.semibold).frame(maxWidth: .infinity)
                    }
                }
                .disabled(signingIn || model.credential == nil || signInApprover == nil)
                .accessibilityIdentifier("connect-computer-scan-code")
                if let signInProblem {
                    Text(signInProblem).font(.footnote).foregroundStyle(Color.reloErrorText)
                }
            }
            .listRowBackground(ReloListRowBackground())
        } else {
            commandSections
        }
    }

    private enum Route: Hashable { case command, agent, code }

    @ViewBuilder private var commandSections: some View {
        @Bindable var setup = setup
        Section {
            Picker("Depth", selection: $setup.level) {
                ForEach(depths, id: \.value) { depth in
                    VStack(alignment: .leading) {
                        Text(depth.title)
                        Text(depth.detail).font(.footnote).foregroundStyle(Color.reloSecondaryText)
                    }
                    .tag(depth.value)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } header: { Text("How deep Relo goes there") }
        .listRowBackground(ReloListRowBackground())
        Section {
            DisclosureGroup("Options") { optionRows }
        }
        .listRowBackground(ReloListRowBackground())
        Section {
            Button {
                Task { await setup.make() }
            } label: {
                HStack {
                    if setup.making { ProgressView() }
                    Text(setup.mode == .command ? "Make my command" : "Make my prompt").fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
            }
            .disabled(setup.making || !setup.canMake)
            .accessibilityIdentifier("add-computer-make")
            if let problem = setup.problem {
                Text(problem).font(.footnote).foregroundStyle(Color.reloErrorText)
            }
        }
        .listRowBackground(ReloListRowBackground())
    }

    @ViewBuilder private var optionRows: some View {
        @Bindable var setup = setup
        Toggle("Ask permission on my iPhone too", isOn: $setup.approvals)
        Toggle("On a Mac, also install Relo for Mac", isOn: $setup.macApp)
        Toggle("Every agent it finds", isOn: $setup.allAgents)
        if !setup.allAgents {
            ForEach(ReloComputerSetup.agentIDs, id: \.self) { id in
                Toggle(ReloComputerSetup.agentName(id), isOn: Binding(
                    get: { setup.chosenAgents.contains(id) },
                    set: { on in if on { setup.chosenAgents.insert(id) } else { setup.chosenAgents.remove(id) } }))
            }
            if !setup.canMake {
                Text("Choose at least one agent.").font(.footnote).foregroundStyle(Color.reloSecondaryText)
            }
        }
    }

    // MARK: Sign in by a code the computer shows

    private func loadSignIn(_ code: String) async {
        guard let credential = model.credential, let signInApprover else { return }
        signingIn = true
        signInProblem = nil
        defer { signingIn = false }
        do {
            let request = try await signInApprover.computerSignIn(credential: credential, userCode: code)
            if request.isPending {
                if request.identityKey != nil { numberedSignIn = request } else { signIn = request }
            } else { signInProblem = ReloComputerSignIn.DecisionError.alreadyDecided.localizedDescription }
        } catch {
            signInProblem = (error as? LocalizedError)?.errorDescription ?? "Relo could not reach your server. Try again."
        }
    }

    private func decideSignIn(_ request: ReloComputerSignIn.Request, approve: Bool) async {
        guard let credential = model.credential, let signInApprover else { return }
        signingIn = true
        defer { signingIn = false }
        do {
            try await signInApprover.decideComputerSignIn(credential: credential, userCode: request.userCode, approve: approve)
            if approve {
                signInProblem = nil
                await model.refreshDevices()
                dismiss()
            }
        } catch {
            signInProblem = (error as? LocalizedError)?.errorDescription ?? "Relo could not reach your server. Try again."
        }
    }

    // MARK: 2. Command or prompt

    @ViewBuilder private var codeSection: some View {
        if let text = setup.text, !setup.expired {
            Section {
                Text(text)
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
                    .accessibilityIdentifier("add-computer-command")
                Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") {
                    UIPasteboard.general.string = text
                    copied = true
                }
                ShareLink(item: text) { Label("Share", systemImage: "square.and.arrow.up") }
            } header: {
                Text(setup.pending?.mode == .agent ? "Give this to your agent" : "Paste this on the computer")
            } footer: {
                Text(codeFooter)
            }
            .listRowBackground(ReloListRowBackground())
            if setup.offersCommandInstead() {
                Section {
                    Button("Run it yourself instead") { setup.useCommandInstead() }
                } footer: { Text("Nothing has connected yet. The command uses the same code.") }
                    .listRowBackground(ReloListRowBackground())
            }
        }
    }

    private var codeFooter: String {
        let until = setup.expiryLine ?? "for 30 minutes"
        if setup.pending?.mode == .agent {
            return "Your agent may ask you to allow the command. The code works once, \(until)."
        }
        return "Paste it as the user its agents run as. It works once, \(until)."
    }

    // MARK: 3 to 6. Computer, agents, first notification, apps

    @ViewBuilder private var progressSections: some View {
        let progress = setup.progress
        Section {
            if progress.stage == .expired {
                Label("Code expired", systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.reloAttention)
                Button("New command") { setup.startOver() }
            } else {
                stepRow(done: progress.stage >= .connected, working: progress.stage == .connecting,
                        title: progress.stage >= .connected ? "\(progress.computerName ?? "Computer") connected" : progress.headline,
                        detail: progress.cliVersion.map { "CLI \($0)" })
                if progress.stage >= .connected { agentsRows(progress) }
                let notification = progress.notificationStep
                stepRow(done: notification.done, working: progress.stage == .connected && !progress.needsApproval,
                        title: notification.title, detail: notification.detail)
            }
            keyCheckRow
            approveRow
            if !progress.failingChecks.isEmpty {
                Label("Not everything passed: \(progress.failingChecks.joined(separator: ", ")). Run relo doctor on the computer.",
                      systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote).foregroundStyle(Color.reloAttention)
            }
        } header: { Text("Progress") }
        .listRowBackground(ReloListRowBackground())
        if progress.stage == .tested { appsSection }
    }

    @ViewBuilder private func agentsRows(_ progress: ReloSetupProgress) -> some View {
        ForEach(progress.connectedAgents, id: \.self) { stepRow(done: true, working: false, title: "\($0) connected", detail: nil) }
        ForEach(progress.foundAgents, id: \.self) {
            stepRow(done: false, working: false, title: "\($0) found, not connected", detail: "relo setup --agent connects it")
        }
        if progress.connectedAgents.isEmpty, progress.foundAgents.isEmpty {
            stepRow(done: false, working: false, title: "No agents found here", detail: "relo notify works for scripts")
        }
        if let hint = ReloComputerSetup.restartHint(agents: progress.connectedAgentNames, computer: progress.computerName) {
            Text(hint).font(.footnote).foregroundStyle(Color.reloSecondaryText)
        }
    }

    @ViewBuilder private var keyCheckRow: some View {
        switch setup.keyCheck {
        case .approved:
            Label("Approved on this iPhone", systemImage: "checkmark.shield.fill").font(.footnote).foregroundStyle(Color.reloSecondaryText)
        case .mismatch:
            Label("This computer's key does not match the code, so it was not approved. If you did not just connect it, remove it in Settings → Devices.",
                  systemImage: "exclamationmark.shield.fill")
                .font(.footnote).foregroundStyle(Color.reloErrorText)
        case .pending:
            EmptyView()
        }
    }

    /// The key is here but the binding could not vouch for it: the owner approves it by hand.
    @ViewBuilder private var approveRow: some View {
        if setup.needsManualApproval {
            let name = setup.progress.computerName ?? "the computer"
            VStack(alignment: .leading, spacing: 8) {
                Text("Approve \(name) to read what it sends")
                Button {
                    Task { await setup.approveByHand() }
                } label: {
                    HStack { if setup.approving { ProgressView().tint(.reloOnAction) }; Text("Approve") }
                }
                .buttonStyle(.reloPrimary)
                .disabled(setup.approving)
                .accessibilityIdentifier("connect-computer-approve")
                if let problem = setup.problem { Text(problem).font(.footnote).foregroundStyle(Color.reloErrorText) }
            }
        }
    }

    private func stepRow(done: Bool, working: Bool, title: String, detail: String?) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Group {
                if done { Image(systemName: "checkmark.circle.fill").foregroundStyle(ReloHoloTheme.mint) }
                else if working { ProgressView() }
                else { Image(systemName: "circle.dotted").foregroundStyle(Color.reloSecondaryText) }
            }
            .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if let detail { Text(detail).font(.footnote).foregroundStyle(Color.reloSecondaryText) }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var appsSection: some View {
        Section {
            if let dashboard = URL(string: model.serverURL.absoluteString)?.appendingPathComponent("dashboard") {
                Link(destination: dashboard) { Label("Open the Dashboard", systemImage: "safari") }
            }
            Label("On your Mac, the Relo notch app shows your agents at the top of the screen.", systemImage: "macbook")
                .font(.footnote).foregroundStyle(Color.reloSecondaryText)
        } header: { Text("Relo on your other screens") }
        .listRowBackground(ReloListRowBackground())
    }
}
