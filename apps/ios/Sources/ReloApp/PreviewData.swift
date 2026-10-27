import ReloRuntime
import ReloPersistence
import Foundation
import ReloCore

#if DEBUG
extension AppModel {
    enum PreviewState: Equatable {
        case ready
        case permissionDenied
        case authenticating
        case waitingForAPNs
        case registering
        case registrationFailed
        case empty
        case offline
        case noCacheOffline
        case partialSync
        case reauthenticationRequired
        case disabled
        case signedOut
        case denseHistory
        case responseStates
        case longContent
    }

    static func preview(state: PreviewState) -> AppModel {
        let account = AccountSummary(
            accountId: "acc_preview123456",
            name: "Developer",
            email: "owner@example.com"
        )
        let user = AccountUser(
            id: "better-auth-preview",
            name: account.name,
            email: account.email
        )
        let session = AccountSession(
            accessToken: "preview-account-token",
            sessionId: "preview-session",
            expiresAt: .now.addingTimeInterval(86_400),
            user: user,
            account: account
        )
        let credential = DeviceCredential(
            deviceId: "dev_preview123456",
            installationId: UUID(),
            accessToken: "preview-token-not-for-network-use",
            issuedAt: .now,
            accountId: account.accountId,
            credentialVersion: 1
        )
        let relo = InboxResourceProject(id: "prj_previewrelo", name: "RELO", isDirect: false,
            palette: .init(slot: 0, generation: 1), icon: "code", revision: 1)
        let website = InboxResourceProject(id: "prj_previewwebsite", name: "Website", isDirect: false,
            palette: .init(slot: 1, generation: 1), icon: "folder", revision: 1)
        let infrastructure = InboxResourceProject(id: "prj_previewinfra", name: "Infrastructure", isDirect: false,
            palette: .init(slot: 2, generation: 1), icon: "build", revision: 1)
        let direct = InboxResourceProject(id: "prj_previewdirect", name: "Direct CLI", isDirect: true,
            palette: .init(slot: 0, generation: 1), icon: "terminal", revision: 1)
        func links(_ id: String, _ name: String, _ kind: String,
                   _ project: InboxResourceProject, _ conversation: String?) -> InboxResourceLinks {
            .init(source: .init(id: id, kind: kind, name: name), project: project, conversationId: conversation)
        }
        let context = InboxContext(providerName: "Codex", producerKind: "cli", computer: "MacBook Pro",
            project: "Relo", providerThreadId: "preview-release", threadName: "Release review", account: "Work")
        let research = InboxContext(providerName: "Research agent", producerKind: "agent", computer: "MacBook Pro",
            project: "Relo", providerThreadId: "preview-activity-ui", threadName: "Live Activities", account: "Work")
        let design = InboxContext(providerName: "Design agent", producerKind: "agent", computer: "Mac mini",
            project: "Website", providerThreadId: "preview-homepage", threadName: "Homepage", account: "Personal")
        let build = InboxContext(providerName: "Build pipeline", producerKind: "webhook", computer: "Mac mini",
            project: "Relo", threadName: "Release review")
        var events = [
            InboxItem(id: "evt_server1234", kind: .notification, sourceName: "Codex",
                title: "Idempotency and activity sync are live.", deliveryState: .acceptedByAPNs, createdAt: .now,
                context: .init(providerName: "Codex", producerKind: "cli", computer: "MacBook Pro",
                               project: "Relo", threadName: "Inbox sync"),
                resources: links("src_previewcodex", "Codex", "cli", relo, "cnv_previewsync")),
            InboxItem(id: "evt_codex1234567", kind: .response, sourceName: "Codex",
                title: "Deployment was approved.", result: "Responded", createdAt: .now.addingTimeInterval(-180),
                context: context, resources: links("src_previewcodex", "Codex", "cli", relo, "cnv_previewrelease")),
            InboxItem(id: "evt_backup123456", kind: .notification, sourceName: "Backup service",
                title: "Daily PostgreSQL backup completed.", deliveryState: .acceptedByAPNs, createdAt: .now.addingTimeInterval(-420),
                context: .init(producerKind: "webhook", computer: "Private server", project: "Infrastructure", threadName: "Backups"),
                resources: links("src_previewbackup", "Backup service", "webhook", infrastructure, "cnv_previewbackup")),
            InboxItem(id: "evt_agent1234567", kind: .liveActivity, sourceName: "Research agent",
                title: "Reference audit completed in 42 seconds.", result: "Completed", createdAt: .now.addingTimeInterval(-720),
                context: research, resources: links("src_previewresearch", "Research agent", "agent", relo, "cnv_previewactivityui"),
                activityEvent: .init(id: "act_previewaudit", operation: "end", generation: 1, sequence: 5),
                activity: .init(state: "ended", outcome: "completed", status: "No broken references", progress: 1,
                    steps: .init(done: 4, total: 4, current: nil), updates: 6,
                    startedAt: .now.addingTimeInterval(-2700), endedAt: .now.addingTimeInterval(-720))),
            InboxItem(id: "evt_auditask12345", kind: .liveActivity, sourceName: "Research agent",
                title: "Reference audit", createdAt: .now.addingTimeInterval(-1500),
                interaction: InboxInteraction(id: "int_previewaudit", kind: .approval, prompt: "Fix 3 broken links?",
                    state: .approved, expiresAt: .now.addingTimeInterval(-1200), respondedAt: .now.addingTimeInterval(-1440)),
                context: research, resources: links("src_previewresearch", "Research agent", "agent", relo, "cnv_previewactivityui"),
                activityEvent: .init(id: "act_previewaudit", operation: "update", generation: 1, sequence: 3)),
            InboxItem(id: "evt_shell1234567", kind: .notification, sourceName: "Terminal",
                title: "Command finished successfully.", deliveryState: .acceptedByAPNs, createdAt: .now.addingTimeInterval(-900),
                context: .init(producerKind: "cli", computer: "MacBook Pro"),
                resources: links("src_previewterminal", "Terminal", "cli", direct, nil)),
            InboxItem(id: "evt_monitor12345", kind: .notification, sourceName: "Monitoring service",
                title: "Private APNs worker is healthy.", deliveryState: .acceptedByAPNs, createdAt: .now.addingTimeInterval(-1080),
                context: .init(producerKind: "webhook", computer: "Private server", project: "Infrastructure", threadName: "Service health"),
                resources: links("src_previewmonitor", "Monitoring service", "webhook", infrastructure, "cnv_previewhealth")),
            InboxItem(id: "ntf_previewmessage", kind: .notification, sourceName: "Claude Code", title: "Relo CLI updated",
                content: .init(summary: "CLI 0.7.23 is installed", body: "CLI **0.7.23** is installed: source and project now fill in automatically. Run `relo help` to see the new agent guide.",
                    format: .markdown, byteLength: 140),
                deliveryState: .acceptedByAPNs, apnsAcceptedAt: .now.addingTimeInterval(-178), receivedAt: .now.addingTimeInterval(-177),
                openedAt: .now.addingTimeInterval(-20), createdAt: .now.addingTimeInterval(-180),
                destinationUrl: URL(string: "https://relo.example.com/dashboard"),
                context: .init(providerName: "Claude Code", computer: "Mac", project: "relo", threadName: "CLI identity rework",
                    taskTitle: "Agent-first CLI identity"),
                resources: links("src_previewclaude", "Claude Code", "agent", relo, "cnv_previewcli")),
            InboxItem(id: "ntf_previewapproval", kind: .notification, sourceName: "Codex", title: "Approve the release?",
                detail: "The checks passed. Review the deployment before continuing.", createdAt: .now,
                interaction: InboxInteraction(id: "int_previewapproval", kind: .approval, prompt: "Approve the release?",
                    state: .pending, expiresAt: .now.addingTimeInterval(3600)), context: context,
                resources: links("src_previewcodex", "Codex", "cli", relo, "cnv_previewrelease")),
            InboxItem(id: "ntf_previewyesno", kind: .notification, sourceName: "Research agent", title: "Continue the research?",
                createdAt: .now.addingTimeInterval(-60),
                interaction: InboxInteraction(id: "int_previewyesno", kind: .yesNo, prompt: "Continue?",
                    state: .pending, expiresAt: .now.addingTimeInterval(7200)), context: research,
                resources: links("src_previewresearch", "Research agent", "agent", relo, "cnv_previewactivityui")),
            InboxItem(id: "ntf_previewreply", kind: .notification, sourceName: "Design agent", title: "Which direction should I explore?",
                createdAt: .now.addingTimeInterval(-90),
                interaction: InboxInteraction(id: "int_previewreply", kind: .text, prompt: "Share the next step.",
                    state: .pending, expiresAt: .now.addingTimeInterval(7200)), context: design,
                resources: links("src_previewdesign", "Design agent", "agent", website, "cnv_previewhomepage")),
            InboxItem(id: "ntf_previewworking", kind: .liveActivity, sourceName: "Build CI", title: "Preparing the build",
                createdAt: .now.addingTimeInterval(-120),
                activitySummary: InboxActivitySummary(id: "act_previewworking", conversationId: "cnv_previewrelease",
                    generation: 1, sequence: 2, state: "active", title: "Preparing the build", status: "Testing",
                    progress: 0.42, context: build, staleAt: .now.addingTimeInterval(300), expiresAt: .now.addingTimeInterval(3600)),
                resources: links("src_previewbuild", "Build CI", "webhook", relo, "cnv_previewrelease"),
                activity: .init(state: "active", status: "Testing", steps: .init(done: 2, total: 5, current: "Test"),
                    updates: 3, startedAt: .now.addingTimeInterval(-600)))
        ]
        if state == .denseHistory {
            events += (0..<120).map { index in
                InboxItem(id: "ntf_previewhistory\(index)", kind: .notification, sourceName: "Agent",
                    title: "Build \(index + 1) finished", createdAt: .now.addingTimeInterval(-Double(index + 1) * 2400), context: context)
            }
        }
        if state == .longContent {
            let body = String(repeating: "Review the release notes and verify the changes with the team. ", count: 24)
            events.insert(InboxItem(id: "ntf_previewlong", kind: .notification, sourceName: "Research agent",
                title: "A long task title that must wrap comfortably at every accessibility text size without shrinking",
                content: .init(summary: "Review ready", body: body, format: .text, byteLength: body.utf8.count),
                createdAt: .now, context: .init(computer: "A very long computer name", project: "Research and development", threadName: "A long conversation about the next release")), at: 0)
        }
        let hasAccount = state != .signedOut && state != .authenticating
        let hasCredential = hasAccount && state != .registering && state != .registrationFailed
        let hasNoItems = !hasAccount || state == .empty || state == .registering || state == .noCacheOffline
        let permission: PermissionState
        switch state {
        case .permissionDenied: permission = .denied
        case .authenticating, .waitingForAPNs, .signedOut: permission = .unknown
        default: permission = .allowed
        }
        let accountState: AccountState
        switch state {
        case .authenticating: accountState = .signingIn
        case .reauthenticationRequired: accountState = .reauthenticationRequired
        case .disabled: accountState = .disabled
        case .signedOut: accountState = .signedOut
        default: accountState = .signedIn
        }
        let registrationState: RegistrationState
        switch state {
        case .registering: registrationState = .registering
        case .registrationFailed: registrationState = .failed("This iPhone could not register with Relo server. Retry when the private server is reachable.")
        case .signedOut: registrationState = .idle
        default: registrationState = .registered
        }
        let syncState: SyncState
        switch state {
        case .ready, .denseHistory, .longContent, .responseStates, .empty, .permissionDenied, .waitingForAPNs, .reauthenticationRequired, .disabled:
            syncState = .current
        case .registering: syncState = .syncing
        case .registrationFailed: syncState = .offline("Relo server is offline")
        case .offline, .noCacheOffline: syncState = .offline("Relo server is offline")
        case .partialSync: syncState = .offline("Sync stopped before the next page")
        case .authenticating, .signedOut: syncState = .idle
        }
        let protectedActions = InMemoryProtectedActionStore()

        let model = AppModel(
            accountState: accountState,
            registrationState: registrationState,
            account: hasAccount ? account : nil,
            accountUser: hasAccount ? user : nil,
            credential: hasCredential ? credential : nil,
            permission: permission,
            items: hasNoItems ? [] : events,
            syncState: syncState,
            lastSyncedAt: state == .noCacheOffline ? nil : state == .offline || state == .partialSync ? .now.addingTimeInterval(-3_600) : .now,
            apnsTokenAvailable: state != .waitingForAPNs,
            serverAcceptedCurrentAPNSToken: state != .waitingForAPNs && state != .registering,
            accountSession: hasAccount ? session : nil,
            credentialStore: PreviewCredentialStore(credential: hasCredential ? credential : nil),
            accountSessionStore: PreviewAccountSessionStore(session: hasAccount ? session : nil),
            installationIDStore: PreviewInstallationIDStore(),
            stableDeviceIDStore: PreviewStableDeviceIDStore(),
            pushTokenStore: PreviewPushTokenStore(),
            liveActivityPushToStartTokenStore: PreviewPushTokenStore(),
            registrationAttemptStore: PreviewRegistrationAttemptStore(),
            cache: PreviewAccountScopedCache(snapshot: InboxSnapshot(items: hasNoItems ? [] : events)),
            apiClient: PreviewMobileAPIClient(),
            liveActivityCoordinator: LiveActivityCommandCoordinator(store: protectedActions),
            pendingResponseStore: protectedActions,
            notificationReceiptStore: PreviewNotificationReceiptStore(),
            accountNotificationCleaner: PreviewAccountNotificationCleaner(),
            serverURL: URL(string: "http://192.168.1.10:8180")!
        )
        model.configurePreviewAccountScope()
        if state == .responseStates { model.configurePreviewResponses() }
        return model
    }
}

