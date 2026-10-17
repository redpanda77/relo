import Foundation
import Testing
@testable import ReloCore

/// PlanProgress against packages/contracts/test/fixtures/plan-progress.json (the contracts function's cases), plus
/// the hand-written cases the phone adds: header, line pieces and the card's own `progress` object.
@Suite struct PlanProgressTests {
    private struct Case: Decodable {
        struct Plan: Decodable {
            struct Step: Decodable { let id: String; let state: String; let label: String?; let parent: String?; let round: Int?; let carriedFrom: Int? }
            struct Round: Decodable { let n: Int; let state: String; let title: String?; let outcome: String? }
            let steps: [Step]
            let rounds: [Round]?
        }
        struct Expected: Decodable {
            struct Sub: Decodable { let done: Int; let total: Int }
            let round: Int; let rounds: Int; let delivered: Bool; let done: Int; let total: Int
            let currentId: String?; let current: Int?; let sub: Sub?
        }
        struct Variant: Decodable {
            struct Options: Decodable { let paused: Bool?; let ended: String? }
            let options: Options; let text: String
        }
        struct ProgressOptions: Decodable { let stopped: Bool? }
        let name: String; let plan: Plan; let expected: Expected; let text: String
        let variants: [Variant]?; let progressOptions: ProgressOptions?
    }

    private static func cases() throws -> [Case]? {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        let file = url.appendingPathComponent("packages/contracts/test/fixtures/plan-progress.json")
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try JSONDecoder().decode([Case].self, from: data)
    }

    private static func outline(_ plan: Case.Plan) -> PlanOutline {
        let entries = plan.steps.map { step -> PlanOutline.Entry in
            let state: PlanOutline.State = switch step.state {
            case "done": .complete
            case "current": .current
            case "skipped": .skipped
            default: .pending
            }
            return .init(id: step.id, label: step.label ?? "Step", state: state, parent: step.parent, round: step.round ?? 1,
                         readable: step.label != nil, carriedFrom: step.carriedFrom)
        }
        let rounds = plan.rounds?.map { InboxCardDigest.PlanRound(n: $0.n, closed: $0.state == "closed", title: $0.title, outcome: $0.outcome) }
        return PlanOutline.make(entries: entries, rounds: rounds)
    }

    private static func standing(_ options: Case.Variant.Options) -> PlanProgress.Standing {
        if options.paused == true { return .paused }
        switch options.ended {
        case "finished"?: return .done
        case "dropped"?, "failed"?: return .stopped
        default: return .moving
        }
    }

    @Test func matchesTheContractsFixture() throws {
        guard let cases = try Self.cases() else { return }   // the fixture lives with the contracts package
        for c in cases {
            let outline = Self.outline(c.plan)
            guard let progress = PlanProgress.make(outline: outline, stopped: c.progressOptions?.stopped == true) else {
                #expect(c.expected.total == 0, "\(c.name)")
                continue
            }
            let e = c.expected
            #expect(progress.done == e.done && progress.total == e.total, "\(c.name)")
            #expect(progress.currentId == e.currentId && progress.current == e.current, "\(c.name)")
            #expect(progress.sub?.done == e.sub?.done && progress.sub?.total == e.sub?.total, "\(c.name)")
            #expect(progress.round == e.round && progress.rounds == e.rounds && progress.delivered == e.delivered, "\(c.name)")
            let label = progress.currentId.flatMap { outline.node($0) }.map { $0.readable ? $0.label : PlanProgress.unreadable }
            #expect(progress.line(label: label) == c.text, "\(c.name)")
            for variant in c.variants ?? [] {
                #expect(progress.line(label: label, standing: Self.standing(variant.options)) == variant.text, "\(c.name) \(variant.text)")
            }
        }
    }

    // Cases that do not need the fixture (the same shapes, written out).

    private func e(_ id: String, _ state: PlanOutline.State, parent: String? = nil, round: Int = 1) -> PlanOutline.Entry {
        .init(id: id, label: id.uppercased(), state: state, parent: parent, round: round)
    }

    @Test func theServersStepsComponentCarriesProgressAsPlan() throws {
        let json = #"{"id":"steps","type":"steps","colorRole":"project","items":[{"id":"s2","label":"Patch","state":"current"}],"before":1,"after":2,"plan":{"done":1,"total":4,"currentId":"s2","sub":{"done":1,"total":3},"round":1,"rounds":1,"delivered":false}}"#
        let component = try JSONDecoder().decode(LiveActivityPresentation.Component.self, from: Data(json.utf8))
        guard case let .steps(_, _, _, window) = component else { Issue.record("not a steps component"); return }
        #expect(window.progress?.done == 1)
        #expect(window.progress?.total == 4)
        #expect(window.progress?.sub?.total == 3)
        let again = try JSONDecoder().decode(LiveActivityPresentation.Component.self, from: JSONEncoder().encode(component))
        #expect(again == component)
    }

