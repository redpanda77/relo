import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Darwin

public enum LiveActivityResponseRequestError: Error, Equatable, Sendable {
    case invalidConfiguration
}

public enum LiveActivityResponseRequestFactory {
    public static func make(
        response: PendingNotificationResponse,
        apiOrigin: URL
    ) throws -> URLRequest {
        guard
            ServerEndpointPolicy.accepts(apiOrigin),
            response.endpoint == .liveActivity,
            let interactionID = response.interactionID,
            let credential = response.responseCredential,
            ReloIdentifier.isValid(interactionID),
            ReloIdentifier.isValid(response.notificationID),
            ReloIdentifier.isValid(response.deviceID),
            (32...4_096).contains(credential.utf16.count),
            [.approve, .deny, .yes, .no].contains(response.action)
        else { throw LiveActivityResponseRequestError.invalidConfiguration }

        let url = apiOrigin
            .appendingPathComponent("api", isDirectory: true)
            .appendingPathComponent("live-activity-responses", isDirectory: true)
            .appendingPathComponent(interactionID)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = 15
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "notificationId": response.notificationID,
            "deviceId": response.deviceID,
            "action": response.action.rawValue,
            "credential": credential,
            "idempotencyKey": response.idempotencyKey,
        ])
        return request
    }
}

public struct LiveActivityCommandEnvelope: Equatable, Sendable {
    public let eventID: String
    public let createdAt: Date
    public let command: LiveActivityCommand

    public init(eventID: String, createdAt: Date, command: LiveActivityCommand) {
        self.eventID = eventID
        self.createdAt = createdAt
        self.command = command
    }

    public var commandKey: String {
        "\(eventID)|\(command.identity.storageKey)|\(command.sequence ?? 0)|\(command.operation.rawValue)"
    }
}

public struct LiveActivityReinstallationRecoveryPlan: Equatable, Sendable {
    public let commands: [LiveActivityCommandEnvelope]
    public let recoveryCommandKeys: Set<String>

    public init(commands: [LiveActivityCommandEnvelope], recoveryCommandKeys: Set<String>) {
        self.commands = commands
        self.recoveryCommandKeys = recoveryCommandKeys
    }
}

public enum LiveActivityReinstallationRecoveryPolicy {
    public static func plan(
        pending: [LiveActivityCommandEnvelope],
        authoritativeCommands: [LiveActivityCommandEnvelope] = [],
        authoritativeActiveIdentities: Set<LiveActivityIdentity>,
        locallyActiveIdentities: Set<LiveActivityIdentity>,
        now: Date
    ) -> LiveActivityReinstallationRecoveryPlan {
        let missing = authoritativeActiveIdentities.subtracting(locallyActiveIdentities)
        guard !missing.isEmpty else {
            return .init(commands: pending, recoveryCommandKeys: [])
        }

        var newestByIdentity: [LiveActivityIdentity: LiveActivityCommandEnvelope] = [:]
        var seenCommandKeys = Set<String>()
        for envelope in authoritativeCommands + pending
        where seenCommandKeys.insert(envelope.commandKey).inserted
            && missing.contains(envelope.command.identity) {
            guard envelope.command.operation != .end else { continue }
            guard envelope.command.expiresAt.map({ $0 > now }) ?? true else { continue }
            if let current = newestByIdentity[envelope.command.identity] {
                let incoming = envelope.command.sequence ?? 0
                let existing = current.command.sequence ?? 0
                if incoming < existing { continue }
                if incoming == existing, envelope.createdAt < current.createdAt { continue }
                if incoming == existing,
                   envelope.createdAt == current.createdAt,
                   envelope.commandKey < current.commandKey { continue }
            }
            newestByIdentity[envelope.command.identity] = envelope
        }

        let recovery = newestByIdentity.values.sorted {
            if $0.command.activityId != $1.command.activityId {
                return $0.command.activityId < $1.command.activityId
            }
            return $0.command.generation < $1.command.generation
        }
        let recoveryKeys = Set(recovery.map(\.commandKey))
        return .init(
            commands: recovery + pending.filter { !recoveryKeys.contains($0.commandKey) },
            recoveryCommandKeys: recoveryKeys
        )
    }
}

public struct LiveActivitySystemSnapshot: Codable, Equatable, Sendable {
    public let activityID: String
    public let generation: Int
    public let sequence: Int
    public let contentDigest: String
    public let isTerminal: Bool

    public init(
        activityID: String,
        generation: Int,
        sequence: Int,
        contentDigest: String,
        isTerminal: Bool
    ) {
        self.activityID = activityID
        self.generation = generation
        self.sequence = sequence
        self.contentDigest = contentDigest
        self.isTerminal = isTerminal
    }

    public var identity: LiveActivityIdentity {
        LiveActivityIdentity(activityID: activityID, generation: generation)
    }

    private enum CodingKeys: String, CodingKey {
        case activityID, generation, sequence, contentDigest, isTerminal
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        activityID = try values.decode(String.self, forKey: .activityID)
        generation = try values.decodeIfPresent(Int.self, forKey: .generation) ?? 1
        guard generation > 0 else {
            throw DecodingError.dataCorruptedError(
                forKey: .generation,
                in: values,
                debugDescription: "Live Activity generation must be positive"
            )
        }
        sequence = try values.decode(Int.self, forKey: .sequence)
        contentDigest = try values.decode(String.self, forKey: .contentDigest)
        isTerminal = try values.decode(Bool.self, forKey: .isTerminal)
    }
}

public struct LiveActivitySystemObservation: Codable, Equatable, Sendable {
    public let snapshot: LiveActivitySystemSnapshot
    public let contentUpdatedAt: Date
    public let observedAt: Date

    public init(
        snapshot: LiveActivitySystemSnapshot,
        contentUpdatedAt: Date,
        observedAt: Date
    ) {
        self.snapshot = snapshot
        self.contentUpdatedAt = contentUpdatedAt
        self.observedAt = observedAt
    }
}

public struct LiveActivityApplicationJournalEntry: Codable, Equatable, Sendable {
    public enum Phase: String, Codable, Sendable {
        case prepared
        case invocationStarted
        case receiptRecorded
    }

    public let eventID: String
    public let commandKey: String
    public let operation: LiveActivityCommand.Operation
    public let expected: LiveActivitySystemSnapshot
    public let priorActive: LiveActivitySystemSnapshot?
    public var phase: Phase

    public init(
        eventID: String,
        commandKey: String,
        operation: LiveActivityCommand.Operation,
        expected: LiveActivitySystemSnapshot,
        priorActive: LiveActivitySystemSnapshot?,
        phase: Phase = .prepared
    ) {
        self.eventID = eventID
        self.commandKey = commandKey
        self.operation = operation
        self.expected = expected
        self.priorActive = priorActive
        self.phase = phase
    }
}

public enum LiveActivityJournalReconciliation: Equatable, Sendable {
    case apply
    case recordOrReuseReceipt
    case finishWithoutReceipt
    case indeterminate
}