private struct PreviewCredentialStore: DeviceCredentialStore {
    var credential: DeviceCredential?
    func load() -> DeviceCredential? { credential }
    func save(_ credential: DeviceCredential) {}
    func delete() {}
}

private struct PreviewAccountSessionStore: AccountSessionStore {
    var session: AccountSession?
    func load() -> AccountSession? { session }
    func save(_ session: AccountSession) {}
    func delete() {}
}

private struct PreviewInstallationIDStore: InstallationIDStore {
    var identifier = UUID(uuidString: "6FCBFEF0-19CA-42C4-B931-EEBE1F520DF8")!
    func loadOrCreate() -> UUID { identifier }
}

private struct PreviewStableDeviceIDStore: StableDeviceIDStore {
    var identifier = UUID(uuidString: "11111111-1111-1111-1111-111111111111")!
    func loadOrCreate() -> UUID { identifier }
}

private struct PreviewPushTokenStore: PushTokenStore {
    func load() -> String? { nil }
    func save(_ token: String) {}
    func delete() {}
}

private struct PreviewNotificationReceiptStore: ScopedNotificationReceiptStoring {
    func pending(limit: Int) -> [String] { [] }
    func remove(notificationIDs: Set<String>) {}
}

private struct PreviewAccountNotificationCleaner: AccountNotificationClearing {
    func clearAllDeliveredAndPendingNotifications() async throws {}
}

