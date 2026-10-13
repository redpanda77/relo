@testable import ReloPersistence
import Foundation
import XCTest
@testable import ReloCore

final class NotificationDecisionPersistenceTests: XCTestCase {
    func testLegacyIntentKeepsFirstChoiceAndKeyWhileOriginalDeadlineIsRestored() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = CrossProcessResponseFile(baseDirectory: directory)
        let deadline = Date.now.addingTimeInterval(300)
        let legacy = PendingNotificationResponse(accountID: "account", deviceID: "device", notificationID: "event",
            action: .deny, value: [:], idempotencyKey: "first-choice", expiresAt: .now.addingTimeInterval(86_400))
        _ = try file.enqueue(legacy)
        let current = response(deadline: deadline)
        guard case .alreadyPending(let rebound) = try file.enqueue(current) else { return XCTFail("Expected first intent") }
        XCTAssertEqual(rebound.action, .deny); XCTAssertEqual(rebound.idempotencyKey, "first-choice")
        XCTAssertEqual(rebound.expiresAt, deadline); XCTAssertEqual(rebound.interactionID, current.interactionID)
        let restarted = CrossProcessResponseFile(baseDirectory: directory)
        XCTAssertEqual(try restarted.pending(accountID: "account", deviceID: "device", now: .now), [rebound])
    }

    func testExpiryAndReplacementHaveDurableTerminalOutcomesAndCannotReplay() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = CrossProcessResponseFile(baseDirectory: directory)
        let pending = response(deadline: .now.addingTimeInterval(10))
        _ = try file.enqueue(pending)
        let afterExpiry = pending.expiresAt.addingTimeInterval(1)
        XCTAssertTrue(try file.pending(accountID: "account", deviceID: "device", now: afterExpiry).isEmpty)
        let restarted = CrossProcessResponseFile(baseDirectory: directory)
        let failure = try XCTUnwrap(restarted.notificationFailures(accountID: "account", deviceID: "device", now: afterExpiry).first)
        XCTAssertEqual(failure.reason, .expired); XCTAssertEqual(failure.response, pending)
        XCTAssertThrowsError(try restarted.enqueue(pending)) { XCTAssertTrue($0 is NotificationResponseFailure) }
        let replaced = response(id: "replaced", deadline: .now.addingTimeInterval(300))
        _ = try restarted.enqueue(replaced)
        try restarted.rejectNotification(replaced, reason: .superseded, at: .now)
        XCTAssertThrowsError(try file.enqueue(replaced))
        XCTAssertTrue(try file.notificationFailures(accountID: "account", deviceID: "other-device", now: .now).isEmpty)
    }

    func testValidAcknowledgementArrivingAfterLocalExpiryReconcilesTheExactIntent() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = CrossProcessResponseFile(baseDirectory: directory)
        let pending = response(deadline: .now.addingTimeInterval(10))
        _ = try file.enqueue(pending)
        let arrival = pending.expiresAt.addingTimeInterval(1)
        _ = try file.pending(accountID: "account", deviceID: "device", now: arrival)
        let acknowledgement = NotificationDecisionAcknowledgement(id: pending.interactionID!, state: "approved",
            respondedAt: pending.expiresAt.addingTimeInterval(-0.01))
        try acknowledgement.validate(pending)
        let confirmed = try file.confirmNotification(pending, confirmedAt: arrival)
        XCTAssertEqual(confirmed.canonicalState, "approved")
        XCTAssertTrue(try file.notificationFailures(accountID: "account", deviceID: "device", now: arrival).isEmpty)
        XCTAssertThrowsError(try NotificationDecisionAcknowledgement(id: pending.interactionID!, state: "approved",
            respondedAt: arrival).validate(pending))
    }

    func testFailureHistoryIsBoundedAndExpiresWithoutExtendingActionValidity() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = CrossProcessResponseFile(baseDirectory: directory), now = Date.now
        for index in 0..<257 {
            let pending = response(id: "event-\(index)", deadline: now.addingTimeInterval(300))
            _ = try file.enqueue(pending)
            try file.rejectNotification(pending, reason: .superseded, at: now)
        }
        let failures = try file.notificationFailures(accountID: "account", deviceID: "device", now: now)
        XCTAssertEqual(failures.count, 256); XCTAssertEqual(failures.first?.response.notificationID, "event-1")
        XCTAssertTrue(try file.notificationFailures(accountID: "account", deviceID: "device", now: now.addingTimeInterval(86_401)).isEmpty)
        XCTAssertTrue(try file.pending(accountID: "account", deviceID: "device", now: now).isEmpty)
    }

    func testPushMetadataRequiresTheOriginalDeadlineAndScope() {
        let base: [String: Any] = ["accountId": "account", "deviceId": "device",
            "interactionId": "request", "interactionType": "yes_no", "interactionExpiresAt": "2026-09-30T12:00:00.000Z"]
        XCTAssertNotNil(NotificationDecisionMetadata(relo: base))
        for key in ["accountId", "deviceId", "interactionId", "interactionExpiresAt"] {
            var missing = base; missing.removeValue(forKey: key)
            XCTAssertNil(NotificationDecisionMetadata(relo: missing))
        }
    }

    private func response(id: String = "event", deadline: Date) -> PendingNotificationResponse {
        .init(accountID: "account", deviceID: "device", notificationID: id, action: .approve,
            value: [:], idempotencyKey: "idempotent:\(id)", expiresAt: deadline,
            interactionID: "request-\(id)", serverOrigin: URL(string: "https://relo.invalid"))
    }
}
