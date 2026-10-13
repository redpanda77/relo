import Foundation
@testable import ReloCore
import Testing

@Suite("A card shows once on the Lock Screen")
struct LiveActivityDuplicatesTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let card = LiveActivityIdentity(activityID: "act_one", generation: 1)

    @Test func theCopyFurthestAlongSurvives() {
        let redundant = LiveActivityDuplicates.redundant([
            .init(nativeID: "push", identity: card, sequence: 2, updatedAt: now),
            .init(nativeID: "local", identity: card, sequence: 1, updatedAt: now.addingTimeInterval(5)),
            .init(nativeID: "other", identity: .init(activityID: "act_two", generation: 1), sequence: 0, updatedAt: now),
        ])
        #expect(redundant == ["local"])
    }

    @Test func tiesAreBrokenStably() {
        let entries: [LiveActivityDuplicates.Entry] = [
            .init(nativeID: "b", identity: card, sequence: 1, updatedAt: now),
            .init(nativeID: "a", identity: card, sequence: 1, updatedAt: now),
        ]
        #expect(LiveActivityDuplicates.redundant(entries) == ["b"])
        #expect(LiveActivityDuplicates.redundant(entries.reversed()) == ["b"])
        #expect(LiveActivityDuplicates.redundant([entries[0]]).isEmpty)
    }
}