private struct PreviewRegistrationAttemptStore: RegistrationAttemptStore {
    func attempt(for request: DeviceRegistrationRequest, minimumRevision: Int) -> RegistrationAttempt {
        RegistrationAttempt(revision: minimumRevision, request: request)
    }
    func advanceCurrentAttempt() {}
    func delete() {}
}

private actor PreviewAccountScopedCache: AccountScopedInboxCaching {
    private var snapshot: InboxSnapshot
    init(snapshot: InboxSnapshot) { self.snapshot = snapshot }
    func select(accountId: String) {}
    func boundCache(for accountId: String) -> any InboxCache {
        InMemoryInboxCache(snapshot: snapshot)
    }
    func load() -> InboxSnapshot { snapshot }
    func save(_ snapshot: InboxSnapshot) { self.snapshot = snapshot }
    func clearSelectedAccount() { snapshot = InboxSnapshot() }
}

private struct PreviewMobileAPIClient: MobileAPIClient {
    func validateAccountSession(token: String) async throws -> AccountSession { throw MobileAPIError.unavailable }
    func registerDevice(sessionToken: String, request: DeviceRegistrationRequest, idempotencyKey: String) async throws -> DeviceRegistrationResponse { throw MobileAPIError.unavailable }
    func deviceSelf(credential: DeviceCredential) async throws -> DeviceSelfResponse { throw MobileAPIError.unavailable }
    func heartbeat(credential: DeviceCredential, heartbeat: DeviceHeartbeat) async throws { throw MobileAPIError.unavailable }
    func registerLiveActivityToken(credential: DeviceCredential, activityId: String, registration: LiveActivityTokenRegistration) async throws { throw MobileAPIError.unavailable }
    func submitInteraction(credential: DeviceCredential, notificationId: String, action: NotificationInteractionAction, value: [String: String], idempotencyKey: String) async throws { throw MobileAPIError.unavailable }
    func revokeDevice(credential: DeviceCredential) async throws { throw MobileAPIError.unavailable }
    func signOutAccount(sessionToken: String) async throws { throw MobileAPIError.unavailable }
    func deleteAccount(sessionToken: String, password: String, confirmation: String) async throws { throw MobileAPIError.unavailable }
}

