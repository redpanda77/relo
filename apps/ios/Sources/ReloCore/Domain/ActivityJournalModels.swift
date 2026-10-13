import Foundation

public enum LiveActivityResponseRequestError: Error, Equatable, Sendable {
    case invalidConfiguration
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
