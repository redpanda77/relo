import Foundation
import ReloCore
@testable import ReloRuntime
import ReloPersistence
import XCTest

@MainActor
final class LiveActivityAcknowledgementUploaderTests: XCTestCase {
    private let credential = DeviceCredential(deviceId: "dev_test123456", installationId: UUID(), accessToken: "test",
        issuedAt: .now, accountId: "acc_test123456", credentialVersion: 1)

    private func coordinator(dismissing ids: [String]) async throws -> LiveActivityCommandCoordinator {
        let coordinator = LiveActivityCommandCoordinator(store: InMemoryProtectedActionStore())
        try await coordinator.select(accountID: "acc_test123456", deviceID: "dev_test123456")
        for id in ids {
            try await coordinator.recordPresentationDismissal(identity: LiveActivityIdentity(activityID: id, generation: 1))
        }
        return coordinator
    }

    private func remaining(_ coordinator: LiveActivityCommandCoordinator) async throws -> [String] {
        try await coordinator.pendingDismissedActivityIdentities(limit: 25).map(\.activityID)
    }

    func testAcceptedAndAlreadyRecordedDismissalsAreRemoved() async throws {
        let coordinator = try await coordinator(dismissing: ["act_first1234567", "act_second123456", "act_third1234567"])
        let client = ScriptedClient(failures: ["act_second123456": MobileAPIError.invalidRequest])
        let result = await LiveActivityAcknowledgementUploader(coordinator: coordinator, client: client)
            .uploadDismissals(credential: credential, isCurrent: { true }, credentialUnchanged: { true })
        XCTAssertEqual(result, .finished)
        XCTAssertEqual(client.sent, ["act_first1234567", "act_second123456", "act_third1234567"])
        let left = try await remaining(coordinator)
        XCTAssertEqual(left, [])
    }

    func testTransientFailureStopsTheBatchAndKeepsTheRest() async throws {
        let coordinator = try await coordinator(dismissing: ["act_first1234567", "act_second123456", "act_third1234567"])
        let client = ScriptedClient(failures: ["act_second123456": MobileAPIError.unavailable])
        let result = await LiveActivityAcknowledgementUploader(coordinator: coordinator, client: client)
            .uploadDismissals(credential: credential, isCurrent: { true }, credentialUnchanged: { true })
        XCTAssertEqual(result, .finished)
        XCTAssertEqual(client.sent, ["act_first1234567", "act_second123456"])
        let left = try await remaining(coordinator)
        XCTAssertEqual(left, ["act_second123456", "act_third1234567"])
    }

    func testRevocationKeepsAcceptedWorkAndAsksForSignOut() async throws {
        let coordinator = try await coordinator(dismissing: ["act_first1234567", "act_second123456"])
        let client = ScriptedClient(failures: ["act_second123456": MobileAPIError.reauthenticationRequired])
        let result = await LiveActivityAcknowledgementUploader(coordinator: coordinator, client: client)
            .uploadDismissals(credential: credential, isCurrent: { true }, credentialUnchanged: { true })
        XCTAssertEqual(result, .credentialRevoked)
        let left = try await remaining(coordinator)
        XCTAssertEqual(left, ["act_second123456"])
    }

    func testASessionThatMovedOnSendsNothing() async throws {
        let coordinator = try await coordinator(dismissing: ["act_first1234567"])
        let client = ScriptedClient(failures: [:])
        let result = await LiveActivityAcknowledgementUploader(coordinator: coordinator, client: client)
            .uploadDismissals(credential: credential, isCurrent: { false }, credentialUnchanged: { true })
        XCTAssertEqual(result, .stopped)
        XCTAssertEqual(client.sent, [])
        let left = try await remaining(coordinator)
        XCTAssertEqual(left, ["act_first1234567"])
    }
}

/// Records dismissal reports and fails the scripted activity IDs; every other call is unused here.
private final class ScriptedClient: MobileAPIClient, @unchecked Sendable {
    private let failures: [String: MobileAPIError]
    private(set) var sent: [String] = []
    init(failures: [String: MobileAPIError]) { self.failures = failures }

    func reportLiveActivityDismissed(credential: DeviceCredential, activityId: String, generation: Int) async throws {
        sent.append(activityId)
        if let failure = failures[activityId] { throw failure }
    }

    func validateAccountSession(token: String) async throws -> AccountSession { throw MobileAPIError.unavailable }
    func registerDevice(sessionToken: String, request: DeviceRegistrationRequest, idempotencyKey: String) async throws
        -> DeviceRegistrationResponse { throw MobileAPIError.unavailable }
    func deviceSelf(credential: DeviceCredential) async throws -> DeviceSelfResponse { throw MobileAPIError.unavailable }
    func heartbeat(credential: DeviceCredential, heartbeat: DeviceHeartbeat) async throws { throw MobileAPIError.unavailable }
    func registerLiveActivityToken(credential: DeviceCredential, activityId: String,
        registration: LiveActivityTokenRegistration) async throws { throw MobileAPIError.unavailable }
    func submitInteraction(credential: DeviceCredential, notificationId: String, action: NotificationInteractionAction,
        value: [String: String], idempotencyKey: String) async throws { throw MobileAPIError.unavailable }
    func revokeDevice(credential: DeviceCredential) async throws { throw MobileAPIError.unavailable }
    func signOutAccount(sessionToken: String) async throws { throw MobileAPIError.unavailable }
    func deleteAccount(sessionToken: String, password: String, confirmation: String) async throws {
        throw MobileAPIError.unavailable
    }
}