    @Test func aPlanStepDecodesCarriedFromAndDropped() throws {
        let step = try JSONDecoder().decode(InboxCardDigest.PlanStep.self, from: Data(#"{"id":"s5","state":"open","round":2,"carriedFrom":1,"dropped":true}"#.utf8))
        #expect(step.carriedFrom == 1 && step.dropped == true)
        let plain = try JSONDecoder().decode(InboxCardDigest.PlanStep.self, from: Data(#"{"id":"s1","state":"open"}"#.utf8))
        #expect(plain.carriedFrom == nil && plain.dropped == nil)
    }

    @Test func flatPlanCountsStepsAndNamesTheCurrentOne() throws {
        let outline = PlanOutline.make(entries: [e("a", .complete), e("b", .complete), e("c", .current), e("d", .pending), e("e", .pending)], rounds: nil)
        let p = try #require(outline.progress)
        #expect(p.done == 2 && p.total == 5 && p.currentId == "c" && p.sub == nil)
        #expect(p.line(label: "C") == "Step 3 of 5 · C")
        #expect(p.header() == "Step 3 of 5")
        #expect(p.compact == "2/5")
        #expect(p.line(label: "C", standing: .paused) == "Paused at 2 of 5")
        #expect(p.line(label: "C", standing: .stopped) == "Stopped at 2 of 5")
    }

    @Test func nestedPlanCountsTopLevelStepsAndTheOpenStepsOwnCount() throws {
        let outline = PlanOutline.make(entries: [
            e("a", .complete), e("b", .pending), e("b1", .complete, parent: "b"), e("b2", .current, parent: "b"),
            e("b3", .pending, parent: "b"), e("c", .pending)], rounds: nil)
        let p = try #require(outline.progress)
        #expect(p.done == 1 && p.total == 3 && p.currentId == "b" && p.sub == .init(done: 1, total: 3))
        #expect(p.line(label: "B") == "Step 2 of 3 · B · 1/3")
    }

    @Test func severalRoundsCountTheRoundInPlayAndNameItInTheHeader() throws {
        let rounds = [InboxCardDigest.PlanRound(n: 1, closed: true), .init(n: 2, closed: true), .init(n: 3)]
        let outline = PlanOutline.make(entries: [e("a", .complete), e("b", .complete, round: 2), e("c", .current, round: 3), e("d", .pending, round: 3)], rounds: rounds)
        let p = try #require(outline.progress)
        #expect(p.done == 0 && p.total == 2 && p.round == 3 && p.rounds == 3)
        #expect(p.header() == "Round 3 · Step 1 of 2")
        #expect(p.line(label: "C") == "Step 1 of 2 · C")   // no round number on the Lock Screen
    }

    @Test func aDeliveredRoundReadsAsDeliveredWhileMovingAndAsDoneWhenFinished() throws {
        let outline = PlanOutline.make(entries: [e("a", .complete), e("b", .complete, round: 2)],
                                       rounds: [.init(n: 1, closed: true), .init(n: 2, closed: true)])
        let p = try #require(outline.progress)
        #expect(p.delivered && p.line(label: nil) == "Round 2 delivered" && p.header() == "Round 2 delivered")
        #expect(p.line(label: nil, standing: .done) == "1 of 1 done")
    }

    @Test func skippedStepsAreNotCountedUnlessTheWorkStopped() throws {
        let outline = PlanOutline.make(entries: [e("a", .complete), e("b", .skipped), e("c", .current)], rounds: nil)
        #expect(outline.progress?.total == 2)
        #expect(PlanProgress.make(outline: outline, stopped: true)?.total == 3)
    }

    @Test func aRevisedPlanKeepsItsIdsAndAnUnreadableLabelSaysSo() throws {
        let outline = PlanOutline.make(entries: [e("a", .complete), .init(id: "z", label: "Step 2", state: .current, readable: false)], rounds: nil)
        let p = try #require(outline.progress)
        #expect(p.currentId == "z")
        #expect(p.line(label: outline.node("z")?.shownLabel == nil ? nil : PlanProgress.unreadable) == "Step 2 of 2 · Not readable")
    }

    @Test func aLegacyFlatWindowCountsWithoutIds() throws {
        typealias S = LiveActivityPlanDisplay.Step
        let p = try #require(PlanProgress.make(steps: [S(label: "A", state: .done), S(label: "B", state: .current), S(label: "C", state: .open)]))
        #expect(p.done == 1 && p.total == 3 && p.currentId == nil)
        #expect(PlanProgress.make(steps: []) == nil)
    }

    @Test func theCardsProgressObjectDecodesTolerantly() throws {
        let json = #"{"done":2,"total":5,"currentId":"s3","sub":{"done":1,"total":3},"round":2,"rounds":3,"delivered":false,"extra":1}"#
        let p = try JSONDecoder().decode(PlanProgress.self, from: Data(json.utf8))
        #expect(p == PlanProgress(done: 2, total: 5, currentId: "s3", sub: .init(done: 1, total: 3), round: 2, rounds: 3))
        let minimal = try JSONDecoder().decode(PlanProgress.self, from: Data(#"{"done":0,"total":0,"sub":"x","round":"y"}"#.utf8))
        #expect(minimal.round == 1 && minimal.sub == nil)
    }

    // Plan 14, workstream 7: the fixture the server and the Dashboard read. 4 top-level steps, the first with 3
    // substeps (2 done), and a stale work-level count: done 0 of 4, step 1 current, its segment 2/3 full, no percentage.
    @Test func topLevelStepsAreTheBarsUnitAndTheCurrentSegmentFillsByTheServersFraction() throws {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        let data = try Data(contentsOf: url.appendingPathComponent("packages/contracts/test/fixtures/plan-card.json"))
        struct Fixture: Decodable {
            struct Segment: Decodable { let state: String; let fill: Double }
            struct Expected: Decodable { let caption: String; let segments: [Segment] }
            struct Card: Decodable { let labels: [String]; let current: Int; let plan: PlanProgress }
            let card: Card; let expected: Expected
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        let wire = fixture.card.plan
        #expect(wire.done == 0 && wire.total == 4 && wire.current == 1)
        #expect(abs((wire.fill ?? 0) - 2.0 / 3.0) < 0.0001)
        #expect(wire.lineParts(label: nil)?.lead == fixture.expected.caption)

        // Lock Screen: the card's four labels, the server's current index and fraction.
        typealias S = LiveActivityPlanDisplay.Step
        let steps = fixture.card.labels.enumerated().map { S(label: $1, state: $0 + 1 == fixture.card.current ? .current : .open) }
        let lock = PlanBar.make(steps: steps, fill: wire.fill)
        #expect(lock.segments.count == 4)
        #expect(lock.segments.map { $0.state.rawValue } == fixture.expected.segments.map(\.state))
        for (segment, expected) in zip(lock.segments, fixture.expected.segments) { #expect(abs(segment.fill - expected.fill) < 0.0001) }

        // Now row: the server's `progress` wins over the older flattened `steps` (7), so the in-app card agrees.
        var item = try ReloWireJSON.decoder().decode(NowItem.self, from: Data(Self.nowItemJSON.utf8))
        item.progress = wire
        item.steps = .init(done: 2, total: 7, current: nil)
        let row = try #require(item.planSteps)
        #expect(row.done == 0 && row.total == 4 && row.currentIndex == 1)
        #expect(row.bar == lock)
        #expect(PlanProgress.make(steps: steps).map { $0.fill } == .some(nil))
    }

    private static let nowItemJSON = #"""
    {"id":"act_00000000-0000-0000-0000-000000000001","title":"Migrate","status":null,"sourceName":null,"project":null,
     "steps":null,"producer":"agent","sessionId":null,"notificationId":null,
     "startedAt":"2026-10-17T10:00:00Z","declaredAt":"2026-10-17T10:00:00Z",
     "owner":{"state":"working","needsYou":null,"evidenceAt":"2026-10-17T10:00:00Z","evidenceSource":"declared","staleDate":"2026-10-17T11:00:00Z","lockScreen":"none","relevance":0,"apnsPriority":5}}
    """#

    @Test func aBarWithoutAServerPositionInventsNoCurrentSegment() {
        let bar = PlanBar.make(done: 1, total: 3, current: nil, fill: nil)
        #expect(bar.segments.map(\.state) == [.done, .open, .open])
        #expect(PlanBar.make(done: 3, total: 3, current: 2, fill: 0.5).segments.allSatisfy { $0.state == .done && $0.fill == 1 })
    }

    @Test func aHistoryCardDigestCarriesTheServersPositionAndFillAndAnOldOneStillDecodes() throws {
        let wire = try JSONDecoder().decode(InboxCardDigest.Steps.self, from: Data(#"{"done":0,"total":4,"current":"A","currentIndex":1,"fill":0.67}"#.utf8))
        #expect(wire.currentIndex == 1 && wire.fill == 0.67)
        let old = try JSONDecoder().decode(InboxCardDigest.Steps.self, from: Data(#"{"done":2,"total":5,"current":null}"#.utf8))
        #expect(old.currentIndex == nil && old.fill == nil)
        let row = HistoryRow.Steps(done: 0, total: 4, current: "A", currentIndex: wire.currentIndex, fill: wire.fill)
        #expect(PlanProgress(done: row.done, total: row.total, current: row.currentIndex).line(label: row.current) == "Step 1 of 4 · A")
    }
}
