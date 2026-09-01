import ActivityKit
import ReloCore
import SwiftUI

struct HomeView: View {
    private enum ActivityFilter: String, CaseIterable, Identifiable {
        case all = "All"
        case notifications = "Notifications"
        case liveActivities = "Live Activities"
        case responses = "Responses"
        var id: Self { self }
    }

    @ObservedObject var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var showingSignOutConfirmation = false
    @State private var showingAccountDeletion = false
    @State private var deletionPassword = ""
    @State private var deletionConfirmation = ""
    @State private var email = ""
    @State private var password = ""
    @State private var showingConnectionScanner = false
    @State private var scannedConnectionValue: String?
    @State private var pendingConnectionOrigin: String?
    @State private var showingSettings = false
    @State private var showingProtectedRegistrationReset = false
    @State private var replyingToNotificationID: String?
    @State private var inlineReply = ""
    @State private var inlineRespondingAction: NotificationInteractionAction?
    @State private var selectedProjectID: String?
    @State private var historyState = InboxHistoryPresentationState(
        defaultFilterIdentifier: ActivityFilter.all.rawValue
    )

    var body: some View {
        Group {
            if model.accountState == .restoring || !model.hasLocalAccountAccess {
                authenticationView
            } else {
                signedInView
            }
        }
        .confirmationDialog(
            "Sign out of Relo?",
            isPresented: $showingSignOutConfirmation,
            titleVisibility: .visible
        ) {
            Button("Sign out", role: .destructive) {
                Task { _ = await model.signOut() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This iPhone will stop receiving notifications. Relo server must confirm both account and device revocation before protected activity is removed.")
        }
        .confirmationDialog(
            "Reset this iPhone's Relo registration?",
            isPresented: $showingProtectedRegistrationReset,
            titleVisibility: .visible
        ) {
            Button("Reset device registration", role: .destructive) {
                Task { await model.resetProtectedDeviceRegistration() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes unreadable device identity and cache records. Your authenticated Relo server account and pending responses are preserved.")
        }
        .sheet(isPresented: $showingAccountDeletion, onDismiss: resetAccountDeletionForm) {
            accountDeletionSheet
        }
        .sheet(isPresented: $showingConnectionScanner) {
            NavigationStack {
                ZStack(alignment: .bottom) {
                    ReloConnectionScanner { value in
                        showingConnectionScanner = false
                        do {
                            let document = try ReloConnectionDocument.decode(scannedValue: value)
                            scannedConnectionValue = value
                            pendingConnectionOrigin = document.origin.absoluteString
                        } catch {
                            model.authenticationError = "This is not a valid, unexpired Relo connection QR."
                        }
                    }
                    .ignoresSafeArea(edges: .bottom)
                    Text("Point the camera at a connection QR from Dashboard → Connections.")
                        .font(.footnote.weight(.medium))
                        .multilineTextAlignment(.center)
                        .padding(14)
                        .background(.ultraThinMaterial, in: Capsule())
                        .padding()
                }
                .navigationTitle("Connect to Relo")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showingConnectionScanner = false }
                }}
            }
        }
        .alert("Connect to this Relo server?", isPresented: Binding(
            get: { pendingConnectionOrigin != nil },
            set: { if !$0 { pendingConnectionOrigin = nil } }
        )) {
            Button("Cancel", role: .cancel) { scannedConnectionValue = nil; pendingConnectionOrigin = nil }
            Button("Connect") {
                let value = scannedConnectionValue
                scannedConnectionValue = nil; pendingConnectionOrigin = nil
                if let value { Task { _ = await model.connect(scannedValue: value) } }
            }
        } message: {
            Text(pendingConnectionOrigin ?? "")
        }
        .onChange(of: model.selectedNotificationID) { _, notificationID in
            if notificationID != nil { showingSettings = false }
        }
        .onAppear {
            historyState.transition(to: model.historyScopeIdentity)
        }
        .onChange(of: model.historyScopeIdentity) { _, scopeIdentity in
            historyState.transition(to: scopeIdentity)
            selectedProjectID = nil
        }
    }

    private var authenticationView: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header
                    if model.accountState == .restoring { restoringContent } else { signedOutContent }
                }
                .padding(.horizontal, 24)
                .padding(.top, 22)
                .padding(.bottom, 36)
            }
            .background {
                ZStack {
                    Color.reloCanvas
                    ReloSignalField(intensity: 0.42)
                        .opacity(colorScheme == .dark ? 0.72 : 0.22)
                        .mask {
                            LinearGradient(
                                colors: [.black, .black.opacity(0.4), .clear],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        }
                }
                .ignoresSafeArea()
            }
            .navigationBarHidden(true)
        }
    }

    private var signedInView: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    inboxHeader
                    registeredContent
                }
                .padding(.horizontal, 24)
                .padding(.top, 8)
                .padding(.bottom, 40)
            }
                .background(Color.reloCanvas.ignoresSafeArea())
                .navigationTitle("Inbox")
                .navigationBarTitleDisplayMode(.large)
                .searchable(text: $historyState.searchQuery, prompt: "Search retained activity")
                .refreshable { _ = await model.refresh() }
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            showingSettings = true
                        } label: {
                            Image(systemName: "gearshape")
                        }
                        .accessibilityLabel("Settings")
                    }
                }
                .navigationDestination(isPresented: $showingSettings) {
                    List {
                        settingsContent
                    }
                        .listStyle(.insetGrouped)
                        .scrollContentBackground(.hidden)
                        .background(Color.reloCanvas.ignoresSafeArea())
                        .navigationTitle("Settings")
                        .navigationBarTitleDisplayMode(.large)
                }
                .navigationDestination(
                    isPresented: Binding(
                        get: { model.selectedNotificationID != nil },
                        set: { if !$0 { model.dismissNotification() } }
                    )
                ) {
                    if let item = model.selectedNotification {
                        NotificationDetailView(model: model, item: item)
                    } else {
                        ProgressView("Loading notification…")
                    }
                }
                .onChange(of: historyState.searchQuery) { _, _ in historyState.resetPagination() }
                .onChange(of: historyState.filterIdentifier) { _, _ in historyState.resetPagination() }
                .onChange(of: selectedProjectID) { _, _ in historyState.resetPagination() }
        }
    }

    private var inboxHeader: some View {
        ReloOverviewPanel(
            readiness: readinessLabel,
            readinessSymbol: readinessSymbol,
            activeCount: activeActivityItems.count,
            pendingCount: needsResponseItems.count,
            syncLabel: syncStatusLabel
        )
        .padding(.bottom, 24)
    }

    private var settingsHeader: some View {
        HStack {
            Button {
                showingSettings = false
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(ReloPressButtonStyle())
            .accessibilityLabel("Back to Inbox")
            Spacer()
            Text("Settings")
                .font(.headline)
            Spacer()
            Color.clear.frame(width: 44, height: 44)
                .accessibilityHidden(true)
        }
        .frame(minHeight: 64)
    }

    private var header: some View {
        HStack {
            HStack(spacing: 9) {
                Circle()
                    .fill(Color.reloAccent)
                    .frame(width: 9, height: 9)
                    .accessibilityHidden(true)
                Text("Relo")
                    .font(.system(.subheadline, design: .rounded, weight: .bold))
                    .tracking(1.4)
            }
            Spacer()
            if model.hasLocalAccountAccess {
                Button("Sign out") { showingSignOutConfirmation = true }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(minHeight: 44)
                    .disabled(model.isSigningOut)
            }
        }
        .padding(.bottom, 39)
    }

    private var restoringContent: some View {
        HStack(spacing: 12) {
            ProgressView()
            Text("Restoring your Relo server account and recent activity…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 24)
    }

    private var registeredContent: some View {
        VStack(alignment: .leading, spacing: 20) {
            if case let .offline(message) = model.syncState {
                OfflineBanner(message: message, lastSyncedAt: model.lastSyncedAt) {
                    Task { await model.refresh() }
                }
            }

            if model.pendingResponseCount > 0 {
                Label(
                    "\(model.pendingResponseCount) response\(model.pendingResponseCount == 1 ? "" : "s") waiting to send",
                    systemImage: "arrow.triangle.2.circlepath"
                )
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.orange)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
            }

            pendingResponseSection
            inboxSection(title: "Active now", items: activeActivityItems)

            VStack(alignment: .leading, spacing: 12) {
                recentActivityHeader
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        activityFilterPicker
                        ReloProjectFilterChip(
                            options: projectOptions,
                            selection: $selectedProjectID
                        )
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        activityFilterPicker
                        ReloProjectFilterChip(
                            options: projectOptions,
                            selection: $selectedProjectID
                        )
                    }
                }

                if filteredHistoryItems.isEmpty {
                    EmptyActivityView()
                } else {
                    InboxHierarchyView(groups: InboxHierarchyProjection.groups(for: visibleHistoryItems)) { item in
                        activityButton(item)
                    }
                    if visibleHistoryItems.count < filteredHistoryItems.count {
                        Button("Show 50 more") {
                            historyState.showMore(available: filteredHistoryItems.count)
                        }
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                }
                if visibleHistoryItems.count >= filteredHistoryItems.count && model.historyHasMore {
                    Button {
                        Task { await model.loadOlderHistory() }
                    } label: {
                        if model.isLoadingHistory {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Load older from Relo server")
                        }
                    }
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .disabled(model.isLoadingHistory)
                }
                Text(historyCoverageLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if case let .offline(message) = model.historyLoadState {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        }
    }

    @ViewBuilder
    private var pendingResponseSection: some View {
        if !needsResponseItems.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text("Needs your response").font(.headline)
                    Text(needsResponseItems.count, format: .number)
                        .font(.caption2.weight(.bold).monospacedDigit())
                        .foregroundStyle(.orange)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Color.orange.opacity(0.14), in: Capsule())
                        .accessibilityLabel("\(needsResponseItems.count) pending")
                }
                ForEach(needsResponseItems) { item in
                    pendingResponseRow(item)
                }
            }
        }
    }

    private func pendingResponseRow(_ item: InboxItem) -> some View {
        let isQueued = model.responseIsQueued(for: item.id)
        let feedback = model.responseFeedback(for: item.id)
        let isResponding = model.respondingNotificationID == item.id
        let isReplying = replyingToNotificationID == item.id
        let presentation = InboxPresentationProjection.presentation(for: item)
        let palette = ActivityPresentationPalette(
            presentation: presentation,
            hostColorScheme: colorScheme,
            usesSystemSurfaces: true
        )
        return VStack(alignment: .leading, spacing: 12) {
            Button {
                Task { await model.openNotification(notificationID: item.id) }
            } label: {
                PendingInteractionSummary(item: item)
            }
            .buttonStyle(ReloPressButtonStyle())

            if let feedback {
                Label(
                    inlineResponseStatusText(feedback),
                    systemImage: inlineResponseStatusSymbol(feedback.phase)
                )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.primaryText)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(palette.surface, in: Capsule())
            }
            if !isQueued && feedback?.phase != .accepted, item.interaction != nil {
                if let actions = BinaryNotificationActionPresentation(behavior: presentation.behavior) {
                    HStack(spacing: 10) {
                        inlineActionButton(
                            actions.secondaryLabel,
                            action: actions.secondaryAction,
                            item: item,
                            palette: palette,
                            prominent: false,
                            isResponding: isResponding
                        )
                        inlineActionButton(
                            actions.primaryLabel,
                            action: actions.primaryAction,
                            item: item,
                            palette: palette,
                            prominent: true,
                            isResponding: isResponding
                        )
                    }
                } else if case let .unsupportedTextReply(label, placeholder, maximumLength) = presentation.behavior {
                    let replyLimit = min(maximumLength, NotificationReplyPolicy.maximumUTF16CodeUnits)
                    if isReplying {
                        VStack(alignment: .leading, spacing: 8) {
                            TextField(placeholder ?? "Write a response", text: $inlineReply, axis: .vertical)
                                .textFieldStyle(.plain)
                                .padding(13)
                                .background(palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                                .overlay {
                                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                                        .stroke(palette.primaryText.opacity(0.14), lineWidth: 0.5)
                                }
                                .lineLimit(2...5)
                            HStack {
                                Button("Cancel") {
                                    replyingToNotificationID = nil
                                    inlineReply = ""
                                }
                                .frame(minHeight: 44)
                                Spacer()
                                Text("\(NotificationReplyPolicy.utf16Count(inlineReply))/\(replyLimit)")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(inlineReplyIsValid(maximumLength: replyLimit) ? palette.secondaryText : Color.red)
                                Button {
                                    guard let response = NotificationReplyPolicy.normalized(inlineReply),
                                          inlineReplyIsValid(maximumLength: replyLimit)
                                    else { return }
                                    respondInline(to: item, action: .answer, text: response)
                                } label: {
                                    inlineActionLabel(label, action: .answer, isResponding: isResponding)
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(palette.accent)
                                .disabled(isResponding || !inlineReplyIsValid(maximumLength: replyLimit))
                            }
                        }
                    } else {
                        Button {
                            replyingToNotificationID = item.id
                            inlineReply = ""
                        } label: {
                            Label("Reply", systemImage: "arrow.turn.down.left")
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.bordered)
                        .tint(palette.accent)
                    }
                }
            }
        }
        .padding(18)
        .background {
            ActivityPresentationBackdrop(palette: palette)
        }
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(
                    LinearGradient(
                        colors: [palette.accent.opacity(0.7), palette.secondary.opacity(0.16), .clear],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    lineWidth: 1
                )
        }
        .shadow(color: palette.accent.opacity(0.16), radius: 22, y: 10)
        .tint(palette.accent)
    }

    private func inlineResponseStatusSymbol(_ phase: NotificationResponsePhase) -> String {
        switch phase {
        case .sending: "arrow.up.circle.fill"
        case .queued: "clock.arrow.circlepath"
        case .accepted: "checkmark.circle.fill"
        case .rejected: "exclamationmark.triangle.fill"
        }
    }

    private func inlineResponseStatusText(_ feedback: NotificationResponseFeedback) -> String {
        feedback.phase == .rejected ? "Response not recorded. Try again" : feedback.status
    }

    private func inlineResponseStatusColor(
        _ phase: NotificationResponsePhase,
        item: InboxItem
    ) -> Color {
        switch phase {
        case .sending, .queued, .accepted: ActivityPresentationPalette(item: item).accent
        case .rejected: .red
        }
    }

    private func inlineActionButton(
        _ label: String,
        action: NotificationInteractionAction,
        item: InboxItem,
        palette: ActivityPresentationPalette,
        prominent: Bool,
        isResponding: Bool
    ) -> some View {
        let isLoading = isResponding && inlineRespondingAction == action
        return Button {
            respondInline(to: item, action: action)
        } label: {
            inlineActionLabel(label, action: action, isResponding: isResponding)
        }
        .buttonStyle(ReloDecisionButtonStyle(
            prominent: prominent,
            accent: palette.accent,
            primaryText: palette.primaryText,
            isLoading: isLoading
        ))
        .disabled(isResponding)
    }

    private func inlineReplyIsValid(maximumLength: Int) -> Bool {
        NotificationReplyPolicy.isValid(inlineReply)
            && NotificationReplyPolicy.utf16Count(inlineReply) <= maximumLength
    }

    @ViewBuilder
    private func inlineActionLabel(
        _ label: String,
        action: NotificationInteractionAction,
        isResponding: Bool
    ) -> some View {
        HStack(spacing: 7) {
            if isResponding && inlineRespondingAction == action {
                ProgressView().controlSize(.small)
                Text(inlineResponseInFlightLabel(for: action))
                    .fontWeight(.semibold)
                    .contentTransition(.opacity)
            } else {
                Text(label)
                    .fontWeight(.semibold)
                    .contentTransition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 34)
    }

    private func inlineResponseInFlightLabel(
        for action: NotificationInteractionAction
    ) -> String {
        switch action {
        case .approve: "Approving…"
        case .deny: "Denying…"
        case .yes: "Sending yes…"
        case .no: "Sending no…"
        case .answer, .opened, .received: "Sending…"
        }
    }

    private func respondInline(
        to item: InboxItem,
        action: NotificationInteractionAction,
        text: String? = nil
    ) {
        guard inlineRespondingAction == nil else { return }
        NotificationResponseHaptics.decisionStarted()
        inlineRespondingAction = action
        Task {
            await model.respond(to: item, action: action, text: text)
            if let phase = model.responseFeedback(for: item.id)?.phase {
                NotificationResponseHaptics.responseFinished(phase)
            }
            if model.responseIsQueued(for: item.id) || model.responseIsAccepted(for: item.id) {
                replyingToNotificationID = nil
                inlineReply = ""
            }
            inlineRespondingAction = nil
        }
    }

    private var activityFilterPicker: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(ActivityFilter.allCases) { filter in
                    let selected = historyState.filterIdentifier == filter.rawValue
                    Button(filter.rawValue) {
                        historyState.filterIdentifier = filter.rawValue
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(selected ? Color.white : Color.primary)
                    .padding(.horizontal, 13)
                    .frame(minHeight: 36)
                    .background(selected ? Color.reloAccent : Color.primary.opacity(0.055), in: Capsule())
                    .buttonStyle(ReloPressButtonStyle())
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
        }
        .scrollIndicators(.hidden)
        .accessibilityLabel("Activity filter")
    }

    @ViewBuilder
    private var settingsContent: some View {
        Section("This iPhone") {
            settingsRow("Readiness", value: readinessLabel, symbol: readinessSymbol)
            settingsRow("Notifications", value: notificationStatusLabel, symbol: "bell")
            settingsRow("Device registration", value: registrationStatusLabel, symbol: "iphone")
            settingsRow("Live Activities", value: model.healthSnapshot.liveActivities.label, symbol: "waveform.path.ecg")
            if let liveActivityDetail = model.healthSnapshot.liveActivities.detail {
                Text(liveActivityDetail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if model.permission == .allowed && !model.apnsTokenAvailable {
                settingsRow(
                    "Apple Push token",
                    value: model.cachedAPNSTokenAvailable ? "Cached; awaiting current token" : "Awaiting Apple",
                    symbol: "antenna.radiowaves.left.and.right"
                )
            }
            settingsRow("Inbox sync", value: syncStatusLabel, symbol: "arrow.triangle.2.circlepath")
            settingsRow("Delivery path", value: deliveryPathLabel, symbol: "point.3.connected.trianglepath.dotted")
            if let deliveryPathDetail {
                Text(deliveryPathDetail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let lastSyncedAt = model.lastSyncedAt {
                settingsRow("Last synced", value: lastSyncedAt.formatted(date: .abbreviated, time: .shortened), symbol: "clock")
            }
        }

        if model.requiresReauthentication || model.accountState == .disabled {
            Section("Recovery") {
            if model.requiresReauthentication { reauthenticationCard }
            if model.accountState == .disabled { accountRecoveryCard }
            }
        }

        if model.permission != .allowed || model.pushRegistrationError != nil {
            Section("Notification access") {
            if model.permission == .unknown {
                Button("Allow notifications") { Task { await model.requestNotifications() } }
                    .buttonStyle(.borderedProminent)
                    .tint(.reloAccent)
            } else if model.permission == .denied {
                Button("Open Notification Settings") {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    UIApplication.shared.open(url)
                }
                .buttonStyle(.bordered)
            }

            if let error = model.pushRegistrationError {
                Text("Apple push registration failed: \(error)").font(.footnote).foregroundStyle(.red)
            }
            }
        }

        if case let .failed(message) = model.registrationState {
            Section("Device registration") {
                Text(message).font(.footnote).foregroundStyle(.red)
                Button("Retry device registration") { Task { await model.retryDeviceRegistration() } }
            }
        }

        Section("Account") {
            accountActions
            Text("Services and secret webhook URLs are managed only in the authenticated dashboard. This iPhone never displays or stores those secrets.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }

        Section {
            if let error = model.signOutError { Text(error).font(.footnote).foregroundStyle(.red) }
            Button("Sign out", role: .destructive) { showingSignOutConfirmation = true }
                .disabled(model.isSigningOut)
            if model.canDeleteAccount {
                Button("Delete account permanently", role: .destructive) {
                    model.clearAccountDeletionError()
                    showingAccountDeletion = true
                }
                .disabled(model.isDeletingAccount)
            }
        } footer: {
            Text("Relo server commits account and device revocation before protected data is removed from this iPhone.")
        }
    }

    @ViewBuilder
    private func inboxSection(title: String, items: [InboxItem]) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.headline)
                LazyVStack(spacing: 0) {
                    ForEach(items) { item in
                        activityButton(item)
                        Divider().padding(.leading, 48)
                    }
                }
            }
        }
    }

    private func activityButton(_ item: InboxItem) -> some View {
        Button {
            Task { await model.openNotification(notificationID: item.id) }
        } label: {
            ActivityRow(
                item: item,
                accountID: model.credential?.accountId,
                feedback: model.responseFeedback(for: item.id)
            )
        }
        .buttonStyle(ReloPressButtonStyle())
    }

    private var needsResponseItems: [InboxItem] {
        model.items.filter {
            $0.interaction?.state == .pending
                && ($0.interaction?.expiresAt ?? .distantPast) > .now
                && !model.responseIsAccepted(for: $0.id)
        }
    }

    private var activeActivityItems: [InboxItem] {
        InboxHistoryProjection.activeActivities(model.items)
    }

    private var filteredHistoryItems: [InboxItem] {
        InboxHistoryProjection.collapsedActivities(model.historyItems).filter { item in
            let matchesFilter = switch ActivityFilter(rawValue: historyState.filterIdentifier) ?? .all {
            case .all: true
            case .notifications: item.kind == .notification
            case .liveActivities: item.kind == .liveActivity
            case .responses: item.kind == .response
            }
            guard matchesFilter else { return false }
            guard InboxHierarchyProjection.matchesProject(item, selectedProjectID: selectedProjectID) else {
                return false
            }
            return InboxHistoryProjection.matchesSearch(item, query: historyState.searchQuery)
        }
    }

    private var projectOptions: [InboxProjectIdentity] {
        InboxHierarchyProjection.projectOptions(
            for: InboxHistoryProjection.collapsedActivities(model.historyItems)
        )
    }

    private var visibleHistoryItems: [InboxItem] {
        Array(filteredHistoryItems.prefix(historyState.visibleLimit))
    }

    private var historyCoverageLabel: String {
        if model.historyIsServerBacked {
            let total = model.historyTotal ?? model.historyItems.count
            if model.historyHasMore {
                return "Loaded \(model.historyItems.count) items; Relo server currently reports \(total). Search and filters cover only the loaded window until older activity is loaded."
            }
            if model.historyItems.count == total {
                return "Search and filters cover all \(total) items currently visible to this iPhone on Relo server."
            }
            return "Loaded \(model.historyItems.count) items in this window; Relo server currently reports \(total). Refresh to reconcile activity that changed during pagination."
        }
        return "Offline search and filters cover the \(model.historyItems.count) newest items retained on this iPhone (up to \(InboxHistoryRetention.maximumStoredItems)). Older activity remains on Relo server."
    }

    private var syncStatusLabel: String {
        model.healthSnapshot.inboxSync.label
    }

    private func settingsRow(_ title: String, value: String, symbol: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).foregroundStyle(Color.reloAccent).accessibilityHidden(true)
            Text(title)
            Spacer()
            Text(value).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }

    private var signedOutContent: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Notifications and decisions from your agents, in one private place.")
                .font(.system(.title2, design: .rounded, weight: .bold))
                .fixedSize(horizontal: false, vertical: true)

            Text("Scan a connection QR from your Relo dashboard, or sign in with the same account. This iPhone registers automatically.")
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if case let .failed(message) = model.registrationState {
                VStack(alignment: .leading, spacing: 10) {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                    if model.protectedRegistrationResetAvailable {
                        Button("Reset this iPhone registration", role: .destructive) {
                            showingProtectedRegistrationReset = true
                        }
                    }
                }
            }

            signInFields

            accountActions

            Text("The connection QR confirms which self-hosted Relo server this iPhone will use. You can still sign in manually.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private var recentActivityHeader: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text("History")
                    .font(.title3.weight(.bold))
                Text("Canonical outcomes grouped by project and thread")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                Task { await model.refresh() }
            } label: {
                if model.syncState == .syncing {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Refresh")
                }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(minHeight: 44)
            .disabled(model.syncState == .syncing)
        }
    }

    private var readinessLabel: String {
        model.healthSnapshot.readiness.label
    }

    private var readinessSymbol: String {
        switch readinessLabel {
        case "Ready": "checkmark.circle.fill"
        case "Needs attention": "exclamationmark.triangle.fill"
        case "Offline": "wifi.slash"
        default: "arrow.triangle.2.circlepath"
        }
    }

    private var deliveryPathLabel: String {
        model.healthSnapshot.deliveryPath.label
    }

    private var deliveryPathDetail: String? {
        model.healthSnapshot.deliveryPath.detail
    }

    private var notificationStatusLabel: String {
        switch model.permission {
        case .allowed: "Allowed"
        case .denied: "Off"
        case .unknown: "Permission needed"
        }
    }

    private var registrationStatusLabel: String {
        model.healthSnapshot.registration.label
    }

    private var signInFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                showingConnectionScanner = true
            } label: {
                Label("Scan connection QR", systemImage: "qrcode.viewfinder")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.reloAccent)
            .controlSize(.large)
            .disabled(model.isAuthenticating)

            HStack { Rectangle().frame(height: 1); Text("or sign in").font(.caption); Rectangle().frame(height: 1) }
                .foregroundStyle(.tertiary)

            TextField("Email", text: $email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, 14)
                .frame(minHeight: 50)
                .background(.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            SecureField("Password", text: $password)
                .textContentType(.password)
                .padding(.horizontal, 14)
                .frame(minHeight: 50)
                .background(.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            Button {
                Task {
                    _ = await model.signIn(email: email, password: password)
                    password = ""
                }
            } label: {
                HStack {
                    Text(model.isAuthenticating ? "Signing in…" : "Sign in")
                    Spacer()
                    if model.isAuthenticating { ProgressView().tint(.white) }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.reloAccent)
            .controlSize(.large)
            .disabled(model.isAuthenticating || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.count < 8)

            if let error = model.authenticationError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var reauthenticationCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Sign in again")
                .font(.headline)
            Text("Your cached Recent Activity remains available. Sign in to refresh account registration.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            signInFields
        }
        .padding(16)
        .background(.background, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var accountRecoveryCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Account recovery required")
                .font(.headline)
            Text("This Relo server account is disabled or cannot currently authorize this iPhone. Open the dashboard to recover the account.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .background(.background, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var accountActions: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let email = model.signedInEmail {
                Text("Relo server account")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(email)
                    .font(.subheadline.weight(.medium))
            }
            Link(destination: model.dashboardURL) {
                Label("Open Relo Dashboard", systemImage: "safari")
                    .frame(minHeight: 44)
            }
            .font(.subheadline.weight(.semibold))
        }
    }

    private var accountDeletionSheet: some View {
        NavigationStack {
            Form {
                Section {
                    Text("This permanently deletes your Relo server account, devices, services, notification history, approvals, and sessions. This cannot be undone.")
                        .foregroundStyle(.secondary)
                }
                Section("Confirm your identity") {
                    SecureField("Current password", text: $deletionPassword)
                        .textContentType(.password)
                    TextField("Type DELETE", text: $deletionConfirmation)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                }
                if let error = model.accountDeletionError {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                            .accessibilityLabel("Account deletion error: \(error)")
                    }
                }
                Section {
                    Button("Permanently delete account", role: .destructive) {
                        Task {
                            if await model.deleteAccount(
                                password: deletionPassword,
                                confirmation: deletionConfirmation
                            ) {
                                resetAccountDeletionForm()
                                showingAccountDeletion = false
                            }
                        }
                    }
                    .disabled(
                        model.isDeletingAccount
                            || !AccountDeletionConfirmationPolicy.isValid(
                                password: deletionPassword,
                                confirmation: deletionConfirmation
                            )
                    )
                } footer: {
                    Text("Local protected data is retained unless Relo server commits the deletion.")
                }
            }
            .navigationTitle("Delete account")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(model.isDeletingAccount)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showingAccountDeletion = false }
                        .disabled(model.isDeletingAccount)
                }
            }
        }
    }

    private func resetAccountDeletionForm() {
        deletionPassword = ""
        deletionConfirmation = ""
        model.clearAccountDeletionError()
    }
}

