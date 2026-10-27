import ActivityKit
import CryptoKit
import Foundation
import OSLog
import ReloCore
import ReloRuntime
import UserNotifications

/// What the applier reads from the app session at the moment it needs it.
@MainActor
struct LiveActivityApplicationContext {
    /// The sync scope that started this pass is still current and the task is not cancelled.
    var isCurrent: @MainActor () -> Bool
    var deviceID: @MainActor () -> String?
    var accountID: @MainActor () -> String?
    var selectedAccountID: @MainActor () -> String?
    var selectionRevision: @MainActor () -> UInt64
}

/// Applies server Live Activity commands to ActivityKit: ordering, convergence, the durable
/// application journal and companion alerts. It holds no state of its own; it lives in the app
/// target because ReloActivityAttributes is compiled into the app and its extensions.
@MainActor
final class LiveActivityApplier {
    private let coordinator: LiveActivityCommandCoordinator
    private let observe: @MainActor (Activity<ReloActivityAttributes>) -> Void
    private let reconnectActivityTokens: @MainActor () -> Void

    init(
        coordinator: LiveActivityCommandCoordinator,
        observe: @escaping @MainActor (Activity<ReloActivityAttributes>) -> Void,
        reconnectActivityTokens: @escaping @MainActor () -> Void
    ) {
        self.coordinator = coordinator
        self.observe = observe
        self.reconnectActivityTokens = reconnectActivityTokens
    }

    func applyPending(
        from items: [InboxItem],
        authoritativeLiveActivities: ActiveLiveActivityIdentityPage? = nil,
        context: LiveActivityApplicationContext
    ) async {
        guard let deviceID = context.deviceID(), context.isCurrent() else { return }
        let selectedAccountID = context.selectedAccountID()
        do {
            let pending = try await coordinator.pending(
                items: items,
                targetDeviceID: deviceID
            )
            guard context.isCurrent() else { return }
            let locallyActive = Set(
                Activity<ReloActivityAttributes>.activities
                    .filter { $0.attributes.accountID == selectedAccountID }
                    .map { $0.attributes.identity }
            )
            let recoveryPlan = LiveActivityReinstallationRecoveryPolicy.plan(
                pending: pending,
                authoritativeCommands: authoritativeLiveActivities?.activities.compactMap(\.recoveryEnvelope) ?? [],
                authoritativeActiveIdentities: Set(
                    authoritativeLiveActivities?.activities.map(\.identity) ?? []
                ),
                locallyActiveIdentities: locallyActive,
                now: .now
            )
            var blockedActivities = Set<LiveActivityIdentity>()
            for envelope in recoveryPlan.commands {
                guard context.isCurrent() else { return }
                guard !blockedActivities.contains(envelope.command.identity) else { continue }
                let isAuthoritativeRecovery = recoveryPlan.recoveryCommandKeys.contains(envelope.commandKey)
                    && !Activity<ReloActivityAttributes>.activities.contains {
                        $0.attributes.accountID == selectedAccountID
                            && $0.attributes.identity == envelope.command.identity
                    }
                let outcome = await apply(
                    envelope,
                    allowsAuthoritativeRecovery: isAuthoritativeRecovery,
                    context: context
                )
                guard context.isCurrent() else { return }
                guard outcome != .failed else {
                    blockedActivities.insert(envelope.command.identity)
                    continue
                }
                if outcome == .ignored {
                    try await coordinator.acknowledge(envelope)
                    continue
                }
                let alertScheduled = try await coordinator.isAlertScheduled(for: envelope)
                guard context.isCurrent() else { return }
                if !isAuthoritativeRecovery && envelope.command.requiresAppAlert && !alertScheduled {
                    guard await scheduleCompanionAlert(
                        envelope.command,
                        companionNotificationID: envelope.eventID
                    ) else {
                        blockedActivities.insert(envelope.command.identity)
                        continue
                    }
                    guard context.isCurrent() else { return }
                    try await coordinator.acknowledgeAlertScheduled(for: envelope)
                }
                try await coordinator.acknowledge(envelope)
            }
        } catch {
            // The Inbox remains authoritative; an unacknowledged command is retried.
        }
    }

    /// Opens again the sealed text of running cards that still show placeholders (their first open failed: the keys were
    /// not ready in that process), and updates them in place. Cheap when nothing needs it: nothing is opened or sent.
    func repairPlaceholderActivities(accountID: String?) async {
        for activity in Activity<ReloActivityAttributes>.activities
        where activity.attributes.accountID == accountID && (activity.activityState == .active || activity.activityState == .stale) {
            let content = activity.content
            guard let repaired = content.state.reopened(cardID: activity.attributes.eventID) else { continue }
            await activity.update(ActivityContent(state: repaired, staleDate: content.staleDate,
                                                  relevanceScore: content.relevanceScore))
        }
    }

