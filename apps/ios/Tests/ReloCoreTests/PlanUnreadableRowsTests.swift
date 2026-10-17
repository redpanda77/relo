import Testing
@testable import ReloCore

// U8: steps this phone cannot open read as one quiet row per run, not one placeholder per step.
struct PlanUnreadableRowsTests {
    private func branch(_ id: String, _ state: PlanOutline.State, readable: Bool) -> PlanOutline.Item {
        let outline = PlanOutline.make(entries: [.init(id: id, label: id, state: state, readable: readable)], rounds: nil)
        let items = outline.rounds.first.map { outline.items(in: $0) } ?? []
        return items[0]
    }

    @Test func runsOfUnreadableStepsReadAsOneRow() {
        let items = [branch("a", .complete, readable: false), branch("b", .complete, readable: false),
                     branch("c", .current, readable: true), branch("d", .pending, readable: false), branch("e", .pending, readable: false)]
        let rows = PlanOutline.rows(items)
        #expect(rows.count == 3)
        #expect(rows[0] == .unreadable(id: "a", state: .complete, count: 2))
        #expect(rows[2] == .unreadable(id: "d", state: .pending, count: 2))
        #expect(PlanOutline.Row.text(state: .complete, count: 2) == "2 done · names not readable on this phone")
    }

    @Test func aSingleUnreadableStepStaysItsOwnRow() {
        let items = [branch("a", .complete, readable: false), branch("b", .current, readable: true)]
        #expect(PlanOutline.rows(items).count == 2)
    }
}
