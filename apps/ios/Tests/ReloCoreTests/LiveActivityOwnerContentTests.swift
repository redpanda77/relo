import Foundation
import Testing
@testable import ReloCore

/// Live Activity content state carries the server's owner state (plan 1.13a, DOGFOOD #9).
/// Display only: chips come from the state the server wrote; the island shows one number.
@Suite("Live Activity owner content state")
struct LiveActivityOwnerContentTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func owner(_ state: String, needsYou: String? = nil, count: Int = 0,
                       placement: String = "shown") -> LiveActivityOwner {
        LiveActivityOwner(state: state, placement: placement, needsYouCount: count,
                          declaredAt: now.addingTimeInterval(-600), needsYou: needsYou)
    }

    private func presentation(_ components: [LiveActivityPresentation.Component]) -> LiveActivityPresentation {
        let ids = components.map(\.id)
        return .init(
            title: "Ship slice 1", subtitle: nil, status: "Working", components: components,
            surfaces: .init(lockScreen: ids, expandedBottom: ids, compactTrailing: ids, minimal: Array(ids.prefix(1))),
            state: .init(kind: "active", tone: "live", icon: .active), behavior: .progress)
    }

    private func steps(done: Int, total: Int) -> LiveActivityPresentation.Component {
        .steps(id: "steps", colorRole: .thread, items: (0..<total).map { index in
            .init(id: "st_\(index)", label: "Step \(index + 1)",
                  state: index < done ? .complete : index == done ? .current : .pending)
        })
    }

    @Test("Each owner state has its chip (text, never color alone)", arguments: [
        ("needs_you", OwnerChip?.some(.needsYou)), ("waiting_on_you", .yourTurn), ("working_quietly", .working),
        ("stale", .quiet), ("stopped_responding", .quiet), ("no_signal", .quiet), ("done", .done),
        ("failed", .failed), ("moving", nil), ("paused", nil), ("dropped", nil), ("left_unfinished", nil),
        ("future_state", nil),
    ])
    func chipPerState(state: String, chip: OwnerChip?) {
        #expect(owner(state).chip == chip)
        let p = LiveActivitySurfaceProjection.make(presentation: presentation([]), surface: .lockScreen,
                                                   owner: owner(state), now: now)
        #expect(p.chip == chip)
        if let chip { #expect(!chip.label.isEmpty && !chip.accessibilityLabel.isEmpty) }
    }

    @Test("A missed question reads MISSED and has no inline answer")
    func missedChip() {
        let missed = owner("needs_you", needsYou: "missed_question", count: 1)
        #expect(missed.chip == .missed)
        #expect(missed.isMissedQuestion)
        let p = LiveActivitySurfaceProjection.make(presentation: presentation([]), surface: .lockScreen,
                                                   owner: missed, now: now)
        #expect(!p.permitsInlineResponse)
        #expect(p.status.hasPrefix("Missed"))
    }

    @Test("The needs-you count wins compact trailing and minimal; 10+ reads 9+")
    func needsYouCountWins() {
        let p = LiveActivitySurfaceProjection.make(presentation: presentation([steps(done: 1, total: 4)]),
                                                   surface: .compactTrailing, owner: owner("moving", count: 2), now: now)
        #expect(p.needsYouCount == 2)
        #expect(owner("moving", count: 12).needsYouCountLabel == "9+")
        #expect(owner("moving", count: 0).needsYouCountLabel == nil)
        #expect(LiveActivityOwner(state: "moving", placement: "shown", needsYouCount: -3, declaredAt: now).needsYouCount == 0)
        let zero = LiveActivitySurfaceProjection.make(presentation: presentation([steps(done: 1, total: 4)]),
                                                      surface: .compactTrailing, owner: owner("moving"), now: now)
        #expect(zero.needsYouCount == nil)
    }

    @Test("DOGFOOD #9: with steps the island shows done/total of the plan, never a card percent")
    func oneNumberInTheIsland() {
        let card = LiveActivityPresentation.Component.progressBar(id: "progress", colorRole: .project, value: 0.67, label: "Build")
        for surface in [LiveActivityPresentation.Surface.compactTrailing, .minimal] {
            let position = LiveActivitySurfaceProjection.make(
                presentation: presentation([steps(done: 1, total: 8), card]), surface: surface, now: now)
            #expect(position.fact == .stages(1, 8), "1 of 8 done, not 67%")
        }
        let counted = LiveActivityPresentation.Component.progressBar(id: "progress", colorRole: .project, value: 0.67,
                                                                     label: "Build slice 1 · 6 of 9")
        let own = LiveActivitySurfaceProjection.make(
            presentation: presentation([steps(done: 1, total: 8), counted]), surface: .compactTrailing, now: now)
        #expect(own.fact == .stages(1, 8), "the plan count, never the step's own count")
        let plain = LiveActivitySurfaceProjection.make(presentation: presentation([card]), surface: .compactTrailing, now: now)
        if case .percentage = plain.fact {} else { Issue.record("a card without steps keeps its measured percent") }
    }

    @Test("Owner content round-trips with Unix seconds and decodes ISO dates and missing fields")
    func ownerCoding() throws {
        let value = owner("waiting_on_you", placement: "your_turn")
        let decoded = try JSONDecoder().decode(LiveActivityOwner.self, from: JSONEncoder().encode(value))
        #expect(decoded == value)
        #expect(decoded.lockScreen == .yourTurn)
        let sparse = try JSONDecoder().decode(LiveActivityOwner.self, from: Data(#"{"state":"stale","declaredAt":"2027-01-15T08:00:00Z"}"#.utf8))
        #expect(sparse.lockScreen == .shown)
        #expect(sparse.needsYouCount == 0)
        #expect(sparse.chip == .quiet)
        let bare = try JSONDecoder().decode(LiveActivityOwner.self, from: Data(#"{"state":"stale"}"#.utf8))
        #expect(bare.declaredAt == nil, "a missing declaredAt is nil, never the epoch (it rendered 'updated 59 days ago')")
        #expect(bare.finishedAt == nil)
        let unknownPlacement = try JSONDecoder().decode(LiveActivityOwner.self, from: Data(#"{"state":"moving","placement":"orbit","declaredAt":1800000000}"#.utf8))
        #expect(unknownPlacement.lockScreen == .shown, "unknown placement renders the shown layout")
    }

    @Test("The owner block carries the island's live count; an older push without it reads zero")
    func liveCount() throws {
        let decode = { (json: String) in try JSONDecoder().decode(LiveActivityOwner.self, from: Data(json.utf8)) }
        let counted = try decode(#"{"state":"moving","placement":"shown","needsYouCount":1,"live":3}"#)
        #expect(counted.live == 3 && counted.needsYouCount == 1)
        #expect(try decode(#"{"state":"moving","placement":"shown","needsYouCount":0}"#).live == 0)
        let again = try decode(String(decoding: JSONEncoder().encode(counted), as: UTF8.self))
        #expect(again.live == 3)
    }

    @Test("Step labels resolve by step id, not by position (sealed v2 text)")
    func labelsByStepID() throws {
        let text = try JSONDecoder().decode(ReloSealedCardText.self, from: Data("""
        {"title":"Ship","phases":[{"id":"p1","steps":[{"id":"st_b","label":"Test"},{"id":"st_a","label":"Build"}]}],
         "steps":["Wrong one","Wrong two"]}
        """.utf8))
        #expect(text.label(forStepID: "st_a", placeholder: "Step 1") == "Build")
        #expect(text.label(forStepID: "st_b", placeholder: "Step 2") == "Test")
        #expect(text.label(forStepID: "st_new", placeholder: "Step 2") == "Wrong two", "v1 fallback by placeholder number")
        let placeholders = try JSONDecoder().decode(ReloSealedCardText.self, from: Data(#"{"phases":[{"id":"p","steps":[{"id":"s","label":"Step 3"}]}]}"#.utf8))
        #expect(placeholders.labelsByStepID.isEmpty, "a placeholder is never a real label")
    }
}

/// Owner surfaces are display only (ADR 0008, plan 1.13/F.1): no client timer decides a state.
@Suite("Owner surfaces display only")
struct OwnerSurfacesDisplayOnlyTests {
    private static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    private func sources(_ directories: [String]) -> [(String, String)] {
        directories.flatMap { directory -> [(String, String)] in
            let base = Self.root.appendingPathComponent("Sources/\(directory)")
            guard let walker = FileManager.default.enumerator(at: base, includingPropertiesForKeys: nil) else { return [] }
            return walker.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }.compactMap { url in
                (try? String(contentsOf: url, encoding: .utf8)).map { (url.lastPathComponent, $0) }
            }
        }
    }

    @Test("No repeating timers or local Live Activity end rules in owner surfaces")
    func noClientTimers() {
        let files = sources(["ReloApp", "ReloCore", "LiveActivities", "SharedActivity"])
        #expect(!files.isEmpty)
        let banned = ["Timer.scheduledTimer", "Timer.publish(", "LiveActivityAbandonmentPolicy", "endAbandonedActivities",
                      "maximumActivityLifetime", "agentSessionPhase"]
        for (name, text) in files {
            for pattern in banned {
                #expect(!text.contains(pattern), "\(name) contains \(pattern)")
            }
        }
    }

    @Test("Owner-facing copy says Session, not Agents")
    func sessionWording() {
        for (name, text) in sources(["ReloApp"]) {
            #expect(!text.contains("\"Agents\"") && !text.contains("\"AGENTS\""), "\(name) still says Agents")
        }
    }
}