public enum LiveActivityApplicationJournalPolicy {
    /// A journal is created only when the initial observation requires an ActivityKit mutation.
    /// On relaunch, matching start/update content or matching terminal end content proves
    /// convergence. Absence never proves an end succeeded: the disk write immediately before
    /// ActivityKit invocation cannot be atomic with the system call, so that state fails closed.
    public static func reconcile(
        _ journal: LiveActivityApplicationJournalEntry,
        observed: LiveActivitySystemSnapshot?
    ) -> LiveActivityJournalReconciliation {
        if journal.phase == .receiptRecorded {
            return .recordOrReuseReceipt
        }

        switch journal.operation {
        case .start, .update:
            if observed == journal.expected {
                return .recordOrReuseReceipt
            }
            if let observed,
               observed.identity == journal.expected.identity,
               observed.sequence > journal.expected.sequence {
                return .finishWithoutReceipt
            }
            return .apply

        case .end:
            guard journal.priorActive != nil else { return .indeterminate }
            guard let observed else { return .indeterminate }
            if observed.isTerminal {
                return observed == journal.expected
                    ? .recordOrReuseReceipt
                    : .indeterminate
            }
            if observed.identity != journal.expected.identity
                || observed.sequence > journal.expected.sequence {
                return .finishWithoutReceipt
            }
            return .apply
        }
    }
}

public enum LiveActivityApplicationOutcome: Equatable, Sendable {
    case applied
    case alreadyCurrent
    case ignored
    case failed
}

/// This is the production journal → ActivityKit → receipt boundary. The mutation closure is the
/// only ActivityKit-specific step; tests execute this same orchestration with deterministic system
/// state. A failed/terminated mutation leaves its journal retryable, and an ambiguous end remains
/// failed without a receipt or acknowledgement.
public enum LiveActivityApplicationOrchestrator {
    public static func apply(
        coordinator: LiveActivityCommandCoordinator,
        envelope: LiveActivityCommandEnvelope,
        expected: LiveActivitySystemSnapshot,
        priorActive: LiveActivitySystemSnapshot?,
        observed: LiveActivitySystemSnapshot?,
        mutation: () async throws -> Void
    ) async -> LiveActivityApplicationOutcome {
        do {
            if let journal = try await coordinator.applicationJournal(for: envelope) {
                switch LiveActivityApplicationJournalPolicy.reconcile(journal, observed: observed) {
                case .recordOrReuseReceipt:
                    try await coordinator.recordApplicationSuccess(for: envelope)
                    return .applied
                case .finishWithoutReceipt:
                    try await coordinator.discardApplicationJournal(for: envelope)
                    return .ignored
                case .indeterminate:
                    return .failed
                case .apply:
                    break
                }
            } else {
                try await coordinator.prepareApplication(
                    for: envelope,
                    expected: expected,
                    priorActive: priorActive
                )
            }

            try await coordinator.markApplicationInvocationStarted(for: envelope)
            try await mutation()
            try await coordinator.recordApplicationSuccess(for: envelope)
            return .applied
        } catch {
            return .failed
        }
    }
}

public struct LiveActivityCommandLedger: Codable, Equatable, Sendable {
    public var appliedCommandKeys: Set<String>
    public var scheduledAlertCommandKeys: Set<String>
    public var terminalSequenceByActivityIdentity: [String: Int]
    public var pendingReceivedEventIDs: [String]
    public var pendingDismissedActivityIdentities: [LiveActivityIdentity]
    public var applicationJournals: [String: LiveActivityApplicationJournalEntry]
    public var systemObservationsByActivityIdentity: [String: [LiveActivitySystemObservation]]

    public init(
        appliedCommandKeys: Set<String> = [],
        scheduledAlertCommandKeys: Set<String> = [],
        terminalSequenceByActivityIdentity: [String: Int] = [:],
        pendingReceivedEventIDs: [String] = [],
        pendingDismissedActivityIdentities: [LiveActivityIdentity] = [],
        applicationJournals: [String: LiveActivityApplicationJournalEntry] = [:],
        systemObservationsByActivityIdentity: [String: [LiveActivitySystemObservation]] = [:]
    ) {
        self.appliedCommandKeys = appliedCommandKeys
        self.scheduledAlertCommandKeys = scheduledAlertCommandKeys
        self.terminalSequenceByActivityIdentity = terminalSequenceByActivityIdentity
        self.pendingReceivedEventIDs = pendingReceivedEventIDs
        self.pendingDismissedActivityIdentities = pendingDismissedActivityIdentities
        self.applicationJournals = applicationJournals
        self.systemObservationsByActivityIdentity = systemObservationsByActivityIdentity
    }

    private enum CodingKeys: String, CodingKey {
        case appliedCommandKeys, scheduledAlertCommandKeys
        case terminalSequenceByActivityIdentity, pendingReceivedEventIDs
        case pendingDismissedActivityIdentities, applicationJournals, systemObservationsByActivityIdentity
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        appliedCommandKeys = try values.decodeIfPresent(Set<String>.self, forKey: .appliedCommandKeys) ?? []
        scheduledAlertCommandKeys = try values.decodeIfPresent(Set<String>.self, forKey: .scheduledAlertCommandKeys) ?? []
        terminalSequenceByActivityIdentity = try values.decodeIfPresent(
            [String: Int].self,
            forKey: .terminalSequenceByActivityIdentity
        ) ?? [:]
        pendingReceivedEventIDs = try values.decodeIfPresent(
            [String].self,
            forKey: .pendingReceivedEventIDs
        ) ?? []
        pendingDismissedActivityIdentities = try values.decodeIfPresent(
            [LiveActivityIdentity].self,
            forKey: .pendingDismissedActivityIdentities
        ) ?? []
        applicationJournals = try values.decodeIfPresent(
            [String: LiveActivityApplicationJournalEntry].self,
            forKey: .applicationJournals
        ) ?? [:]
        systemObservationsByActivityIdentity = try values.decodeIfPresent(
            [String: [LiveActivitySystemObservation]].self,
            forKey: .systemObservationsByActivityIdentity
        ) ?? [:]
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(appliedCommandKeys, forKey: .appliedCommandKeys)
        try values.encode(scheduledAlertCommandKeys, forKey: .scheduledAlertCommandKeys)
        try values.encode(terminalSequenceByActivityIdentity, forKey: .terminalSequenceByActivityIdentity)
        try values.encode(pendingReceivedEventIDs, forKey: .pendingReceivedEventIDs)
        try values.encode(pendingDismissedActivityIdentities, forKey: .pendingDismissedActivityIdentities)
        try values.encode(applicationJournals, forKey: .applicationJournals)
        try values.encode(systemObservationsByActivityIdentity, forKey: .systemObservationsByActivityIdentity)
    }

}

public protocol AccountScopedLiveActivityLedgerStoring: Sendable {
    func select(accountID: String, deviceID: String) async throws
    func load() async throws -> LiveActivityCommandLedger
    func save(_ ledger: LiveActivityCommandLedger) async throws
    func clearSelectedAccount() async throws
}

