import ReloCore
import Foundation

/// Uploads the phone's Live Activity acknowledgements (cards received, cards dismissed) that the
/// command coordinator queued, in bounded batches, and removes the ones the server accepted.
/// The caller supplies whether its session is still current; on revocation it handles sign-out.
@MainActor
public struct LiveActivityAcknowledgementUploader {
    public enum Result: Equatable, Sendable {
        /// The batch ran; accepted items were removed.
        case finished
        /// The session moved on (or nothing could be read); nothing more was done.
        case stopped
        /// The server revoked this device. Accepted items were removed; the caller must sign out.
        case credentialRevoked
    }

    private let coordinator: LiveActivityCommandCoordinator
    private let client: any MobileAPIClient

    public init(coordinator: LiveActivityCommandCoordinator, client: any MobileAPIClient) {
        self.coordinator = coordinator
        self.client = client
    }

    /// Reports `received` for each card command this phone applied.
    public func uploadReceived(
        credential: DeviceCredential,
        isCurrent: () -> Bool,
        credentialUnchanged: () -> Bool
    ) async -> Result {
        await upload(
            pending: { try await coordinator.pendingReceivedEventIDs(limit: 25) },
            send: { eventID in
                try await client.submitInteraction(
                    credential: credential,
                    notificationId: eventID,
                    action: .received,
                    value: [:],
                    idempotencyKey: "ios:\(credential.installationId):\(eventID):received"
                )
            },
            alreadyRecorded: { if case MobileAPIError.idempotencyConflict = $0 { true } else { false } },
            remove: { try await coordinator.removeReceivedEventIDs($0) },
            finalRemovalNeedsSameCredential: true,
            isCurrent: isCurrent,
            credentialUnchanged: credentialUnchanged
        )
    }

    /// Reports each card the owner dismissed from the Lock Screen.
    public func uploadDismissals(
        credential: DeviceCredential,
        isCurrent: () -> Bool,
        credentialUnchanged: () -> Bool
    ) async -> Result {
        await upload(
            pending: { try await coordinator.pendingDismissedActivityIdentities(limit: 25) },
            send: { identity in
                try await client.reportLiveActivityDismissed(credential: credential, activityId: identity.activityID, generation: identity.generation)
            },
            alreadyRecorded: { if case MobileAPIError.invalidRequest = $0 { true } else { false } },
            remove: { try await coordinator.removeDismissedActivityIdentities($0) },
            finalRemovalNeedsSameCredential: false,
            isCurrent: isCurrent,
            credentialUnchanged: credentialUnchanged
        )
    }

    private func upload<Item: Hashable>(
        pending: () async throws -> [Item],
        send: (Item) async throws -> Void,
        alreadyRecorded: (Error) -> Bool,
        remove: (Set<Item>) async throws -> Void,
        finalRemovalNeedsSameCredential: Bool,
        isCurrent: () -> Bool,
        credentialUnchanged: () -> Bool
    ) async -> Result {
        let items: [Item]
        do { items = try await pending() } catch { return .stopped }
        var completed = Set<Item>()
        for item in items {
            guard isCurrent(), credentialUnchanged() else { return .stopped }
            do {
                try await send(item)
                completed.insert(item)
            } catch MobileAPIError.reauthenticationRequired, MobileAPIError.forbidden {
                guard isCurrent() else { return .stopped }
                try? await remove(completed)
                guard credentialUnchanged() else { return .stopped }
                return .credentialRevoked
            } catch where alreadyRecorded(error) {
                completed.insert(item)
            } catch {
                break
            }
        }
        guard isCurrent(), !finalRemovalNeedsSameCredential || credentialUnchanged() else { return .stopped }
        try? await remove(completed)
        return .finished
    }
}