private struct OfflineBanner: View {
    let message: String
    let lastSyncedAt: Date?
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "wifi.slash")
                .foregroundStyle(.orange)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(message).font(.subheadline.weight(.semibold))
                if let lastSyncedAt {
                    Text("Showing activity from \(lastSyncedAt.formatted(date: .abbreviated, time: .shortened)).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Cached activity remains available.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button("Retry", action: retry)
                .font(.subheadline.weight(.semibold))
        }
        .padding(14)
        .background(Color.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct PendingInteractionSummary: View {
    let item: InboxItem
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let presentation = InboxPresentationProjection.presentation(for: item)
        let palette = ActivityPresentationPalette(presentation: presentation, hostColorScheme: colorScheme)
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Image(systemName: presentation.symbol.systemImageName)
                    .foregroundStyle(palette.accent)
                Text(presentation.header ?? item.sourceName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.primaryText)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(presentation.status)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(palette.accent)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(palette.accent.opacity(0.16), in: Capsule())
            }

            Text(presentation.title)
                .font(.title3.weight(.bold))
                .foregroundStyle(palette.primaryText)
                .lineLimit(2)

            if let detail = presentation.subtitle {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(palette.secondaryText)
                    .lineLimit(3)
            }

            if let expiresAt = item.interaction?.expiresAt {
                Label {
                    HStack(spacing: 3) {
                        Text("Expires")
                        Text(expiresAt, style: .relative)
                    }
                } icon: {
                    Image(systemName: "clock")
                }
                .font(.caption)
                .foregroundStyle(palette.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens full notification details")
    }
}

private struct ReloPressButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.68 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

private struct ReloDecisionButtonStyle: ButtonStyle {
    let prominent: Bool
    let accent: Color
    let primaryText: Color
    let isLoading: Bool
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(prominent ? Color.black.opacity(0.78) : primaryText)
            .padding(.horizontal, 12)
            .background(
                prominent ? accent : primaryText.opacity(0.1),
                in: RoundedRectangle(cornerRadius: 11, style: .continuous)
            )
            .overlay {
                if !prominent {
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .stroke(primaryText.opacity(0.16), lineWidth: 0.5)
                }
            }
            .opacity(isLoading ? 1 : isEnabled ? (configuration.isPressed ? 0.78 : 1) : 0.36)
            .scaleEffect(isLoading ? 0.985 : configuration.isPressed ? 0.96 : 1)
            .shadow(
                color: prominent && isEnabled
                    ? accent.opacity(configuration.isPressed ? 0.12 : 0.2)
                    : .clear,
                radius: configuration.isPressed ? 4 : 10,
                y: configuration.isPressed ? 2 : 6
            )
            .animation(
                reduceMotion ? nil : .snappy(duration: 0.2, extraBounce: 0.05),
                value: configuration.isPressed
            )
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.18),
                value: isLoading
            )
    }
}