public actor LiveActivityCommandCoordinator {
    private let store: any AccountScopedLiveActivityLedgerStoring

    public init(store: any AccountScopedLiveActivityLedgerStoring) {
        self.store = store
    }

    public func select(accountID: String, deviceID: String) async throws {
        try await store.select(accountID: accountID, deviceID: deviceID)
    }

    public func pending(items: [InboxItem], targetDeviceID: String) async throws -> [LiveActivityCommandEnvelope] {
        var ledger = try await store.load()
        var changed = false
        let candidates = items.compactMap { item -> LiveActivityCommandEnvelope? in
            guard
                let command = item.liveActivity,
                command.targetDeviceId == targetDeviceID
            else { return nil }
            let envelope = LiveActivityCommandEnvelope(eventID: item.id, createdAt: item.createdAt, command: command)
            guard !ledger.appliedCommandKeys.contains(envelope.commandKey) else { return nil }
            if ledger.terminalSequenceByActivityIdentity[command.identity.storageKey] != nil {
                ledger.appliedCommandKeys.insert(envelope.commandKey)
                changed = true
                return nil
            }
            return envelope
        }
        if changed { try await store.save(ledger) }
        return candidates.sorted { lhs, rhs in
            if lhs.command.activityId != rhs.command.activityId {
                return lhs.command.activityId < rhs.command.activityId
            }
            if lhs.command.generation != rhs.command.generation {
                return lhs.command.generation < rhs.command.generation
            }
            let leftSequence = lhs.command.sequence ?? 0
            let rightSequence = rhs.command.sequence ?? 0
            if leftSequence != rightSequence { return leftSequence < rightSequence }
            let rank: (LiveActivityCommand.Operation) -> Int = { operation in
                switch operation { case .start: 0; case .update: 1; case .end: 2 }
            }
            if rank(lhs.command.operation) != rank(rhs.command.operation) {
                return rank(lhs.command.operation) < rank(rhs.command.operation)
            }
            return lhs.createdAt < rhs.createdAt
        }
    }

    public func applicationJournal(
        for envelope: LiveActivityCommandEnvelope
    ) async throws -> LiveActivityApplicationJournalEntry? {
        try await store.load().applicationJournals[envelope.commandKey]
    }

    public func prepareApplication(
        for envelope: LiveActivityCommandEnvelope,
        expected: LiveActivitySystemSnapshot,
        priorActive: LiveActivitySystemSnapshot?
    ) async throws {
        var ledger = try await store.load()
        let proposed = LiveActivityApplicationJournalEntry(
            eventID: envelope.eventID,
            commandKey: envelope.commandKey,
            operation: envelope.command.operation,
            expected: expected,
            priorActive: priorActive
        )
        if let existing = ledger.applicationJournals[envelope.commandKey] {
            guard existing.eventID == proposed.eventID,
                  existing.operation == proposed.operation,
                  existing.expected == proposed.expected,
                  existing.priorActive == proposed.priorActive
            else { throw LiveActivityCommandCoordinatorError.journalConflict }
            return
        }
        ledger.applicationJournals[envelope.commandKey] = proposed
        try await store.save(ledger)
    }

    public func markApplicationInvocationStarted(
        for envelope: LiveActivityCommandEnvelope
    ) async throws {
        var ledger = try await store.load()
        guard var journal = ledger.applicationJournals[envelope.commandKey] else {
            throw LiveActivityCommandCoordinatorError.missingApplicationJournal
        }
        if journal.phase == .prepared {
            journal.phase = .invocationStarted
            ledger.applicationJournals[envelope.commandKey] = journal
            try await store.save(ledger)
        }
    }

    public func recordApplicationSuccess(
        for envelope: LiveActivityCommandEnvelope
    ) async throws {
        var ledger = try await store.load()
        guard var journal = ledger.applicationJournals[envelope.commandKey] else {
            throw LiveActivityCommandCoordinatorError.missingApplicationJournal
        }
        guard journal.phase != .receiptRecorded else { return }
        journal.phase = .receiptRecorded
        ledger.applicationJournals[envelope.commandKey] = journal
        if !ledger.pendingReceivedEventIDs.contains(envelope.eventID) {
            ledger.pendingReceivedEventIDs.append(envelope.eventID)
        }
        try await store.save(ledger)
    }

    /// Records an exact-event receipt for a start/update command whose ActivityKit state is
    /// already byte-for-byte converged. Terminal absence and stale/lower-sequence observations
    /// are deliberately ineligible because they cannot prove this event was applied.
    public func recordExactConvergenceSuccess(
        for envelope: LiveActivityCommandEnvelope,
        observed: LiveActivitySystemSnapshot,
        expected: LiveActivitySystemSnapshot
    ) async throws {
        let terminalMatchesOperation = envelope.command.operation == .end
            ? observed.isTerminal
            : !observed.isTerminal
        guard observed == expected,
              terminalMatchesOperation,
              observed.identity == envelope.command.identity
        else { throw LiveActivityCommandCoordinatorError.journalConflict }
        var ledger = try await store.load()
        if !ledger.pendingReceivedEventIDs.contains(envelope.eventID) {
            ledger.pendingReceivedEventIDs.append(envelope.eventID)
            try await store.save(ledger)
        }
    }

    public func recordSystemObservation(
        _ observation: LiveActivitySystemObservation
    ) async throws {
        guard ReloIdentifier.isValid(observation.snapshot.activityID),
              observation.snapshot.generation > 0,
              observation.snapshot.sequence >= 0,
              observation.contentUpdatedAt.timeIntervalSince1970 >= 0,
              observation.contentUpdatedAt <= observation.observedAt.addingTimeInterval(300)
        else { throw LiveActivityCommandCoordinatorError.journalConflict }
        var ledger = try await store.load()
        let identityKey = observation.snapshot.identity.storageKey
        var history = ledger.systemObservationsByActivityIdentity[identityKey] ?? []
        if let existing = history.last {
            if existing.snapshot.isTerminal { return }
            if observation.snapshot.sequence < existing.snapshot.sequence { return }
            if observation.snapshot.sequence == existing.snapshot.sequence,
               observation.contentUpdatedAt < existing.contentUpdatedAt {
                return
            }
        }
        if !history.contains(observation) {
            history.append(observation)
        }
        ledger.systemObservationsByActivityIdentity[identityKey] = Array(history.suffix(16))
        let retained = ledger.systemObservationsByActivityIdentity.values
            .flatMap { $0 }
            .sorted { $0.observedAt > $1.observedAt }
            .prefix(256)
        ledger.systemObservationsByActivityIdentity = Dictionary(grouping: retained) {
            $0.snapshot.identity.storageKey
        }.mapValues { $0.sorted { $0.observedAt < $1.observedAt } }
        try await store.save(ledger)
    }

    public func systemObservation(
        identity: LiveActivityIdentity
    ) async throws -> LiveActivitySystemObservation? {
        try await store.load().systemObservationsByActivityIdentity[identity.storageKey]?.last
    }

    public func recordObservedSystemConvergenceSuccess(
        for envelope: LiveActivityCommandEnvelope,
        expected: LiveActivitySystemSnapshot
    ) async throws -> Bool {
        var ledger = try await store.load()
        let terminalMatchesOperation: (LiveActivitySystemObservation) -> Bool = { observation in
            envelope.command.operation == .end
                ? observation.snapshot.isTerminal
                : !observation.snapshot.isTerminal
        }
        guard ledger.systemObservationsByActivityIdentity[envelope.command.identity.storageKey]?.contains(where: {
            $0.snapshot == expected && terminalMatchesOperation($0)
        }) == true else { return false }
        if !ledger.pendingReceivedEventIDs.contains(envelope.eventID) {
            ledger.pendingReceivedEventIDs.append(envelope.eventID)
            try await store.save(ledger)
        }
        return true
    }

    public func discardApplicationJournal(for envelope: LiveActivityCommandEnvelope) async throws {
        var ledger = try await store.load()
        guard ledger.applicationJournals.removeValue(forKey: envelope.commandKey) != nil else { return }
        try await store.save(ledger)
    }

    public func acknowledge(_ envelope: LiveActivityCommandEnvelope) async throws {
        var ledger = try await store.load()
        if envelope.command.requiresAppAlert,
           !ledger.scheduledAlertCommandKeys.contains(envelope.commandKey) {
            throw LiveActivityCommandCoordinatorError.requiredAlertNotScheduled
        }
        ledger.appliedCommandKeys.insert(envelope.commandKey)
        if envelope.command.operation == .end {
            let sequence = envelope.command.sequence ?? 0
            let identityKey = envelope.command.identity.storageKey
            ledger.terminalSequenceByActivityIdentity[identityKey] = max(
                ledger.terminalSequenceByActivityIdentity[identityKey] ?? 0,
                sequence
            )
        }
        ledger.applicationJournals.removeValue(forKey: envelope.commandKey)
        try await store.save(ledger)
    }

    public func pendingReceivedEventIDs(limit: Int) async throws -> [String] {
        guard limit > 0 else { return [] }
        return Array(try await store.load().pendingReceivedEventIDs.prefix(limit))
    }

    public func removeReceivedEventIDs(_ eventIDs: Set<String>) async throws {
        guard !eventIDs.isEmpty else { return }
        var ledger = try await store.load()
        ledger.pendingReceivedEventIDs.removeAll { eventIDs.contains($0) }
        try await store.save(ledger)
    }

    public func recordPresentationDismissal(identity: LiveActivityIdentity) async throws {
        guard identity.isValid else {
            throw LiveActivityCommandCoordinatorError.journalConflict
        }
        var ledger = try await store.load()
        if !ledger.pendingDismissedActivityIdentities.contains(identity) {
            ledger.pendingDismissedActivityIdentities.append(identity)
            try await store.save(ledger)
        }
    }

    public func pendingDismissedActivityIdentities(limit: Int) async throws -> [LiveActivityIdentity] {
        guard limit > 0 else { return [] }
        return Array(try await store.load().pendingDismissedActivityIdentities.prefix(limit))
    }

    public func removeDismissedActivityIdentities(_ identities: Set<LiveActivityIdentity>) async throws {
        guard !identities.isEmpty else { return }
        var ledger = try await store.load()
        ledger.pendingDismissedActivityIdentities.removeAll { identities.contains($0) }
        try await store.save(ledger)
    }

    public func isAlertScheduled(for envelope: LiveActivityCommandEnvelope) async throws -> Bool {
        try await store.load().scheduledAlertCommandKeys.contains(envelope.commandKey)
    }

    public func acknowledgeAlertScheduled(for envelope: LiveActivityCommandEnvelope) async throws {
        var ledger = try await store.load()
        ledger.scheduledAlertCommandKeys.insert(envelope.commandKey)
        try await store.save(ledger)
    }

    public func clearSelectedAccount() async throws {
        try await store.clearSelectedAccount()
    }
}