private extension PreviewNotificationReceiptStore {
    func pending(scope: ReceiptScope, limit: Int) async throws -> NotificationReceiptBatch { .init(records: []) }
    func remove(records: Set<NotificationReceiptRecord>) async throws {}
    func retire(scope: ReceiptScope) async throws {}
}
#endif

#if DEBUG
extension AppModel {
    /// Fictional current work for captures: requests, running tasks and recent notices,
    /// decoded through the same wire types the server sends.
    func seedPreviewCurrentWork(clear: Bool = false, now: Date = .now) {
        guard let scope = try? StorageScope(serverOrigin: URL(string: "https://relo.example.test")!,
                                            accountID: "acc_preview123456", deviceID: "dev_preview123456")
        else { return }
        func uuid(_ index: Int) -> String { "11111111-2222-4333-8444-" + String(format: "%012d", index) }
        let iso = ISO8601DateFormatter()
        func at(_ minutes: Double) -> String { iso.string(from: now.addingTimeInterval(minutes * 60)) }
        func subject(_ index: Int, kind: String, title: String, summary: String, source: String,
                     minutesAgo: Double, progress: Double? = nil) -> [String: Any] {
            var value: [String: Any] = [
                "subjectId": "sub_" + uuid(index), "notificationId": "ntf_" + uuid(index), "kind": kind,
                "version": ["generation": 1, "revision": 1], "title": title, "summary": summary, "source": source,
                "createdAt": at(-minutesAgo - 5), "updatedAt": at(-minutesAgo), "occurredAt": at(-minutesAgo),
                "acceptedAt": at(-minutesAgo), "freshUntil": at(20), "deliverUntil": at(60), "freshness": "fresh"]
            if let progress {
                value["activity"] = ["id": "act_" + uuid(index), "generation": 1, "sequence": 3,
                                     "status": "In progress", "progress": progress]
            }
            return value
        }
        let subjects: [[String: Any]] = clear ? [] : [
            subject(1, kind: "progress", title: "Deploying release 0.7.55", summary: "Building the server image",
                    source: "Codex", minutesAgo: 1, progress: 0.64),
            subject(2, kind: "progress", title: "Indexing the design archive", summary: "1,240 of 3,100 files",
                    source: "Research agent", minutesAgo: 4, progress: 0.4),
            subject(3, kind: "notice", title: "Release notes drafted", summary: "", source: "Codex", minutesAgo: 9),
            subject(4, kind: "notice", title: "Nightly backup verified", summary: "", source: "Backup service", minutesAgo: 26),
        ]
        let pending: [[String: Any]] = clear ? [] : [
            ["subjectId": "sub_" + uuid(11), "notificationId": "ntf_" + uuid(11), "kind": "decision",
             "version": ["generation": 1, "revision": 1], "title": "Approve the release?",
             "summary": "All checks passed. Deploy 0.7.55 to production.", "source": "Codex",
             "createdAt": at(-2), "urgencyRank": 0,
             "interaction": ["id": "int_" + uuid(11), "type": "approval", "state": "pending", "expiresAt": at(14)]],
            ["subjectId": "sub_" + uuid(12), "notificationId": "ntf_" + uuid(12), "kind": "decision",
             "version": ["generation": 1, "revision": 1], "title": "Which direction should I explore?",
             "summary": "Two homepage concepts are ready for your pick.", "source": "Design agent",
             "createdAt": at(-6), "urgencyRank": 1,
             "interaction": ["id": "int_" + uuid(12), "type": "text", "state": "pending", "expiresAt": at(52)]],
        ]
        let response: [String: Any] = [
            "items": subjects, "retired": [], "total": subjects.count, "hasMore": false,
            "counts": ["actionable": pending.count, "currentUnread": subjects.count], "serverTime": at(0)]
        let page: [String: Any] = ["items": pending, "total": pending.count, "hasMore": false, "serverTime": at(0)]
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        do {
            var state = CurrentRuntimeState(scope: SessionScope(storage: scope, credentialVersion: 1))
            try state.snapshot.apply(decoder.decode(CurrentInboxResponse.self,
                from: JSONSerialization.data(withJSONObject: response)))
            try state.snapshot.applyPending(decoder.decode(PendingCurrentPage.self,
                from: JSONSerialization.data(withJSONObject: page)), limit: 50)
            state.connection = .current; state.persistence = .available
            state.timeVerified = true; state.countsAreCurrent = true
            state.pendingConnection = .current; state.pendingCountsAreCurrent = true
            state.verifiedVersions = state.snapshot.subjects.mapValues(\.projection.version)
            for entry in state.snapshot.pending?.entries.values ?? [:].values {
                state.verifiedPending[entry.item.id] = entry.observedAt
            }
            previewAcceptCurrentState(state)
        } catch {
            assertionFailure("Preview current work did not decode: \(error)")
        }
        if !clear { seedPreviewSessions(now: now) }
    }