private struct ActivityRow: View {
    let item: InboxItem
    let accountID: String?
    let feedback: NotificationResponseFeedback?
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let presentation = InboxPresentationProjection.presentation(for: item)
        let palette = ActivityPresentationPalette(presentation: presentation, hostColorScheme: colorScheme)
        HStack(alignment: .top, spacing: 11) {
            SourceAvatar(item: item)
            VStack(alignment: .leading, spacing: 3) {
                Text(presentation.header ?? item.sourceName)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Text(presentation.title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if let originLabel {
                    Text(originLabel)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                if let detail = presentation.subtitle, detail != presentation.title {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                Text(statusLabel)
                    .font(.caption2)
                    .foregroundStyle(statusColor)
                ActivityPresentationVisual(
                    presentation: presentation,
                    palette: palette,
                    accountID: accountID,
                    surface: .row
                )
                .padding(.top, presentation.visual == .none ? 0 : 5)
                if let feedback {
                    Label(
                        feedback.phase == .rejected ? "Response not recorded. Try again" : feedback.status,
                        systemImage: feedbackSymbol(feedback.phase)
                    )
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(feedbackColor(feedback.phase, palette: palette))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(
                        feedbackColor(feedback.phase, palette: palette).opacity(0.12),
                        in: Capsule()
                    )
                    .padding(.top, 4)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 8) {
                if presentation.visual == .none {
                    Text(item.createdAt, style: .time)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                if item.validatedDestinationURL != nil {
                    Image(systemName: "link")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.accent)
                        .accessibilityLabel("Link attached")
                }
            }
        }
        .padding(.vertical, 11)
        .accessibilityElement(children: .combine)
    }

    private var statusLabel: String {
        if let summary = item.activitySummary { return summary.status }
        if item.liveActivity != nil {
            return InboxPresentationProjection.presentation(for: item).status
        }
        if item.openedAt != nil { return "Opened" }
        if item.receivedAt != nil { return "Received on this iPhone" }
        switch item.deliveryState {
        case .acceptedByAPNs: return "Apple accepted; awaiting iPhone"
        case .queued: return "Queued"
        case .sending: return "Sending"
        case .retryable: return "Retrying"
        case .reconciliationRequired: return "Delivery needs reconciliation"
        case .rejected: return "Rejected"
        case .tokenInvalid: return "Device token needs refresh"
        case nil: return item.result ?? item.kind.displayName
        }
    }

    private var statusColor: Color {
        if let state = item.activitySummary?.state {
            switch state {
            case "ended": return .secondary
            case "expired", "replaced": return .orange
            case "active": return .primary
            default: return .secondary
            }
        }
        return switch item.deliveryState {
        case .rejected, .tokenInvalid: .red
        case .retryable, .reconciliationRequired: .orange
        default: item.liveActivity == nil
            ? .secondary
            : ActivityPresentationPalette(item: item).accent
        }
    }

    private var originLabel: String? {
        let context = item.activitySummary?.context ?? item.context
        let values = [context?.computer, context?.project, context?.threadName]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        return values.isEmpty ? nil : values.joined(separator: " · ")
    }

    private func feedbackSymbol(_ phase: NotificationResponsePhase) -> String {
        switch phase {
        case .sending: "arrow.up.circle.fill"
        case .queued: "clock.arrow.circlepath"
        case .accepted: "checkmark.circle.fill"
        case .rejected: "exclamationmark.triangle.fill"
        }
    }

    private func feedbackColor(
        _ phase: NotificationResponsePhase,
        palette: ActivityPresentationPalette
    ) -> Color {
        phase == .rejected ? .red : palette.accent
    }
}

private struct SourceAvatar: View {
    let item: InboxItem

    private var project: InboxProjectIdentity {
        InboxHierarchyProjection.project(for: item)
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Group {
                if let url = item.validatedSourceImageURL {
                    SafeNotificationAvatar(url: url, sourceName: item.sourceName, fallback: AnyView(fallback))
                } else {
                    fallback
                }
            }
            .frame(width: 36, height: 36)
            .clipShape(Circle())
            Circle()
                .fill(Color.reloAccent)
                .frame(width: 8, height: 8)
                .overlay(Circle().stroke(Color.reloBackground, lineWidth: 2))
        }
    }

    private var fallback: some View {
        ZStack {
            Circle().fill(Color.reloAccent.opacity(0.12))
            Image(systemName: project.systemImageName)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.reloAccent)
        }
        .accessibilityLabel(project.isDirect ? "Direct source" : "Project \(project.name)")
    }
}

private struct EmptyActivityView: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "tray")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text("Your agents are quiet")
                .font(.subheadline.weight(.semibold))
            Text("Committed notifications and activity will appear here after the next sync.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 34)
    }
}