public enum LiveActivityCommandCoordinatorError: Error, Equatable {
    case requiredAlertNotScheduled
    case missingApplicationJournal
    case journalConflict
    case missingActivity
}

public enum PendingResponseEndpoint: String, Codable, Equatable, Sendable {
    case notification
    case liveActivity
}

public struct PendingNotificationResponse: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let accountID: String
    public let deviceID: String
    public let notificationID: String
    public let action: NotificationInteractionAction
    public let value: [String: String]
    public let idempotencyKey: String
    public let expiresAt: Date
    public let endpoint: PendingResponseEndpoint
    public let activityID: String?
    public let activityGeneration: Int?
    public let interactionID: String?
    public let responseCredential: String?

    public init(
        accountID: String,
        deviceID: String,
        notificationID: String,
        action: NotificationInteractionAction,
        value: [String: String],
        idempotencyKey: String,
        expiresAt: Date,
        endpoint: PendingResponseEndpoint = .notification,
        activityID: String? = nil,
        activityGeneration: Int? = nil,
        interactionID: String? = nil,
        responseCredential: String? = nil
    ) {
        self.id = idempotencyKey
        self.accountID = accountID
        self.deviceID = deviceID
        self.notificationID = notificationID
        self.action = action
        self.value = value
        self.idempotencyKey = idempotencyKey
        self.expiresAt = expiresAt
        self.endpoint = endpoint
        self.activityID = activityID
        self.activityGeneration = activityGeneration
        self.interactionID = interactionID
        self.responseCredential = responseCredential
    }


    public var decisionKey: String {
        switch endpoint {
        case .notification: "notification|\(notificationID)"
        case .liveActivity:
            "live-activity|\(activityID ?? "missing")|\(activityGeneration ?? 0)|\(interactionID ?? notificationID)"
        }
    }

    public static func liveActivity(
        accountID: String,
        deviceID: String,
        notificationID: String,
        activityID: String,
        activityGeneration: Int,
        interactionID: String,
        action: NotificationInteractionAction,
        credential: String,
        expiresAt: Date
    ) -> PendingNotificationResponse {
        PendingNotificationResponse(
            accountID: accountID,
            deviceID: deviceID,
            notificationID: notificationID,
            action: action,
            value: [:],
            idempotencyKey: "live-activity:\(activityID):\(activityGeneration):\(interactionID):\(action.rawValue)",
            expiresAt: expiresAt,
            endpoint: .liveActivity,
            activityID: activityID,
            activityGeneration: activityGeneration,
            interactionID: interactionID,
            responseCredential: credential
        )
    }

    private enum CodingKeys: String, CodingKey {
        case id, accountID, deviceID, notificationID, action, value, idempotencyKey, expiresAt
        case endpoint, activityID, activityGeneration, interactionID, responseCredential
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        accountID = try values.decode(String.self, forKey: .accountID)
        deviceID = try values.decode(String.self, forKey: .deviceID)
        notificationID = try values.decode(String.self, forKey: .notificationID)
        action = try values.decode(NotificationInteractionAction.self, forKey: .action)
        value = try values.decode([String: String].self, forKey: .value)
        idempotencyKey = try values.decode(String.self, forKey: .idempotencyKey)
        expiresAt = try values.decode(Date.self, forKey: .expiresAt)
        endpoint = try values.decodeIfPresent(PendingResponseEndpoint.self, forKey: .endpoint) ?? .notification
        activityID = try values.decodeIfPresent(String.self, forKey: .activityID)
        let decodedGeneration = try values.decodeIfPresent(Int.self, forKey: .activityGeneration)
        activityGeneration = endpoint == .liveActivity ? decodedGeneration ?? 1 : decodedGeneration
        if let activityGeneration, activityGeneration <= 0 {
            throw DecodingError.dataCorruptedError(
                forKey: .activityGeneration,
                in: values,
                debugDescription: "Live Activity generation must be positive"
            )
        }
        interactionID = try values.decodeIfPresent(String.self, forKey: .interactionID)
        responseCredential = try values.decodeIfPresent(String.self, forKey: .responseCredential)
    }
}