    /// Capture only: sessions on three machines for the header's satellites and machines line and the Now
    /// sessions cards. MacBook Pro has two Claude Code sessions waiting for input and one Codex session working;
    /// The build server has one Claude Code session working on a running card; Studio has two idle sessions.
    func seedPreviewSessions(now: Date = .now) {
        let iso = ISO8601DateFormatter()
        func at(_ minutes: Double) -> String { iso.string(from: now.addingTimeInterval(minutes * 60)) }
        func session(_ id: String, source: String, project: String, computer: String, icon: String, phase: String,
                     waitingFor: String? = nil, title: String, minutesAgo: Double, contextPct: Int? = nil,
                     costUsd: Double? = nil, workId: String? = nil, idle: Bool = false) -> [String: Any] {
            var row: [String: Any] = [
                "id": id, "source": source, "project": project, "computer": computer, "computerIcon": icon,
                "phase": phase, "observed": true, "lastSeenAt": at(-minutesAgo), "title": title]
            if let waitingFor { row["waitingFor"] = waitingFor }
            if let contextPct { row["contextPct"] = contextPct }
            if let costUsd { row["costUsd"] = costUsd }
            if let workId { row["workId"] = workId }
            if idle { row["fold"] = "idle" }
            return row
        }
        let running: [String: Any] = [
            "id": "act_previewrun", "title": "Deploying the server image", "status": "Pushing to the registry",
            "sourceName": "Claude Code", "producer": "agent_session", "sessionId": "ses_preview_buildserver",
            "notificationId": "ntf_previewworking", "computerIcon": "server", "project": "relo",
            "startedAt": at(-22), "declaredAt": at(-1),
            "steps": ["done": 2, "total": 3, "current": "Deploy"],
            "owner": ["state": "moving", "evidenceAt": at(-1), "evidenceSource": "declared", "staleDate": at(19),
                      "lockScreen": "shown", "now": "running", "relevance": 0.9, "apnsPriority": 5]]
        let sessions: [[String: Any]] = [
            session("ses_preview_release", source: "claude-code", project: "relo", computer: "MacBook Pro", icon: "laptop",
                    phase: "waiting", waitingFor: "turn", title: "Mac release", minutesAgo: 3, contextPct: 62, costUsd: 1.84),
            session("ses_preview_header", source: "claude-code", project: "relo", computer: "MacBook Pro", icon: "laptop",
                    phase: "waiting", waitingFor: "input", title: "Now header study", minutesAgo: 1, contextPct: 88, costUsd: 4.10),
            session("ses_preview_limits", source: "codex", project: "relo", computer: "MacBook Pro", icon: "laptop",
                    phase: "working", title: "Rate limits", minutesAgo: 0, contextPct: 31),
            session("ses_preview_buildserver", source: "claude-code", project: "relo", computer: "Build Server", icon: "server",
                    phase: "working", title: "Server deploy", minutesAgo: 0, contextPct: 44, costUsd: 2.37, workId: "act_previewrun"),
            session("ses_preview_studio1", source: "claude-code", project: "docs", computer: "Studio", icon: "desktop",
                    phase: "idle", title: "Docs pass", minutesAgo: 70, idle: true),
            session("ses_preview_studio2", source: "codex", project: "web", computer: "Studio", icon: "desktop",
                    phase: "idle", title: "Landing copy", minutesAgo: 95, idle: true),
        ]
        let summary: [String: Any] = [
            "serverTime": at(0), "refreshAt": at(30),
            "sinceYouLooked": ["since": at(-120), "finished": 0, "failed": 0, "waitingOnYou": 0,
                               "stoppedWithoutFinishing": 0, "needsYou": 0],
            "needsYou": [], "recent": [], "waitingOnYou": [], "running": [running], "quiet": [], "paused": [],
            "folds": ["waitingOnYou": 0, "quiet": 0, "paused": 0],
            "lockScreen": ["cards": [], "needsYouCount": 0],
            "sessions": ["sessions": sessions, "folds": ["idle": 2]]]
        do {
            let data = try JSONSerialization.data(withJSONObject: summary)
            receiveNowSummary(try ReloWireJSON.decoder().decode(NowSummary.self, from: data))
        } catch {
            assertionFailure("Preview sessions did not decode: \(error)")
        }
    }
}

