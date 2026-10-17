import Foundation
import XCTest
@testable import ReloCore

/// Plan trees and rounds (ADR 0012): decoding never fails on the new fields, sealed v2 text carries
/// round outcomes and step details, and the outline folds what is finished.
final class PlanTreeTests: XCTestCase {
    private func digest(_ plan: String, rounds: String = "") throws -> InboxCardDigest {
        let json = """
        {"state":"active","updates":2,"startedAt":"2026-10-16T10:00:00Z","plan":\(plan)\(rounds.isEmpty ? "" : ",\"rounds\":\(rounds)")}
        """
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(InboxCardDigest.self, from: Data(json.utf8))
    }

    func testPlanStepsDecodeParentRoundAndDetail() throws {
        let card = try digest("""
        [{"id":"s1","state":"done","label":"Build","round":1},
         {"id":"s2","state":"current","label":"Test","parent":"s1","round":1,"detail":"All suites"},
         {"id":"s3","state":"skipped","label":"Lint"}]
        """, rounds: """
        [{"n":1,"state":"closed","title":"Ship","outcome":"Shipped","openedAt":"2026-10-16T10:00:00Z"},{"n":2,"state":"open"}]
        """)
        let plan = try XCTUnwrap(card.plan)
        XCTAssertEqual(plan.map(\.parent), [nil, "s1", nil])
        XCTAssertEqual(plan.map(\.round), [1, 1, nil])
        XCTAssertEqual(plan[1].detail, "All suites")
        XCTAssertEqual(plan[2].state, "skipped")
        let rounds = try XCTUnwrap(card.rounds)
        XCTAssertEqual(rounds.map(\.n), [1, 2])
        XCTAssertEqual(rounds.map(\.closed), [true, false])
        XCTAssertEqual(rounds[0].outcome, "Shipped")
        XCTAssertNotNil(rounds[0].openedAt)
    }

    func testUnknownOrWrongTypedFieldsNeverHideThePlan() throws {
        let card = try digest("""
        [{"id":"s1","state":"open","label":"A","parent":7,"round":"two","detail":false,"future":1},
         {"id":"s2","state":"someday","label":"B","round":0}]
        """, rounds: """
        [{"n":1,"state":"paused","title":3},{"nope":true},{"n":2,"state":"open","outcome":"x","extra":[1]}]
        """)
        XCTAssertEqual(card.plan?.map(\.id), ["s1", "s2"])
        XCTAssertNil(card.plan?[0].parent)
        XCTAssertNil(card.plan?[0].round)
        XCTAssertNil(card.plan?[1].round)
        XCTAssertEqual(card.rounds?.map(\.n), [1, 2])
        XCTAssertEqual(card.rounds?.map(\.closed), [false, false])
        XCTAssertNil(card.rounds?[0].title)
    }