public enum PendingResponseEnqueueResult: Equatable, Sendable {
    case enqueued
    case alreadyPending(PendingNotificationResponse)
    case alreadyConfirmed(LiveActivityResponseConfirmation)
    case alreadyNotificationConfirmed(NotificationResponseConfirmation)
}

public struct NotificationResponseConfirmation: Codable, Equatable, Sendable {
    public let accountID: String
    public let deviceID: String
    public let notificationID: String
    public let action: NotificationInteractionAction
    public let idempotencyKey: String
    public let canonicalState: String
    public let confirmedAt: Date
    public let expiresAt: Date

    public var decisionKey: String { "notification|\(notificationID)" }

    public init(response: PendingNotificationResponse, confirmedAt: Date) throws {
        guard
            response.endpoint == .notification,
            let canonicalState = NotificationResponsePolicy.canonicalState(for: response.action)
        else { throw LiveActivityResponseConfirmationError.invalidConfirmation }
        accountID = response.accountID
        deviceID = response.deviceID
        notificationID = response.notificationID
        action = response.action
        idempotencyKey = response.idempotencyKey
        self.canonicalState = canonicalState
        self.confirmedAt = confirmedAt
        expiresAt = response.expiresAt
    }

    public func exactlyMatches(_ response: PendingNotificationResponse) -> Bool {
        response.endpoint == .notification
            && response.accountID == accountID
            && response.deviceID == deviceID
            && response.notificationID == notificationID
            && response.action == action
            && response.idempotencyKey == idempotencyKey
    }
}

public struct LiveActivityResponseConfirmation: Codable, Equatable, Sendable {
    public let accountID: String
    public let deviceID: String
    public let notificationID: String
    public let activityID: String
    public let activityGeneration: Int
    public let interactionID: String
    public let action: NotificationInteractionAction
    public let idempotencyKey: String
    public let canonicalState: String
    public let confirmedAt: Date
    public let expiresAt: Date

    public var decisionKey: String { "live-activity|\(activityID)|\(activityGeneration)|\(interactionID)" }

    public init(
        response: PendingNotificationResponse,
        canonicalState: String,
        confirmedAt: Date
    ) throws {
        guard
            response.endpoint == .liveActivity,
            let activityID = response.activityID,
            let activityGeneration = response.activityGeneration,
            let interactionID = response.interactionID,
            ReloIdentifier.isValid(activityID),
            activityGeneration > 0,
            ReloIdentifier.isValid(interactionID),
            LiveActivityResponsePolicy.isCanonicalResponse(canonicalState, for: response.action)
        else { throw LiveActivityResponseConfirmationError.invalidConfirmation }
        self.accountID = response.accountID
        self.deviceID = response.deviceID
        self.notificationID = response.notificationID
        self.activityID = activityID
        self.activityGeneration = activityGeneration
        self.interactionID = interactionID
        self.action = response.action
        self.idempotencyKey = response.idempotencyKey
        self.canonicalState = canonicalState
        self.confirmedAt = confirmedAt
        self.expiresAt = response.expiresAt
    }

    private enum CodingKeys: String, CodingKey {
        case accountID, deviceID, notificationID, activityID, activityGeneration, interactionID
        case action, idempotencyKey, canonicalState, confirmedAt, expiresAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        accountID = try values.decode(String.self, forKey: .accountID)
        deviceID = try values.decode(String.self, forKey: .deviceID)
        notificationID = try values.decode(String.self, forKey: .notificationID)
        activityID = try values.decode(String.self, forKey: .activityID)
        activityGeneration = try values.decodeIfPresent(Int.self, forKey: .activityGeneration) ?? 1
        guard activityGeneration > 0 else {
            throw DecodingError.dataCorruptedError(
                forKey: .activityGeneration,
                in: values,
                debugDescription: "Live Activity generation must be positive"
            )
        }
        interactionID = try values.decode(String.self, forKey: .interactionID)
        action = try values.decode(NotificationInteractionAction.self, forKey: .action)
        idempotencyKey = try values.decode(String.self, forKey: .idempotencyKey)
        canonicalState = try values.decode(String.self, forKey: .canonicalState)
        confirmedAt = try values.decode(Date.self, forKey: .confirmedAt)
        expiresAt = try values.decode(Date.self, forKey: .expiresAt)
    }

    public func exactlyMatches(_ response: PendingNotificationResponse) -> Bool {
        response.accountID == accountID
            && response.deviceID == deviceID
            && response.notificationID == notificationID
            && response.activityID == activityID
            && response.activityGeneration == activityGeneration
            && response.interactionID == interactionID
            && response.action == action
            && response.idempotencyKey == idempotencyKey
    }

    public func response(using credential: String) -> PendingNotificationResponse {
        PendingNotificationResponse(
            accountID: accountID,
            deviceID: deviceID,
            notificationID: notificationID,
            action: action,
            value: [:],
            idempotencyKey: idempotencyKey,
            expiresAt: expiresAt,
            endpoint: .liveActivity,
            activityID: activityID,
            activityGeneration: activityGeneration,
            interactionID: interactionID,
            responseCredential: credential
        )
    }
}

public enum LiveActivityResponseConfirmationError: Error, Equatable, Sendable {
    case invalidConfirmation
    case missingPendingResponse
    case responseMismatch
}

public struct LiveActivityResponseServerResult: Codable, Equatable, Sendable {
    public let state: String

    public static func decode(
        _ data: Data,
        expectedAction: NotificationInteractionAction
    ) throws -> Self {
        let result = try JSONDecoder().decode(Self.self, from: data)
        guard LiveActivityResponsePolicy.isCanonicalResponse(result.state, for: expectedAction) else {
            throw LiveActivityResponseConfirmationError.invalidConfirmation
        }
        return result
    }
}

public protocol AccountScopedPendingResponseStoring: Sendable {
    func select(accountID: String, deviceID: String) async throws
    func enqueue(_ response: PendingNotificationResponse) async throws -> PendingResponseEnqueueResult
    func pending(now: Date) async throws -> [PendingNotificationResponse]
    func notificationConfirmations(now: Date) async throws -> [NotificationResponseConfirmation]
    func confirmNotification(
        _ response: PendingNotificationResponse,
        confirmedAt: Date
    ) async throws -> NotificationResponseConfirmation
    func remove(id: String) async throws
    func clearSelectedAccount() async throws
}