extension AppModel {
    /// Capture only (`--screen sessions` / `--screen since`): settled work for Since you looked (done, failed,
    /// dropped, a script's nightly backup) and for the Quiet and Paused fold, on top of the seeded sessions.
    func seedPreviewSettled(now: Date = .now) {
        guard var summary = nowSummary else { return }
        let iso = ISO8601DateFormatter()
        func at(_ minutes: Double) -> String { iso.string(from: now.addingTimeInterval(minutes * 60)) }
        func item(_ id: String, _ title: String, state: String, status: String?, source: String, project: String?,
                  session: String, minutesAgo: Double, lockScreen: String = "none") -> NowItem? {
            var json: [String: Any] = [
                "id": id, "notificationId": "ntf_" + id, "title": title, "sourceName": source, "producer": source == "script" ? "script" : "agent_session",
                "sessionId": session, "startedAt": at(-minutesAgo - 30), "declaredAt": at(-minutesAgo),
                "owner": ["state": state, "evidenceAt": at(-minutesAgo), "evidenceSource": "declared",
                          "staleDate": at(-minutesAgo + 20), "lockScreen": lockScreen, "relevance": 0.3, "apnsPriority": 5]]
            if let status { json["status"] = status }
            if let project { json["project"] = project }
            return (try? JSONSerialization.data(withJSONObject: json)).flatMap { try? ReloWireJSON.decoder().decode(NowItem.self, from: $0) }
        }
        summary.recent = [
            item("act_prevdone", "Release server 0.18.113", state: "done", status: "Shipped", source: "Claude Code",
                 project: "relo", session: "ses_preview_buildserver", minutesAgo: 20),
            item("act_prevfailed", "Run the iOS layout tests", state: "failed",
                 status: "CardLayoutTests failed: 2 of 41. The simulator was not booted.", source: "Claude Code",
                 project: "relo", session: "ses_preview_release", minutesAgo: 33),
            item("act_prevdropped", "Clean up old worktrees", state: "dropped", status: nil, source: "Claude Code",
                 project: "relo", session: "ses_preview_header", minutesAgo: 55),
            item("act_prevbackup", "Nightly backup", state: "done", status: "Verified", source: "script",
                 project: nil, session: "ses_preview_buildserver", minutesAgo: 110),
        ].compactMap { $0 }
        summary.quiet = [
            item("act_prevquiet1", "Index the design archive", state: "stale", status: "Waiting for the next batch",
                 source: "Claude Code", project: "relo", session: "ses_preview_limits", minutesAgo: 40, lockScreen: "dimmed"),
            item("act_prevquiet2", "Draft the changelog", state: "no_signal", status: nil, source: "Codex",
                 project: "relo", session: "ses_preview_limits", minutesAgo: 75),
        ].compactMap { $0 }
        summary.paused = [
            item("act_prevpaused", "Review the push payload", state: "paused", status: "Waiting for the review",
                 source: "Claude Code", project: "relo", session: "ses_preview_header", minutesAgo: 90),
        ].compactMap { $0 }
        receiveNowSummary(summary)
    }
}

