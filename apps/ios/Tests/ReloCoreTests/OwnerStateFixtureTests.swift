import Foundation
import Testing
@testable import ReloCore

struct OwnerStateFixtureTests {
    private func fixture() throws -> Data {
        let url = try #require(Bundle.module.url(forResource: "owner-state-v1", withExtension: "json"))
        return try Data(contentsOf: url)
    }

    @Test func fixtureDecodesEveryDeriveCaseAndTheNowSummary() throws {
        struct Case: Decodable { let name: String; let expected: OwnerStateResult }
        struct Fixture: Decodable { let derive: [Case]; let nowSummary: NowSummary }
        let decoded = try ReloWireJSON.decoder().decode(Fixture.self, from: fixture())
        #expect(!decoded.derive.isEmpty)
        for item in decoded.derive {
            if case .unknown(let raw) = item.expected.state { Issue.record("unknown state \(raw) in \(item.name)") }
        }
        #expect(decoded.nowSummary.lockScreen.cards.count <= 3)
    }

    @Test func fixtureIsByteIdenticalToContracts() throws {
        let contracts = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().appendingPathComponent("../../../../packages/contracts/fixtures/owner-state-v1.json")
            .standardizedFileURL
        #expect(try fixture() == Data(contentsOf: contracts))
    }

    @Test func computerIconsDecodeOnItemsSessionsAndClientKeys() throws {
        struct Fixture: Decodable { let nowSummary: NowSummary }
        let summary = try ReloWireJSON.decoder().decode(Fixture.self, from: fixture()).nowSummary
        #expect(summary.needsYou.first?.computerIcon == .laptop)
        #expect(summary.sessions.sessions.compactMap(\.computerIcon) == [.laptop, .desktop])
        #expect(summary.sessions.sessions.last?.computerIcon == nil)
        // An icon this build does not know reads as a laptop; a server that sends none leaves it nil.
        let future = try JSONDecoder().decode(ReloClientKey.self, from: Data(
            #"{"clientId":"key_a","name":"Box","keyId":"k","publicKey":"p","changedAt":"x","icon":"spaceship"}"#.utf8))
        #expect(future.icon == .laptop)
        let older = try JSONDecoder().decode(ReloClientKey.self, from: Data(
            #"{"clientId":"key_a","name":"Box","keyId":"k","publicKey":"p","changedAt":"x"}"#.utf8))
        #expect(older.icon == nil)
        let server = try JSONDecoder().decode(ReloClientKey.self, from: Data(
            #"{"clientId":"key_a","name":"Box","keyId":"k","publicKey":"p","changedAt":"x","icon":"server"}"#.utf8))
        #expect(server.icon == .server && server.icon?.systemImageName == "server.rack")
        #expect(ComputerIcon.allCases.map(\.rawValue) == ["laptop", "desktop", "server", "cloud", "terminal", "build"])
    }

    @Test func unknownStateDecodes() throws {
        let state = try JSONDecoder().decode(OwnerState.self, from: Data(#""future_state""#.utf8))
        #expect(state == .unknown("future_state"))
        #expect(state.chip == nil)
    }

    @Test func liveActivityOwnerChipsAndCount() throws {
        let missed = try JSONDecoder().decode(LiveActivityOwner.self, from: Data(
            #"{"state":"needs_you","placement":"top","needsYouCount":12,"declaredAt":"2026-10-14T08:00:00.000Z","needsYou":"missed_question"}"#.utf8))
        #expect(missed.chip == .missed)
        #expect(missed.needsYouCountLabel == "9+")
        let quiet = LiveActivityOwner(state: "stale", placement: "dimmed", needsYouCount: 0, declaredAt: .now)
        #expect(quiet.chip == .quiet && quiet.needsYouCountLabel == nil)
        let roundTrip = try JSONDecoder().decode(LiveActivityOwner.self, from: JSONEncoder().encode(quiet))
        #expect(roundTrip.chip == .quiet)
    }
}