    private func apply(
        _ envelope: LiveActivityCommandEnvelope,
        allowsAuthoritativeRecovery: Bool,
        context: LiveActivityApplicationContext
    ) async -> LiveActivityApplicationOutcome {
        let command = envelope.command
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return .failed }
        guard let accountID = context.accountID(), context.isCurrent() else { return .failed }
        let presentation = command.presentation
        let display = command.lockScreenDisplay
        // The card began when its first command arrived; later commands keep the running activity's start.
        let startedAt = Activity<ReloActivityAttributes>.activities
            .first { $0.attributes.identity == command.identity }?.content.state.startedAt
            ?? (command.operation == .start ? envelope.createdAt : nil)

        let state = ReloActivityAttributes.ContentState(
            generation: command.generation,
            updatedAt: envelope.createdAt,
            sequence: command.sequence ?? 0,
            expiresAt: command.expiresAt,
            staleAt: command.staleAt,
            interaction: display.allowsInteraction ? command.interaction.map {
                ReloActivityAttributes.Interaction(
                    id: $0.id,
                    notificationID: $0.notificationId,
                    targetDeviceID: command.targetDeviceId,
                    accountID: accountID,
                    kind: $0.kind.rawValue,
                    state: $0.state.rawValue,
                    credential: $0.credential,
                    expiresAtUnixSeconds: Int64($0.expiresAt.timeIntervalSince1970.rounded(.down))
                )
            } : nil,
            presentation: presentation,
            startedAt: startedAt,
            sealed: command.sealed,
            work: command.work,
            owner: command.owner,
            cardID: command.activityId
        )
        // The server's staleDate (evidence + T_fresh); nil only on an end. The phone invents none.
        let staleDate = command.staleAt
        let content = ActivityContent(
            state: state,
            staleDate: staleDate,
            relevanceScore: command.relevanceScore
        )
        guard let expected = Self.snapshot(
            activityID: command.activityId,
            generation: command.generation,
            state: state,
            isTerminal: command.operation == .end
        ) else { return .failed }
        do {
            let activities = Activity<ReloActivityAttributes>.activities
            let existing = activities.first {
                $0.attributes.identity == command.identity
            }
            if existing == nil,
               activities.contains(where: {
                   $0.attributes.eventID == command.activityId
                       && $0.attributes.generation > command.generation
               }) {
                return .ignored
            }
            let observed = existing.flatMap(Self.snapshot)
            if try await coordinator.applicationJournal(for: envelope) == nil {
                switch command.operation {
                case .start:
                    if existing != nil {
                        guard let observed else { return .failed }
                        let incomingSequence = command.sequence ?? 0
                        if incomingSequence == observed.sequence, observed == expected {
                            try await coordinator.recordExactConvergenceSuccess(
                                for: envelope,
                                observed: observed,
                                expected: expected
                            )
                            return .alreadyCurrent
                        }
                        switch LiveActivityCommandOrderingPolicy.evaluate(
                            operation: command.operation,
                            incomingSequence: incomingSequence,
                            incomingTimestamp: envelope.createdAt,
                            expiresAt: command.expiresAt,
                            observedSequence: observed.sequence,
                            observedTimestamp: existing?.content.state.updatedAt ?? .distantPast,
                            now: .now
                        ) {
                        case .apply: break
                        case .stale: return .ignored
                        case .conflict: return .failed
                        }
                    } else {
                        if try await coordinator.recordObservedSystemConvergenceSuccess(
                            for: envelope,
                            expected: expected
                        ) {
                            return .alreadyCurrent
                        }
                        guard allowsAuthoritativeRecovery || command.permitsLocalStart else { return .failed }
                        guard LiveActivityCommandOrderingPolicy.permitsInitialStart(
                            sequence: command.sequence ?? 0,
                            timestamp: envelope.createdAt,
                            expiresAt: command.expiresAt,
                            now: .now
                        ) else { return .ignored }
                    }
                case .update:
                    guard existing != nil else {
                        if try await coordinator.recordObservedSystemConvergenceSuccess(
                            for: envelope,
                            expected: expected
                        ) {
                            return .alreadyCurrent
                        }
                        guard allowsAuthoritativeRecovery || command.permitsLocalRecovery else { return .failed }
                        guard LiveActivityCommandOrderingPolicy.permitsInitialStart(
                            sequence: command.sequence ?? 0,
                            timestamp: envelope.createdAt,
                            expiresAt: command.expiresAt,
                            now: .now
                        ) else { return .ignored }
                        break
                    }
                    guard let observed else { return .failed }
                    let incomingSequence = command.sequence ?? 0
                    if incomingSequence == observed.sequence, observed == expected {
                        try await coordinator.recordExactConvergenceSuccess(
                            for: envelope,
                            observed: observed,
                            expected: expected
                        )
                        return .alreadyCurrent
                    }
                    switch LiveActivityCommandOrderingPolicy.evaluate(
                        operation: command.operation,
                        incomingSequence: incomingSequence,
                        incomingTimestamp: envelope.createdAt,
                        expiresAt: command.expiresAt,
                        observedSequence: observed.sequence,
                        observedTimestamp: existing?.content.state.updatedAt ?? .distantPast,
                        now: .now
                    ) {
                    case .apply: break
                    case .stale: return .ignored
                    case .conflict: return .failed
                    }
                case .end:
                    guard existing != nil else {
                        if try await coordinator.recordObservedSystemConvergenceSuccess(
                            for: envelope,
                            expected: expected
                        ) {
                            return .alreadyCurrent
                        }
                        return .ignored
                    }
                    guard let observed else { return .failed }
                    if observed == expected, observed.isTerminal {
                        try await coordinator.recordExactConvergenceSuccess(
                            for: envelope,
                            observed: observed,
                            expected: expected
                        )
                        return .alreadyCurrent
                    }
                    if observed.isTerminal { return .ignored }
                    switch LiveActivityCommandOrderingPolicy.evaluate(
                        operation: command.operation,
                        incomingSequence: command.sequence ?? 0,
                        incomingTimestamp: envelope.createdAt,
                        expiresAt: command.expiresAt,
                        observedSequence: observed.sequence,
                        observedTimestamp: existing?.content.state.updatedAt ?? .distantPast,
                        now: .now
                    ) {
                    case .apply: break
                    case .stale: return .ignored
                    case .conflict: return .failed
                    }
                }
            }
            guard context.isCurrent() else { return .failed }
            return await performJournaledLiveActivityMutation(
                envelope,
                accountID: accountID,
                existing: existing,
                content: content,
                expected: expected,
                priorActive: command.operation == .end ? observed : nil,
                observed: observed,
                allowsAuthoritativeRecovery: allowsAuthoritativeRecovery,
                context: context
            )
        } catch {
            return .failed
        }
    }

    private func performJournaledLiveActivityMutation(
        _ envelope: LiveActivityCommandEnvelope,
        accountID: String,
        existing: Activity<ReloActivityAttributes>?,
        content: ActivityContent<ReloActivityAttributes.ContentState>,
        expected: LiveActivitySystemSnapshot,
        priorActive: LiveActivitySystemSnapshot?,
        observed: LiveActivitySystemSnapshot?,
        allowsAuthoritativeRecovery: Bool,
        context: LiveActivityApplicationContext
    ) async -> LiveActivityApplicationOutcome {
        let existingID = existing?.id
        let command = envelope.command
        let expectedRevision = context.selectionRevision()
        return await LiveActivityApplicationOrchestrator.apply(
            coordinator: coordinator,
            envelope: envelope,
            expected: expected,
            priorActive: priorActive,
            observed: observed
        ) {
            guard !Task.isCancelled, context.selectionRevision() == expectedRevision,
                  context.accountID() == accountID else { throw CancellationError() }
            switch command.operation {
            case .start:
                // The server's push may have started this card since `existing` was looked up.
                let raced = Activity<ReloActivityAttributes>.activities.first {
                    $0.attributes.accountID == accountID
                        && $0.attributes.identity == LiveActivityIdentity(activityID: command.activityId, generation: command.generation)
                        && ($0.activityState == .active || $0.activityState == .stale)
                }?.id
                if let nativeID = existingID ?? raced {
                    try await ActivityKitMutationAdapter.update(nativeID: nativeID, content: content)
                } else {
                    let display = command.lockScreenDisplay
                    let style = ReloActivityAttributes.Style(rawValue: display.style) ?? .standard
                    let attributes = ReloActivityAttributes(
                        eventID: command.activityId,
                        generation: command.generation,
                        sourceName: display.sourceName,
                        style: style,
                        accountID: accountID
                    )
                    let activity = try Activity<ReloActivityAttributes>.request(
                        attributes: attributes,
                        content: content,
                        pushType: .token
                    )
                    observe(activity)
                    reconnectActivityTokens()
                }
            case .update:
                if let existingID {
                    try await ActivityKitMutationAdapter.update(nativeID: existingID, content: content)
                } else if allowsAuthoritativeRecovery || command.permitsLocalRecovery {
                    let display = command.lockScreenDisplay
                    let style = ReloActivityAttributes.Style(rawValue: display.style) ?? .standard
                    let attributes = ReloActivityAttributes(
                        eventID: command.activityId,
                        generation: command.generation,
                        sourceName: display.sourceName,
                        style: style,
                        accountID: accountID
                    )
                    let activity = try Activity<ReloActivityAttributes>.request(
                        attributes: attributes,
                        content: content,
                        pushType: .token
                    )
                    observe(activity)
                    reconnectActivityTokens()
                } else {
                    throw LiveActivityCommandCoordinatorError.missingActivity
                }
            case .end:
                guard let existingID else { throw LiveActivityCommandCoordinatorError.missingActivity }
                let dismissal: ActivityUIDismissalPolicy = if let seconds = command.dismissAfterSeconds, seconds > 0 {
                    .after(.now.addingTimeInterval(TimeInterval(seconds)))
                } else {
                    .immediate
                }
                try await ActivityKitMutationAdapter.end(nativeID: existingID, content: content, dismissal: dismissal)
            }
        }
    }

    static func snapshot(
        _ activity: Activity<ReloActivityAttributes>
    ) -> LiveActivitySystemSnapshot? {
        snapshot(
            activityID: activity.attributes.eventID,
            generation: activity.attributes.generation,
            state: activity.content.state,
            isTerminal: activity.activityState == .ended || activity.activityState == .dismissed
        )
    }

    static func snapshot(
        activityID: String,
        generation: Int,
        state: ReloActivityAttributes.ContentState,
        isTerminal: Bool
    ) -> LiveActivitySystemSnapshot? {
        guard state.generation == generation else { return nil }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(LiveActivityContentDigestPayload(state)) else { return nil }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return LiveActivitySystemSnapshot(
            activityID: activityID,
            generation: generation,
            sequence: state.sequence,
            contentDigest: digest,
            isTerminal: isTerminal
        )
    }

    private func scheduleCompanionAlert(
        _ command: LiveActivityCommand,
        companionNotificationID: String
    ) async -> Bool {
        let display = command.lockScreenDisplay
        let notification = UNMutableNotificationContent()
        notification.title = display.headline
        notification.body = [display.status, display.detail].compactMap { $0 }.joined(separator: " · ")
        notification.sound = .default
        notification.threadIdentifier = "relo-live-activities"
        if display.allowsInteraction, let interaction = command.interaction {
            notification.categoryIdentifier = switch interaction.kind {
            case .approval: "RELO_APPROVAL"
            case .yesNo: "RELO_YES_NO"
            case .text: "RELO_TEXT"
            // The companion alert carries no per-question buttons; it opens Relo.
            case .choice: ChoiceNotificationCategoryPolicy.staticCategoryIdentifier
            }
        }
        notification.userInfo = [
            "relo": ["notificationId": command.interaction?.notificationId ?? companionNotificationID]
        ]
        let request = UNNotificationRequest(
            identifier: "\(companionNotificationID).live-activity-companion",
            content: notification,
            trigger: nil
        )
        do {
            try await UNUserNotificationCenter.current().add(request)
            return true
        } catch {
            return false
        }
    }
}

private struct LiveActivityContentDigestPayload: Encodable {
    let headline: String
    let detail: String?
    let progress: Double?
    let status: String
    let sequence: Int
    let style: ReloActivityAttributes.Style
    let symbol: LiveActivitySymbol
    let privacy: ReloActivityAttributes.Privacy
    let accentColor: String
    let expiresAt: Date?
    let staleAt: Date?
    let primaryLabel: String?
    let secondaryLabel: String?
    /// Absent for every non-choice card, so their digests are unchanged.
    let choiceOptions: [InteractionOption]?
    let interaction: ReloActivityAttributes.Interaction?

    init(_ state: ReloActivityAttributes.ContentState) {
        headline = state.headline
        detail = state.detail
        progress = state.progress
        status = state.status
        sequence = state.sequence
        style = state.style
        symbol = state.symbol
        privacy = state.privacy
        accentColor = state.accentColor
        expiresAt = state.expiresAt
        staleAt = state.staleAt
        primaryLabel = state.primaryLabel
        secondaryLabel = state.secondaryLabel
        choiceOptions = state.presentation.behavior.choiceOptions
        interaction = state.interaction
    }
}