extension AppModel {
    /// Capture only (`--screen cards`): the work cards of the C1 design on the real Now screen. A live question
    /// that the Now summary also lists (joined on its notification id for its project, session and computer), a
    /// your-turn card with a finished plan, and a running card on the build server at its last step.
    func seedPreviewCards(now: Date = .now) {
        guard var summary = nowSummary else { return }
        let iso = ISO8601DateFormatter()
        func at(_ minutes: Double) -> String { iso.string(from: now.addingTimeInterval(minutes * 60)) }
        func item(_ json: [String: Any]) -> NowItem? {
            (try? JSONSerialization.data(withJSONObject: json)).flatMap { try? ReloWireJSON.decoder().decode(NowItem.self, from: $0) }
        }
        let question = item([
            "id": "act_previewquestion", "title": "Approve the release?", "status": "All checks passed.",
            "sourceName": "Claude Code", "producer": "agent_session", "sessionId": "ses_preview_release",
            "notificationId": "ntf_11111111-2222-4333-8444-000000000011", "project": "relo",
            "startedAt": at(-30), "declaredAt": at(-2),
            "owner": ["state": "needs_you", "needsYou": "question", "evidenceAt": at(-2), "evidenceSource": "declared",
                      "staleDate": at(18), "lockScreen": "top", "now": "needs_you", "relevance": 1, "apnsPriority": 10]])
        let turn = item([
            "id": "act_previewturn", "title": "Map the Now header’s states, then improve them",
            "status": "Finished its turn and waits for your reply.",
            "sourceName": "Claude Code", "producer": "agent_session", "sessionId": "ses_preview_header",
            "project": "relo", "startedAt": at(-60), "declaredAt": at(-9),
            "steps": ["done": 4, "total": 4, "current": "Report"],
            "owner": ["state": "waiting_on_you", "evidenceAt": at(-9), "evidenceSource": "declared", "staleDate": at(20),
                      "lockScreen": "your_turn", "now": "waiting_on_you", "relevance": 0.8, "apnsPriority": 5]])
        let running = item([
            "id": "act_previewrun", "title": "Map Relo for Mac’s onboarding and launch, then improve them",
            "status": "Waiting on the deploy", "sourceName": "Claude Code", "producer": "agent_session",
            "sessionId": "ses_preview_buildserver", "notificationId": "ntf_previewworking", "computerIcon": "server",
            "project": "relo", "startedAt": at(-12), "declaredAt": at(-1),
            "steps": ["done": 2, "total": 3, "current": "Deploy", "currentIndex": 3, "fill": 0.0],
            "owner": ["state": "moving", "evidenceAt": at(-1), "evidenceSource": "declared", "staleDate": at(19),
                      "lockScreen": "shown", "now": "running", "relevance": 0.9, "apnsPriority": 5]])
        summary.needsYou = [question].compactMap { $0 }
        summary.waitingOnYou = [turn].compactMap { $0 }
        summary.running = [running].compactMap { $0 }
        summary.sessions.sessions = summary.sessions.sessions.map { row in
            var row = row
            if row.id == "ses_preview_buildserver" { row.title = "Local installable version" }
            return row
        }
        receiveNowSummary(summary)
    }