public enum PendingResponseFailureResolution: Equatable, Sendable {
    case discardedInvalidResponse
    case retry
}

public enum PendingResponseQueueFailureHandler {
    public static func handle(
        _ error: MobileAPIError,
        response: PendingNotificationResponse,
        store: any AccountScopedPendingResponseStoring
    ) async -> PendingResponseFailureResolution {
        guard error == .invalidRequest else { return .retry }
        do {
            try await store.remove(id: response.id)
            return .discardedInvalidResponse
        } catch {
            return .retry
        }
    }
}

public actor AccountScopedProtectedActionStore: AccountScopedLiveActivityLedgerStoring, AccountScopedPendingResponseStoring {
    private let baseDirectory: URL
    private var selectedDirectory: URL?

    public init(baseDirectory: URL) {
        self.baseDirectory = baseDirectory
    }

    public func select(accountID: String, deviceID: String) throws {
        guard Self.safe(accountID), Self.safe(deviceID) else { throw AccountScopedInboxCacheError.invalidAccountId }
        selectedDirectory = baseDirectory
            .appendingPathComponent(accountID, isDirectory: true)
            .appendingPathComponent(deviceID, isDirectory: true)
    }

    public func load() throws -> LiveActivityCommandLedger {
        try decode(LiveActivityCommandLedger.self, from: "live-activity-ledger.json") ?? LiveActivityCommandLedger()
    }

    public func save(_ ledger: LiveActivityCommandLedger) throws {
        try encode(ledger, to: "live-activity-ledger.json")
    }

    public func enqueue(_ response: PendingNotificationResponse) throws -> PendingResponseEnqueueResult {
        if response.endpoint == .notification,
           let existing = try loadNotificationConfirmations().first(where: { $0.decisionKey == response.decisionKey }) {
            return .alreadyNotificationConfirmed(existing)
        }
        var responses = try loadResponses()
        if let existing = responses.first(where: { $0.decisionKey == response.decisionKey }) {
            return .alreadyPending(existing)
        }
        responses.append(response)
        try encode(responses, to: "pending-responses.json")
        return .enqueued
    }

    public func pending(now: Date) throws -> [PendingNotificationResponse] {
        let all = try loadResponses()
        let active = all.filter { $0.expiresAt > now }
        if active != all { try encode(active, to: "pending-responses.json") }
        return active
    }

    public func notificationConfirmations(now: Date) throws -> [NotificationResponseConfirmation] {
        let all = try loadNotificationConfirmations()
        let active = all.filter { max($0.expiresAt, $0.confirmedAt.addingTimeInterval(86_400)) > now }
        if active != all { try encode(active, to: "notification-response-confirmations.json") }
        return active
    }

    public func confirmNotification(
        _ response: PendingNotificationResponse,
        confirmedAt: Date
    ) throws -> NotificationResponseConfirmation {
        var confirmations = try loadNotificationConfirmations()
        if let existing = confirmations.first(where: { $0.decisionKey == response.decisionKey }) {
            guard existing.exactlyMatches(response) else {
                throw LiveActivityResponseConfirmationError.responseMismatch
            }
            return existing
        }
        var responses = try loadResponses()
        guard let index = responses.firstIndex(where: { $0.id == response.id }), responses[index] == response else {
            throw LiveActivityResponseConfirmationError.missingPendingResponse
        }
        let confirmation = try NotificationResponseConfirmation(response: response, confirmedAt: confirmedAt)
        responses.remove(at: index)
        confirmations.append(confirmation)
        try encode(responses, to: "pending-responses.json")
        try encode(Array(confirmations.suffix(256)), to: "notification-response-confirmations.json")
        return confirmation
    }

    public func remove(id: String) throws {
        let remaining = try loadResponses().filter { $0.id != id }
        try encode(remaining, to: "pending-responses.json")
    }

    public func clearSelectedAccount() throws {
        guard let selectedDirectory else { return }
        if FileManager.default.fileExists(atPath: selectedDirectory.path) {
            try FileManager.default.removeItem(at: selectedDirectory)
        }
    }

    private func loadResponses() throws -> [PendingNotificationResponse] {
        try decode([PendingNotificationResponse].self, from: "pending-responses.json") ?? []
    }

    private func loadNotificationConfirmations() throws -> [NotificationResponseConfirmation] {
        try decode([NotificationResponseConfirmation].self, from: "notification-response-confirmations.json") ?? []
    }

    private func decode<Value: Codable>(_ type: Value.Type, from name: String) throws -> Value? {
        guard let selectedDirectory else { throw AccountScopedInboxCacheError.accountNotSelected }
        let url = selectedDirectory.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data = try Data(contentsOf: url)
        let storage = try storageContract(for: name)
        return try VersionedStorageCodec.decode(
            type,
            from: data,
            schemaVersion: storage
        ).payload
    }

    private func encode<Value: Codable>(_ value: Value, to name: String) throws {
        guard let selectedDirectory else { throw AccountScopedInboxCacheError.accountNotSelected }
        try FileManager.default.createDirectory(at: selectedDirectory, withIntermediateDirectories: true)
        let storage = try storageContract(for: name)
        try VersionedStorageCodec.encode(
            value,
            schemaVersion: storage
        ).write(
            to: selectedDirectory.appendingPathComponent(name),
            options: ReloProtectedFileWritingOptions.complete
        )
    }

    private func storageContract(
        for name: String
    ) throws -> Int {
        switch name {
        case "live-activity-ledger.json":
            LocalStoreSchema.liveActivityLedger
        case "pending-responses.json":
            LocalStoreSchema.pendingResponses
        case "notification-response-confirmations.json":
            LocalStoreSchema.responseConfirmations
        default:
            throw ProtectedStoreContractError.unregisteredStore(name)
        }
    }

    private static func safe(_ value: String) -> Bool {
        let punctuation = CharacterSet(charactersIn: "_-")
        return !value.isEmpty && value.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || punctuation.contains($0)
        }
    }
}

private enum ProtectedStoreContractError: Error {
    case unregisteredStore(String)
}

public struct CrossProcessResponseFile: Sendable {
    public static let dataProtectionClass = "completeUntilFirstUserAuthentication"
    private static let maximumConfirmations = 256
    private static let confirmationRetention: TimeInterval = 86_400

    private let baseDirectory: URL

    private struct Ledger: Codable, Equatable {
        var pending: [PendingNotificationResponse]
        var confirmations: [LiveActivityResponseConfirmation]
        var notificationConfirmations: [NotificationResponseConfirmation]

        static let empty = Ledger(pending: [], confirmations: [], notificationConfirmations: [])

        private enum CodingKeys: String, CodingKey {
            case pending, confirmations, notificationConfirmations
        }