private extension Color {
    static let reloAccent = Color(red: 0.04, green: 0.43, blue: 0.34)
    static let reloBackground = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.07, green: 0.08, blue: 0.08, alpha: 1)
            : UIColor(red: 0.97, green: 0.96, blue: 0.94, alpha: 1)
    })
}

#if DEBUG
#Preview("Ready") {
    HomeView(model: .preview(state: .ready))
}

#Preview("Notifications denied") {
    HomeView(model: .preview(state: .permissionDenied))
}

#Preview("Signing in") {
    HomeView(model: .preview(state: .authenticating))
}

#Preview("Waiting for Apple") {
    HomeView(model: .preview(state: .waitingForAPNs))
}

#Preview("Registering") {
    HomeView(model: .preview(state: .registering))
}

#Preview("No recent activity") {
    HomeView(model: .preview(state: .empty))
}

#Preview("Offline") {
    HomeView(model: .preview(state: .offline))
}

#Preview("Partial sync error") {
    HomeView(model: .preview(state: .partialSync))
}

#Preview("Sign in again") {
    HomeView(model: .preview(state: .reauthenticationRequired))
}

#Preview("Registration failed") {
    HomeView(model: .preview(state: .registrationFailed))
}

#Preview("Account recovery") {
    HomeView(model: .preview(state: .disabled))
}

#Preview("Signed out") {
    HomeView(model: .preview(state: .signedOut))
}
#endif
