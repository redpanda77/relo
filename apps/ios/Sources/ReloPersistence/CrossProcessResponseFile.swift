import ReloCore
import Foundation
import Darwin

public struct CrossProcessResponseFile: Sendable {
    public static let dataProtectionClass = "completeUntilFirstUserAuthentication"
    static let maximumConfirmations = 256
    private static let confirmationRetention: TimeInterval = 86_400

    let baseDirectory: URL

    struct Ledger: Codable, Equatable {
        var pending: [PendingNotificationResponse]
        var confirmations: [LiveActivityResponseConfirmation]
        var notificationConfirmations: [NotificationResponseConfirmation]
        var notificationFailures: [NotificationResponseFailure] = []

        static let empty = Ledger(pending: [], confirmations: [], notificationConfirmations: [])

        private enum CodingKeys: String, CodingKey {
            case pending, confirmations, notificationConfirmations, notificationFailures
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
            notificationFailures = try values.decodeIfPresent([NotificationResponseFailure].self, forKey: .notificationFailures) ?? []
        }
    }

    public init(baseDirectory: URL) {
        self.baseDirectory = baseDirectory
    }

    func load(_ fileURL: URL) throws -> Ledger {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return .empty }
        let data = try Data(contentsOf: fileURL)
        return try VersionedStorageCodec.decode(
            Ledger.self,
            from: data,
            schemaVersion: LocalStoreSchema.crossProcessResponses
        ).payload
    }

    func save(_ ledger: Ledger, to fileURL: URL) throws {
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

    func prune(_ ledger: inout Ledger, now: Date) {
        for response in ledger.pending where response.endpoint == .notification && response.expiresAt <= now {
            ledger.notificationFailures.removeAll { $0.response.decisionKey == response.decisionKey }
            ledger.notificationFailures.append(.init(response: response, reason: .expired, recordedAt: now))
        }
        ledger.notificationFailures = NotificationResponseFailure.bounded(ledger.notificationFailures, now: now)
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

    func sameProtectedDecision(
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
            && stored.serverOrigin == requested.serverOrigin
    }

    static func safe(_ value: String) -> Bool {
        let punctuation = CharacterSet(charactersIn: "_-")
        return !value.isEmpty && value.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || punctuation.contains($0)
        }
    }
}

public enum CrossProcessResponseFileError: Error, Equatable {
    case lockUnavailable
}
