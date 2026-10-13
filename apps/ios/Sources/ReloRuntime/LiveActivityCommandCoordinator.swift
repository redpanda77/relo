import ReloCore
import Foundation

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
