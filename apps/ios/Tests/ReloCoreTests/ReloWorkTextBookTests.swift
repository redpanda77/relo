import Testing
@testable import ReloCore

// A History event's own text predates the rounds the work's current plan draws: a newer copy of the same work names them.
struct ReloWorkTextBookTests {
    private let roundSeventeen = ReloWork(id: "wrk_1", phases: [
        .init(id: "r17", title: "Review the plan", outcome: "Proposed a fix", steps: [.init(id: "s76", label: "Read the plan")]),
    ])
    private let roundEighteen = ReloWork(id: "wrk_1", phases: [
        .init(id: "r17", title: "Review the plan", outcome: "Proposed a fix", steps: [.init(id: "s76", label: "Read the plan again")]),
        .init(id: "r18", title: "Run one iteration", steps: [.init(id: "s79", label: "Record the order"), .init(id: "s80", label: "Step 2")]),
    ])

    @Test func laterRoundsReadFromTheNewestCopy() {
        let text = ReloWork.TextBook(newestFirst: [roundEighteen, roundSeventeen])
        #expect(text.labels["s79"] == "Record the order")
        #expect(text.titles[18] == "Run one iteration")
        #expect(text.outcomes[17] == "Proposed a fix")
    }

    @Test func theNewestLabelWinsAndPlaceholdersNeverCount() {
        let text = ReloWork.TextBook(newestFirst: [roundEighteen, roundSeventeen])
        #expect(text.labels["s76"] == "Read the plan again")
        #expect(text.labels["s80"] == nil)
    }

    @Test func anOlderCopyFillsWhatTheNewestLacks() {
        let text = ReloWork.TextBook(newestFirst: [ReloWork(id: "wrk_1", phases: [.init(id: "r17", steps: [.init(id: "s76")])]), roundSeventeen])
        #expect(text.labels["s76"] == "Read the plan")
        #expect(text.titles[17] == "Review the plan")
    }
}