    func testAnOlderPlanWithoutTheNewFieldsReadsAsOneOpenRound() throws {
        let card = try digest(#"[{"id":"s1","state":"current","label":"A"}]"#)
        XCTAssertNil(card.rounds)
        let outline = PlanOutline.make(entries: [.init(id: "s1", label: "A", state: .current)], rounds: card.rounds)
        XCTAssertTrue(outline.isFlat)
        XCTAssertEqual(outline.rounds.count, 1)
        XCTAssertFalse(outline.delivered)
    }

    func testThePlanReadsFromTheWorkSummaryShapeToo() throws {
        let card = try digest(#"{"steps":[{"id":"s1","state":"done","label":"A"}],"rounds":[{"n":1,"state":"closed"}]}"#)
        XCTAssertEqual(card.plan?.map(\.id), ["s1"])
        XCTAssertEqual(card.rounds?.first?.closed, true)
    }

    func testSealedV2PhasesCarryRoundOutcomeAndStepDetail() throws {
        let json = """
        {"title":"Auth","status":"Testing","phases":[
          {"id":"r1","title":"Login","outcome":"Login ships","steps":[{"id":"s1","label":"Build","detail":"Both flows"},{"id":"s2","label":3}]},
          {"id":"r2","title":7,"steps":[{"id":"s3","label":"Docs"}]}]}
        """
        let text = try JSONDecoder().decode(ReloSealedCardText.self, from: Data(json.utf8))
        XCTAssertEqual(text.phases?.first?.outcome, "Login ships")
        XCTAssertNil(text.phases?.last?.title)
        XCTAssertEqual(text.detailsByStepID, ["s1": "Both flows"])
        XCTAssertEqual(text.labelsByStepID["s3"], "Docs")

        // Merged by id into the work the server listed: titles, outcomes, labels and details.
        let server = ReloWork(id: "wrk_1", phases: [
            .init(id: "r1", state: .done, steps: [.init(id: "s1", state: .done), .init(id: "s2", state: .done)]),
            .init(id: "r2", state: .current, steps: [.init(id: "s3", state: .current)])
        ])
        let opened = try XCTUnwrap(ReloWork.opened(server, text: text))
        XCTAssertEqual(opened.phases[0].title, "Login")
        XCTAssertEqual(opened.phases[0].outcome, "Login ships")
        XCTAssertEqual(opened.phases[0].steps[0].label, "Build")
        XCTAssertEqual(opened.phases[0].steps[0].detail, "Both flows")
        XCTAssertNil(opened.phases[1].outcome)
        // Without the sealed text the server's work carries none of it.
        XCTAssertNil(opened.withoutText.phases[0].outcome)
        XCTAssertNil(opened.withoutText.phases[0].steps[0].detail)
    }

    func testOpeningACardKeepsTheTreeFields() throws {
        let step = InboxCardDigest.PlanStep(id: "s2", state: "open", label: nil, parent: "s1", round: 2, detail: nil)
        let plan = InboxItem.openingPlan([step], text: .init(steps: ["Child"]))
        XCTAssertEqual(plan.first?.label, "Child")
        XCTAssertEqual(plan.first?.parent, "s1")
        XCTAssertEqual(plan.first?.round, 2)
    }

    func testOpeningACardFindsV2LabelsAndDetailsByStepID() throws {
        let steps = [InboxCardDigest.PlanStep(id: "s1", state: "done", label: nil),
                     InboxCardDigest.PlanStep(id: "s2", state: "current", label: nil, parent: "s1")]
        let text = try JSONDecoder().decode(ReloSealedCardText.self, from: Data(#"{"phases":[{"id":"r1","steps":[{"id":"s2","label":"Child","detail":"Why"},{"id":"s1","label":"Parent"}]}]}"#.utf8))
        let plan = InboxItem.openingPlan(steps, text: text)
        XCTAssertEqual(plan.map(\.label), ["Parent", "Child"])
        XCTAssertEqual(plan[1].detail, "Why")
    }

    // MARK: Outline

    private func entry(_ id: String, _ state: PlanOutline.State, parent: String? = nil, round: Int = 1,
                       detail: String? = nil) -> PlanOutline.Entry {
        .init(id: id, label: id.uppercased(), state: state, detail: detail, parent: parent, round: round)
    }

    func testAParentHoldingTheCurrentStepReadsAsActiveAndDepthFollowsParents() {
        let outline = PlanOutline.make(entries: [
            entry("a", .pending), entry("b", .current, parent: "a"), entry("c", .pending, parent: "b"), entry("d", .pending)
        ], rounds: nil)
        let nodes = outline.nodes
        XCTAssertEqual(nodes.map(\.depth), [0, 1, 2, 0])
        XCTAssertEqual(nodes[0].state, .current)
        XCTAssertEqual(nodes[1].state, .current)
        XCTAssertEqual(nodes[0].descendantCount, 2)
        XCTAssertTrue(outline.isTree)
        XCTAssertFalse(outline.isFlat)
    }

    func testOnlyTheCurrentStepOpensAndTheOwnerCanOpenAnother() {
        let outline = PlanOutline.make(entries: [
            entry("a", .complete), entry("b", .complete, parent: "a"),
            entry("d", .current), entry("e", .pending, parent: "d"),
            entry("f", .pending), entry("g", .pending, parent: "f")
        ], rounds: nil)
        let round = outline.rounds[0]
        func branches(_ items: [PlanOutline.Item]) -> [PlanOutline.Branch] { items.compactMap { if case let .branch(b) = $0 { b } else { nil } } }
        var top = branches(outline.items(in: round))
        XCTAssertEqual(top.map(\.opened), [false, true, false])
        XCTAssertEqual(top[1].children.count, 1)
        XCTAssertEqual(top[0].count, .init(done: 1, total: 1))
        XCTAssertEqual(top.map(\.position), [1, 2, 3])
        top = branches(outline.items(in: round, openedSteps: ["f"]))
        XCTAssertEqual(top.map(\.opened), [false, true, true])
    }

    func testClosedRoundsFoldAndTheOpenRoundIsExpandedWithTitlesFromTheSealedText() {
        let rounds = [InboxCardDigest.PlanRound(n: 1, closed: true, title: "Login", outcome: "Shipped"),
                      InboxCardDigest.PlanRound(n: 2)]
        let outline = PlanOutline.make(
            entries: [entry("a", .complete), entry("b", .current, round: 2)],
            rounds: rounds, titles: [2: "Logout"], outcomes: [1: "ignored"])
        XCTAssertTrue(outline.hasRoundSections)
        XCTAssertEqual(outline.rounds.map(\.heading), ["Round 1 · Login", "Round 2 · Logout"])
        XCTAssertEqual(outline.rounds[0].outcome, "Shipped")
        XCTAssertEqual(outline.currentRound?.n, 2)
        XCTAssertEqual(outline.rounds.map { outline.startsFolded($0) }, [true, false])
        XCTAssertFalse(outline.delivered)
        XCTAssertEqual(outline.progress?.count, "Round 2 · 0 of 1")
    }

    func testAnEmptyOrWithoutTitleRoundStillHasAHeading() {
        let outline = PlanOutline.make(entries: [], rounds: [.init(n: 1, closed: true), .init(n: 2)])
        XCTAssertEqual(outline.rounds.map(\.heading), ["Round 1", "Round 2"])
        XCTAssertTrue(outline.rounds[1].nodes.isEmpty)
    }

    func testAWorkWhoseLastRoundIsClosedIsDelivered() {
        let outline = PlanOutline.make(entries: [entry("a", .complete)], rounds: [.init(n: 1, closed: true, outcome: "Done and tested")])
        XCTAssertTrue(outline.delivered)
        XCTAssertEqual(outline.deliveredOutcome, "Done and tested")
        XCTAssertTrue(outline.isFlat)
    }

    func testSkippedStepsMapAndStayOutOfTheCount() {
        let steps = [LiveActivityDisplayPresentation.Step(id: "a", label: "A", state: .complete),
                     .init(id: "b", label: "B", state: .skipped), .init(id: "c", label: "C", state: .current)]
        let display = LiveActivityPlanDisplay.steps(steps)
        XCTAssertEqual(display.map(\.state), [.done, .skipped, .current])
        XCTAssertEqual(LiveActivityPlanDisplay.line(display), "Step 2 of 2 · C")
        XCTAssertEqual(LiveActivityPlanDisplay.tally(display).total, 2)
    }

    func testAStepsComponentWithASkippedStepRoundTrips() throws {
        let step = LiveActivityDisplayPresentation.Step(id: "b", label: "B", state: .skipped)
        let data = try JSONEncoder().encode(step)
        XCTAssertEqual(try JSONDecoder().decode(LiveActivityDisplayPresentation.Step.self, from: data), step)
    }

    // MARK: Folds, skipped steps, unreadable labels (4.7, U8)

    private func many(_ count: Int, current: Int) -> PlanOutline {
        PlanOutline.make(entries: (1...count).map { i in entry("m\(i)", i < current ? .complete : i == current ? .current : .pending) },
                         rounds: nil)
    }

    func testALongRoundFoldsDoneAndToGoAroundTheCurrentStep() {
        let outline = many(16, current: 9)
        var items = outline.items(in: outline.rounds[0])
        // 6 done folded, 2 finished, the current step, the next 3, 4 to go folded.
        XCTAssertEqual(items.count, 1 + 2 + 1 + 3 + 1)
        guard case let .fold(first) = items.first, case let .fold(lastFold) = items.last else { return XCTFail("folds") }
        XCTAssertEqual(first.text, "6 done")
        XCTAssertEqual(lastFold.text, "4 to go")
        items = outline.items(in: outline.rounds[0], expandedFolds: [first.id, lastFold.id])
        XCTAssertEqual(items.count, 16)
    }

    func testAPlanOfSevenIsNeverWindowedAndAFoldNeverHidesOneStep() {
        XCTAssertEqual(many(7, current: 4).items(in: many(7, current: 4).rounds[0]).count, 7)
        // 8 steps, current 3: nothing before to fold (start < 2), 4 after the window... only 1 left would show.
        let outline = many(8, current: 3)
        let items = outline.items(in: outline.rounds[0])
        XCTAssertFalse(items.contains { if case let .fold(f) = $0 { f.count < 2 } else { false } })
    }

    func testSkippedStepsHideBehindOneRowAndUnreadableLabelsNeverReadStepN() {
        let outline = PlanOutline.make(entries: [
            entry("a", .complete), entry("b", .skipped), entry("c", .skipped),
            .init(id: "d", label: "Step 4", state: .current, readable: false)], rounds: nil)
        var items = outline.items(in: outline.rounds[0])
        guard case let .fold(fold) = items.last else { return XCTFail("skipped row") }
        XCTAssertEqual(fold.text, "2 skipped")
        XCTAssertEqual(items.count, 3)
        XCTAssertEqual(outline.node("d")?.shownLabel, "Not readable on this phone")
        items = outline.items(in: outline.rounds[0], expandedFolds: [fold.id])
        XCTAssertEqual(items.count, 4)
        // A stopped work's skipped steps are not done and not skipped.
        XCTAssertEqual(outline.unskipped().node("b")?.state, .pending)
    }

    func testMoreThanThreeRoundsFoldTheEarlierOnes() {
        let rounds = (1...5).map { InboxCardDigest.PlanRound(n: $0, closed: $0 < 5) }
        let outline = PlanOutline.make(entries: [], rounds: rounds)
        XCTAssertEqual(outline.roundSlots(earlierExpanded: false).map(\.id), ["earlier", "round-4", "round-5"])
        XCTAssertEqual(outline.roundSlots(earlierExpanded: true).count, 5)
        XCTAssertEqual(PlanOutline.make(entries: [], rounds: Array(rounds.prefix(3))).roundSlots(earlierExpanded: false).count, 3)
    }

    func testDurationLabels() {
        XCTAssertNil(PlanOutline.durationLabel(30))
        XCTAssertEqual(PlanOutline.durationLabel(240), "4 min")
        XCTAssertEqual(PlanOutline.durationLabel(7200), "2 h")
        XCTAssertEqual(PlanOutline.durationLabel(3900), "1 h 5 min")
    }
}