        init(
            pending: [PendingNotificationResponse],
            confirmations: [LiveActivityResponseConfirmation],
            notificationConfirmations: [NotificationResponseConfirmation]
        ) {
            self.pending = pending
            self.confirmations = confirmations
            self.notificationConfirmations = notificationConfirmations
        }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            pending = try values.decodeIfPresent([PendingNotificationResponse].self, forKey: .pending) ?? []
            confirmations = try values.decodeIfPresent([LiveActivityResponseConfirmation].self, forKey: .confirmations) ?? []
            notificationConfirmations = try values.decodeIfPresent(
                [NotificationResponseConfirmation].self,
                forKey: .notificationConfirmations
            ) ?? []
        }
    }

    public init(baseDirectory: URL) {
        self.baseDirectory = baseDirectory
    }

    public func enqueue(_ response: PendingNotificationResponse) throws -> PendingResponseEnqueueResult {
        try withLock(accountID: response.accountID, deviceID: response.deviceID) { fileURL in
            var ledger = try load(fileURL)
            prune(&ledger, now: .now)
            if let existing = ledger.confirmations.first(where: { $0.decisionKey == response.decisionKey }) {
                return .alreadyConfirmed(existing)
            }
            if let existing = ledger.notificationConfirmations.first(where: { $0.decisionKey == response.decisionKey }) {
                return .alreadyNotificationConfirmed(existing)
            }
            if let existing = ledger.pending.first(where: { $0.decisionKey == response.decisionKey }) {
                return .alreadyPending(existing)
            }
            ledger.pending.append(response)
            try save(ledger, to: fileURL)
            return .enqueued
        }
    }

    public func pending(accountID: String, deviceID: String, now: Date) throws -> [PendingNotificationResponse] {
        try withLock(accountID: accountID, deviceID: deviceID) { fileURL in
            var ledger = try load(fileURL)
            let before = ledger
            prune(&ledger, now: now)
            if ledger != before { try save(ledger, to: fileURL) }
            return ledger.pending
        }
    }

    public func confirmations(
        accountID: String,
        deviceID: String,
        now: Date
    ) throws -> [LiveActivityResponseConfirmation] {
        try withLock(accountID: accountID, deviceID: deviceID) { fileURL in
            var ledger = try load(fileURL)
            let before = ledger
            prune(&ledger, now: now)
            if ledger != before { try save(ledger, to: fileURL) }
            return ledger.confirmations
        }
    }

    public func notificationConfirmations(
        accountID: String,
        deviceID: String,
        now: Date
    ) throws -> [NotificationResponseConfirmation] {
        try withLock(accountID: accountID, deviceID: deviceID) { fileURL in
            var ledger = try load(fileURL)
            let before = ledger
            prune(&ledger, now: now)
            if ledger != before { try save(ledger, to: fileURL) }
            return ledger.notificationConfirmations
        }
    }

    @discardableResult
    public func confirmNotification(
        _ response: PendingNotificationResponse,
        confirmedAt: Date
    ) throws -> NotificationResponseConfirmation {
        try withLock(accountID: response.accountID, deviceID: response.deviceID) { fileURL in
            var ledger = try load(fileURL)
            prune(&ledger, now: confirmedAt)
            if let existing = ledger.notificationConfirmations.first(where: { $0.decisionKey == response.decisionKey }) {
                guard existing.exactlyMatches(response) else {
                    throw LiveActivityResponseConfirmationError.responseMismatch
                }
                return existing
            }
            guard let pendingIndex = ledger.pending.firstIndex(where: { $0.id == response.id }) else {
                throw LiveActivityResponseConfirmationError.missingPendingResponse
            }
            guard sameProtectedDecision(ledger.pending[pendingIndex], response) else {
                throw LiveActivityResponseConfirmationError.responseMismatch
            }
            let confirmation = try NotificationResponseConfirmation(response: response, confirmedAt: confirmedAt)
            ledger.pending.remove(at: pendingIndex)
            ledger.notificationConfirmations.removeAll { $0.decisionKey == confirmation.decisionKey }
            ledger.notificationConfirmations.append(confirmation)
            ledger.notificationConfirmations = Array(ledger.notificationConfirmations.suffix(Self.maximumConfirmations))
            try save(ledger, to: fileURL)
            return confirmation
        }
    }

    @discardableResult
    public func confirm(
        _ response: PendingNotificationResponse,
        canonicalState: String,
        confirmedAt: Date
    ) throws -> LiveActivityResponseConfirmation {
        try withLock(accountID: response.accountID, deviceID: response.deviceID) { fileURL in
            var ledger = try load(fileURL)
            prune(&ledger, now: confirmedAt)
            if let existing = ledger.confirmations.first(where: { $0.decisionKey == response.decisionKey }) {
                guard existing.exactlyMatches(response), existing.canonicalState == canonicalState else {
                    throw LiveActivityResponseConfirmationError.responseMismatch
                }
                return existing
            }
            guard let pendingIndex = ledger.pending.firstIndex(where: { $0.id == response.id }) else {
                throw LiveActivityResponseConfirmationError.missingPendingResponse
            }
            guard sameProtectedDecision(ledger.pending[pendingIndex], response) else {
                throw LiveActivityResponseConfirmationError.responseMismatch
            }
            let confirmation = try LiveActivityResponseConfirmation(
                response: response,
                canonicalState: canonicalState,
                confirmedAt: confirmedAt
            )
            ledger.pending.remove(at: pendingIndex)
            ledger.confirmations.removeAll { $0.decisionKey == confirmation.decisionKey }
            ledger.confirmations.append(confirmation)
            ledger.confirmations = Array(ledger.confirmations.suffix(Self.maximumConfirmations))
            try save(ledger, to: fileURL)
            return confirmation
        }
    }

    public func remove(id: String, accountID: String, deviceID: String) throws {
        try withLock(accountID: accountID, deviceID: deviceID) { fileURL in
            var ledger = try load(fileURL)
            ledger.pending.removeAll { $0.id == id }
            try save(ledger, to: fileURL)
        }
    }

    public func clear(accountID: String, deviceID: String) throws {
        try withLock(accountID: accountID, deviceID: deviceID) { fileURL in
            if FileManager.default.fileExists(atPath: fileURL.path) {
                try FileManager.default.removeItem(at: fileURL)
            }
        }
    }

    private func withLock<Value>(
        accountID: String,
        deviceID: String,
        _ body: (URL) throws -> Value
    ) throws -> Value {
        guard Self.safe(accountID), Self.safe(deviceID) else {
            throw AccountScopedInboxCacheError.invalidAccountId
        }
        let directory = baseDirectory
            .appendingPathComponent(accountID, isDirectory: true)
            .appendingPathComponent(deviceID, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let lockURL = directory.appendingPathComponent("responses.lock")
        let descriptor = Darwin.open(lockURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw CrossProcessResponseFileError.lockUnavailable }
        defer { Darwin.close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else { throw CrossProcessResponseFileError.lockUnavailable }
        defer { flock(descriptor, LOCK_UN) }
        return try body(directory.appendingPathComponent("pending-responses.json"))
    }

    private func load(_ fileURL: URL) throws -> Ledger {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return .empty }
        let data = try Data(contentsOf: fileURL)
        return try VersionedStorageCodec.decode(
            Ledger.self,
            from: data,
            schemaVersion: LocalStoreSchema.crossProcessResponses
        ).payload
    }

    private func save(_ ledger: Ledger, to fileURL: URL) throws {
        // Notification and Live Activity actions can arrive while the phone is locked.
        // This class keeps the queue encrypted until first unlock after boot, then permits
        // the intended locked-screen action path without falling back to unprotected data.
        try VersionedStorageCodec.encode(
            ledger,
            schemaVersion: LocalStoreSchema.crossProcessResponses
        ).write(
            to: fileURL,
            options: ReloProtectedFileWritingOptions.afterFirstUnlock
        )
    }

    private func prune(_ ledger: inout Ledger, now: Date) {
        ledger.pending.removeAll { $0.expiresAt <= now }
        ledger.confirmations.removeAll {
            max($0.expiresAt, $0.confirmedAt.addingTimeInterval(Self.confirmationRetention)) <= now
        }
        ledger.notificationConfirmations.removeAll {
            max($0.expiresAt, $0.confirmedAt.addingTimeInterval(Self.confirmationRetention)) <= now
        }
        if ledger.confirmations.count > Self.maximumConfirmations {
            ledger.confirmations = Array(ledger.confirmations.suffix(Self.maximumConfirmations))
        }
        if ledger.notificationConfirmations.count > Self.maximumConfirmations {
            ledger.notificationConfirmations = Array(ledger.notificationConfirmations.suffix(Self.maximumConfirmations))
        }
    }

    private func sameProtectedDecision(
        _ stored: PendingNotificationResponse,
        _ requested: PendingNotificationResponse
    ) -> Bool {
        stored.id == requested.id
            && stored.accountID == requested.accountID
            && stored.deviceID == requested.deviceID
            && stored.notificationID == requested.notificationID
            && stored.action == requested.action
            && stored.value == requested.value
            && stored.idempotencyKey == requested.idempotencyKey
            && abs(stored.expiresAt.timeIntervalSince(requested.expiresAt)) < 1
            && stored.endpoint == requested.endpoint
            && stored.activityID == requested.activityID
            && stored.activityGeneration == requested.activityGeneration
            && stored.interactionID == requested.interactionID
            && stored.responseCredential == requested.responseCredential
    }

    private static func safe(_ value: String) -> Bool {
        let punctuation = CharacterSet(charactersIn: "_-")
        return !value.isEmpty && value.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || punctuation.contains($0)
        }
    }
}