    /// Capture only: the preview working activity as a Quiet work (session idle since 3:12 PM) in the Now summary,
    /// so its detail offers End work.
    func seedPreviewQuietWork(reason: String = "session_idle", now: Date = .now) {
        let iso = ISO8601DateFormatter()
        func at(_ minutes: Double) -> String { iso.string(from: now.addingTimeInterval(minutes * 60)) }
        let item: [String: Any] = [
            "id": "act_previewquiet", "title": "Preparing the build", "status": "Running the unit tests",
            "sourceName": "Build CI", "producer": "agent_session", "notificationId": "ntf_previewworking",
            "startedAt": at(-95), "declaredAt": at(-48), "quietReason": reason, "quietSince": at(-41),
            "steps": ["done": 2, "total": 5, "current": "Run the unit tests"],
            "owner": ["state": "stale", "evidenceAt": at(-48), "evidenceSource": "declared", "staleDate": at(-28),
                      "lockScreen": "dimmed", "now": "quiet", "relevance": 0.1, "apnsPriority": 5]]
        let summary: [String: Any] = [
            "serverTime": at(0), "refreshAt": at(30),
            "sinceYouLooked": ["since": at(-120), "finished": 0, "failed": 0, "waitingOnYou": 0,
                               "stoppedWithoutFinishing": 0, "needsYou": 0],
            "needsYou": [], "recent": [], "waitingOnYou": [], "running": [], "quiet": [item], "paused": [],
            "folds": ["waitingOnYou": 0, "quiet": 1, "paused": 0],
            "lockScreen": ["cards": [], "needsYouCount": 0],
            "sessions": ["sessions": [], "folds": ["idle": 0]]]
        do {
            let data = try JSONSerialization.data(withJSONObject: summary)
            receiveNowSummary(try ReloWireJSON.decoder().decode(NowSummary.self, from: data))
        } catch {
            assertionFailure("Preview quiet work did not decode: \(error)")
        }
    }
}
#endif
