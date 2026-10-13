import Foundation
import XCTest
@testable import ReloCore

final class RelevancePolicyTests: XCTestCase {
    func testSharedPolicyDefaultsAndOriginalDeadlines() throws {
        for row in try fixtures().policies {
            XCTAssertEqual(try row.policy.deadlines(occurredAt: row.occurredAt, acceptedAt: row.acceptedAt), row.expected, row.name)
        }
    }

    func testSharedExpirySupersessionAndOfflineAffordances() throws {
        for row in try fixtures().evaluations {
            XCTAssertEqual(row.item.evaluate(now: row.now, clockTrusted: row.clockTrusted, current: row.current), row.expected, row.name)
        }
    }

    func testSharedAuthenticatedGenerationAndRevisionRules() throws {
        for row in try fixtures().transitions {
            XCTAssertEqual(SubjectVersion.classify(actor: row.actor, candidate: row.candidate, current: row.current, operation: row.operation).rawValue, row.expected, row.name)
        }
    }

    func testTerminalCleanupOutlivesExpiredAction() throws {
        let terminal = try date("2026-09-30T12:16:00Z")
        XCTAssertEqual(RelevancePolicy.terminalCleanupDeadline(terminalAt: terminal), try date("2026-09-30T13:16:00Z"))
    }

    func testRejectsContradictoryPoliciesAndFutureClockInput() throws {
        for json in [
            #"{"kind":"notice","relevanceSeconds":30,"deliverySeconds":60}"#,
            #"{"kind":"decision","actionSeconds":30,"deliverySeconds":60}"#,
            #"{"kind":"progress","actionSeconds":900}"#,
            #"{"kind":"notice","relevanceSeconds":0}"#,
            #"{"kind":"notice","relevanceSeconds":1.5}"#,
            #"{"kind":"progress","heartbeat":{"intervalSeconds":0,"lastHeartbeatAt":"2026-09-30T12:00:00Z"}}"#,
            #"{"kind":"incident","mode":"lease"}"#,
            #"{"kind":"incident","mode":"until_resolved","leaseUntil":"2026-09-30T12:10:00Z"}"#,
            #"{"kind":"terminal_cleanup"}"#
        ] {
            XCTAssertThrowsError(try decoder().decode(RelevancePolicy.self, from: Data(json.utf8)), json)
        }
        let policy = try decoder().decode(RelevancePolicy.self, from: Data(#"{"kind":"notice"}"#.utf8))
        XCTAssertThrowsError(try policy.deadlines(occurredAt: date("2026-09-30T12:00:01.001Z"), acceptedAt: date("2026-09-30T12:00:00Z")))
    }

    private func fixtures() throws -> Fixture {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "relevance", withExtension: "json"))
        return try decoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testCorruptPersistenceCannotAuthorizePermanentOrForeignDecision() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "relevance", withExtension: "json"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let rows = try XCTUnwrap(fixture["evaluations"] as? [[String: Any]])
        let row = try XCTUnwrap(rows.first { row in
            let item = row["item"] as? [String: Any]
            return (item?["deadlines"] as? [String: Any])?["kind"] as? String == "decision"
        })
        let original = try XCTUnwrap(row["item"] as? [String: Any])
        let identity = try XCTUnwrap(original["identity"] as? [String: Any])
        var variants: [[String: Any]] = []
        var missingDeadline = original
        var deadlines = try XCTUnwrap(original["deadlines"] as? [String: Any])
        deadlines["actionExpiresAt"] = NSNull()
        missingDeadline["deadlines"] = deadlines
        variants.append(missingDeadline)
        for change in [["generation": 0], ["revision": 9_007_199_254_740_992]] {
            var invalid = original
            invalid["identity"] = identity.merging(change) { _, new in new }
            variants.append(invalid)
        }
        var incomplete = original
        incomplete["supersededAt"] = "2026-09-30T12:00:00Z"
        variants.append(incomplete)
        incomplete["supersededBy"] = identity.merging(["sourceId": "foreign_source", "revision": 2]) { _, new in new }
        variants.append(incomplete)
        for variant in variants {
            XCTAssertThrowsError(try decoder().decode(RelevanceItem.self, from: JSONSerialization.data(withJSONObject: variant)))
        }
    }

    private func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { input in
            let value = try input.singleValueContainer().decode(String.self)
            return try Self.parseDate(value)
        }
        return decoder
    }

    private static func parseDate(_ value: String) throws -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return try XCTUnwrap(formatter.date(from: value))
    }
    private func date(_ value: String) throws -> Date { try Self.parseDate(value) }

    private struct Fixture: Decodable {
        let version: Int
        let policies: [PolicyCase]
        let evaluations: [EvaluationCase]
        let transitions: [TransitionCase]
    }
    private struct PolicyCase: Decodable {
        let name: String
        let policy: RelevancePolicy
        let occurredAt: Date
        let acceptedAt: Date
        let expected: RelevanceDeadlines
    }
    private struct EvaluationCase: Decodable {
        let name: String
        let item: RelevanceItem
        let now: Date
        let clockTrusted: Bool
        let current: SubjectVersion?
        let expected: RelevanceEvaluation
    }
    private struct TransitionCase: Decodable {
        let name: String
        let actor: SubjectActor
        let candidate: SubjectVersion
        let current: SubjectVersion?
        let operation: SubjectVersion.Operation
        let expected: String
    }
}