public enum CrossProcessResponseFileError: Error, Equatable {
    case lockUnavailable
}

public actor AccountScopedCrossProcessResponseStore: AccountScopedPendingResponseStoring {
    private let file: CrossProcessResponseFile
    private var selectedAccountID: String?
    private var selectedDeviceID: String?

    public init(baseDirectory: URL) {
        self.file = CrossProcessResponseFile(baseDirectory: baseDirectory)
    }

    public func select(accountID: String, deviceID: String) {
        selectedAccountID = accountID
        selectedDeviceID = deviceID
    }

    public func enqueue(_ response: PendingNotificationResponse) throws -> PendingResponseEnqueueResult {
        try file.enqueue(response)
    }

    public func pending(now: Date) throws -> [PendingNotificationResponse] {
        let (accountID, deviceID) = try selectedIDs()
        return try file.pending(accountID: accountID, deviceID: deviceID, now: now)
    }

    public func notificationConfirmations(now: Date) throws -> [NotificationResponseConfirmation] {
        let (accountID, deviceID) = try selectedIDs()
        return try file.notificationConfirmations(accountID: accountID, deviceID: deviceID, now: now)
    }

    public func confirmNotification(
        _ response: PendingNotificationResponse,
        confirmedAt: Date
    ) throws -> NotificationResponseConfirmation {
        try file.confirmNotification(response, confirmedAt: confirmedAt)
    }

    public func remove(id: String) throws {
        let (accountID, deviceID) = try selectedIDs()
        try file.remove(id: id, accountID: accountID, deviceID: deviceID)
    }

    public func clearSelectedAccount() throws {
        let (accountID, deviceID) = try selectedIDs()
        try file.clear(accountID: accountID, deviceID: deviceID)
    }

    private func selectedIDs() throws -> (String, String) {
        guard let selectedAccountID, let selectedDeviceID else {
            throw AccountScopedInboxCacheError.accountNotSelected
        }
        return (selectedAccountID, selectedDeviceID)
    }
}

public actor InMemoryProtectedActionStore: AccountScopedLiveActivityLedgerStoring, AccountScopedPendingResponseStoring {
    private var ledger = LiveActivityCommandLedger()
    private var responses: [PendingNotificationResponse] = []
    private var notificationResponseConfirmations: [NotificationResponseConfirmation] = []

    public init() {}
    public func select(accountID: String, deviceID: String) {}
    public func load() -> LiveActivityCommandLedger { ledger }
    public func save(_ ledger: LiveActivityCommandLedger) { self.ledger = ledger }
    public func enqueue(_ response: PendingNotificationResponse) -> PendingResponseEnqueueResult {
        if let existing = notificationResponseConfirmations.first(where: { $0.decisionKey == response.decisionKey }) {
            return .alreadyNotificationConfirmed(existing)
        }
        if let existing = responses.first(where: { $0.decisionKey == response.decisionKey }) {
            return .alreadyPending(existing)
        }
        responses.append(response)
        return .enqueued
    }
    public func pending(now: Date) -> [PendingNotificationResponse] {
        responses.removeAll { $0.expiresAt <= now }
        return responses
    }
    public func notificationConfirmations(now: Date) -> [NotificationResponseConfirmation] {
        notificationResponseConfirmations.removeAll {
            max($0.expiresAt, $0.confirmedAt.addingTimeInterval(86_400)) <= now
        }
        return notificationResponseConfirmations
    }
    public func confirmNotification(
        _ response: PendingNotificationResponse,
        confirmedAt: Date
    ) throws -> NotificationResponseConfirmation {
        if let existing = notificationResponseConfirmations.first(where: { $0.decisionKey == response.decisionKey }) {
            guard existing.exactlyMatches(response) else {
                throw LiveActivityResponseConfirmationError.responseMismatch
            }
            return existing
        }
        guard let index = responses.firstIndex(where: { $0 == response }) else {
            throw LiveActivityResponseConfirmationError.missingPendingResponse
        }
        let confirmation = try NotificationResponseConfirmation(response: response, confirmedAt: confirmedAt)
        responses.remove(at: index)
        notificationResponseConfirmations.append(confirmation)
        return confirmation
    }
    public func remove(id: String) { responses.removeAll { $0.id == id } }
    public func clearSelectedAccount() {
        ledger = LiveActivityCommandLedger()
        responses = []
        notificationResponseConfirmations = []
    }
}
