import Foundation
@testable import ReloCore
import Testing

/// ADR 0007 on the phone: sealed plan text v2 and step labels by id, never "Step n" when a label is known.
@Suite("Sealed step labels by id", .serialized)
struct WorkModelTests {
    // MARK: Fixtures

    private func steps(_ items: [(String, String, LiveActivityDisplayPresentation.Step.State)]) -> LiveActivityPresentation {
        LiveActivityPresentation(title: "Encrypted card", subtitle: nil, status: "Updating…", components: [
            .steps(id: "named_steps", colorRole: .thread, items: items.map { .init(id: $0.0, label: $0.1, state: $0.2) }),
        ])
    }

    private func labels(_ presentation: LiveActivityPresentation) -> [String] {
        for case let .steps(_, _, items) in presentation.components { return items.map(\.label) }
        return []
    }

    private let plan = ReloSealedCardText(title: "Ship 0.13", status: "Building", phases: [
        .init(id: "ph_plan", title: "Plan", steps: [.init(id: "st_scope", label: "Scope"), .init(id: "st_design", label: "Design")]),
        .init(id: "ph_build", title: "Build", steps: [.init(id: "st_code", label: "Code"), .init(id: "st_test", label: "Test"),
                                                      .init(id: "st_fix", label: "Fix")]),
        .init(id: "ph_ship", title: "Ship", steps: [.init(id: "st_release", label: "Release")]),
    ])

    private func decode<T: Decodable>(_ type: T.Type, _ json: Any) throws -> T {
        try ReloWireJSON.decoder().decode(type, from: JSONSerialization.data(withJSONObject: json))
    }

    // MARK: Sealed text decoding

    @Test func decodesV2PlanAlongsideV1Steps() throws {
        let v2 = try JSONDecoder().decode(ReloSealedCardText.self, from: Data("""
        {"title":"Ship","status":"Building","detail":"main","phases":[{"id":"p1","title":"Plan","steps":[{"id":"s1","label":"Scope"}]},
         {"id":"p2","title":"Build","steps":[{"id":"s2","label":"Code"},{"id":"s3"},{"label":"no id"}]},{"title":"no id"}]}
        """.utf8))
        #expect(v2.phases?.map(\.id) == ["p1", "p2"], "a phase without an id is skipped, not fatal")
        #expect(v2.phases?[1].steps?.map(\.id) == ["s2", "s3"])
        #expect(v2.labelsByStepID == ["s1": "Scope", "s2": "Code"])
        #expect(v2.detail == "main")

        let v1 = try JSONDecoder().decode(ReloSealedCardText.self, from: Data(#"{"title":"Ship","steps":["Build","Ship"]}"#.utf8))
        #expect(v1.steps == ["Build", "Ship"])
        #expect(v1.phases == nil)

        let odd = try JSONDecoder().decode(ReloSealedCardText.self, from: Data(#"{"title":"Ship","steps":[{"id":"x"}],"phases":"no"}"#.utf8))
        #expect(odd.title == "Ship", "an odd field drops alone; the rest still opens")
        #expect(odd.steps == nil && odd.phases == nil)
    }

    // MARK: Labels by id

    @Test func appliesLabelsByStepIDNeverByCount() {
        let card = steps([("st_code", "Step 1", .complete), ("st_test", "Step 2", .current), ("st_new", "Step 3", .pending)])
        // The plan has no label for st_new: the other two still open; nothing is all-or-nothing.
        #expect(labels(card.applying(plan)) == ["Code", "Test", "Step 3"])
        // Order on the card does not matter, only ids.
        let reordered = steps([("st_test", "Step 1", .current), ("st_code", "Step 2", .complete)])
        #expect(labels(reordered.applying(plan)) == ["Test", "Code"])
        // A label the server wrote itself is never replaced.
        #expect(labels(steps([("st_code", "Compile", .current)]).applying(plan)) == ["Compile"])
    }

    @Test func v1LabelsApplyPerPlaceholderNumber() {
        let card = steps([("step_1", "Step 1", .complete), ("step_2", "Step 2", .current), ("step_3", "Step 3", .pending)])
        // A short v1 list (a stale computer cache) labels what it can instead of nothing.
        #expect(labels(card.applying(ReloSealedCardText(steps: ["Build", "Ship"]))) == ["Build", "Ship", "Step 3"])
        #expect(labels(card.applying(ReloSealedCardText(steps: ["Build", "Step 2", "Ship"]))) == ["Build", "Step 2", "Ship"],
                "a placeholder in the text is not a label")
    }

    @Test func keepsTheLastKnownLabelInsteadOfAPlaceholder() {
        ReloStepLabelMemory.reset()
        defer { ReloStepLabelMemory.reset() }
        let card = steps([("st_code", "Step 1", .complete), ("st_test", "Step 2", .current)])
        _ = card.applying(plan, memoryScope: "wrk_memory")
        // A later update whose text lacks the labels (a racing writer) keeps what was known.
        let later = ReloSealedCardText(title: "Ship 0.13", status: "Testing")
        #expect(labels(card.applying(later, memoryScope: "wrk_memory")) == ["Code", "Test"])
        #expect(labels(card.applying(later, memoryScope: "wrk_other")) == ["Step 1", "Step 2"], "scoped to its work")
        #expect(labels(card.applying(later)) == ["Step 1", "Step 2"])
    }

    // MARK: API decoding

    private func item(_ id: String, kind: String = "live_activity", at time: String, card: String? = nil,
                      work: Any? = nil, extra: [String: Any] = [:]) -> [String: Any] {
        var json: [String: Any] = ["id": id, "kind": kind, "sourceName": "Claude Code", "title": "Ship 0.13",
                                   "privacy": "standard", "createdAt": time]
        if let card { json["activityEvent"] = ["id": card, "operation": "update", "generation": 1, "sequence": 1] }
        if let work { json["work"] = work }
        return json.merging(extra) { _, new in new }
    }

    @Test func itemsDecodeWithAndWithoutWork() throws {
        let plain = try decode(InboxItem.self, item("ntf_a", at: "2026-10-14T10:00:00Z"))
        #expect(plain.work == nil && plain.workID == nil)
        let referenced = try decode(InboxItem.self, item("ntf_b", at: "2026-10-14T10:00:00Z", extra: ["workId": "wrk_1"]))
        #expect(referenced.workID == "wrk_1")
        let bare = try decode(InboxItem.self, item("ntf_c", at: "2026-10-14T10:00:00Z", work: "wrk_2"))
        #expect(bare.workID == "wrk_2")
        let full = try decode(InboxItem.self, item("ntf_d", at: "2026-10-14T10:00:00Z", work: [
            "id": "wrk_3", "state": "active", "phase": ["id": "ph_build", "index": 2, "count": 3, "title": "Phase 2"],
            "phases": [["id": "ph_plan", "state": "done", "startedAt": "2026-10-14T09:00:00Z", "endedAt": "2026-10-14T09:30:00Z",
                        "steps": [["id": "st_scope", "state": "completed"]]],
                       ["id": "ph_build", "state": "active", "steps": [["id": "st_code", "state": "weird"]]], 42],
            "revisions": [["revision": 2, "reason": "Added a test step", "createdAt": "2026-10-14T09:40:00Z"]],
        ]))
        #expect(full.work?.state == .active)
        #expect(full.work?.phase?.index == 1 && full.work?.phase?.count == 3, "the wire's index is one-based")
        #expect(full.work?.phase?.title == nil, "\"Phase 2\" is a placeholder, not a name")
        #expect(full.work?.phases.map(\.id) == ["ph_plan", "ph_build"], "an element it cannot read is skipped")
        #expect(full.work?.phases.first?.state == .done && full.work?.phases.first?.endedAt != nil)
        #expect(full.work?.phases.last?.steps.first?.state == nil, "an unknown state is unknown, not an error")
        #expect(full.work?.revisions.first?.reason == "Added a test step")
        let broken = try decode(InboxItem.self, item("ntf_e", at: "2026-10-14T10:00:00Z", work: ["phases": 7]))
        #expect(broken.work == nil, "an unreadable work leaves the item readable")
        // The offline cache keeps the work.
        let cached = try JSONDecoder().decode(InboxItem.self, from: JSONEncoder().encode(full.historySummary()))
        #expect(cached.work == full.work)
    }

    /// The shapes in packages/contracts/src/works.ts: the work resource and a card's work frame.
    @Test func readsTheServersWorkResourceAndCardFrame() throws {
        let resource = try decode(ReloWork.self, [
            "id": "wrk_00000000-0000-4000-8000-000000000001", "version": 4, "state": "waiting", "sealedText": true,
            "title": "Encrypted card", "phase": ["id": "build", "index": 2, "count": 3, "title": "Phase 2"],
            "step": ["id": "test", "index": 2, "count": 2, "label": "Step 2"],
            "plan": ["revision": 3, "phases": [
                ["id": "plan", "title": "Phase 1", "state": "done", "steps": [["id": "scope", "label": "Step 1", "state": "done"]]],
                ["id": "build", "title": "Phase 2", "state": "active", "steps": [
                    ["id": "code", "label": "Step 1", "state": "done"], ["id": "test", "label": "Step 2", "state": "active"]]],
                ["id": "ship", "title": "Ship", "state": "pending", "steps": [] as [Any]],
            ]],
        ])
        #expect(resource.state == .waiting && resource.title == nil)
        #expect(resource.planRevision == 3)
        #expect(resource.phases.map(\.title) == [nil, nil, "Ship"], "placeholders are not names")
        #expect(resource.steps.map(\.label) == [nil, nil, nil])
        #expect(resource.phases[1].state == .current && resource.phase?.stepId == "test")

        let frame = try decode(ReloWork.self, ["id": "wrk_1", "version": 2, "phase": ["id": "build", "index": 2, "count": 3],
                                               "steps": ["code", "test"], "step": "test"])
        #expect(frame.currentStepIDs == ["code", "test"] && frame.phase?.stepId == "test")
        // The frame survives the app's own cache.
        #expect(try JSONDecoder().decode(ReloWork.self, from: JSONEncoder().encode(frame)) == frame)
    }

    @Test func openedCardTakesItsPlanTextOnlyFromTheEnvelope() throws {
        let sealed = InboxSealedNotice(alert: nil, content: ReloEnvelope(v: "1", kind: "card", context: "c", sender: "k",
                                                                          recipients: [], nonce: "", ct: "", sig: ""))
        let server = ReloWork(id: "wrk_1", phases: [
            .init(id: "ph_plan", title: "Encrypted", state: .done, steps: [.init(id: "st_scope", state: .done, label: "Step 1")]),
            .init(id: "ph_build", state: .current, steps: [.init(id: "st_code", state: .current)]),
        ])
        let item = InboxItem(id: "ntf_card", kind: .liveActivity, sourceName: "Claude Code", title: "Encrypted card",
                             createdAt: .now,
                             activity: InboxCardDigest(state: "active", steps: .init(done: 1, total: 2, current: "Step 2", currentId: "st_code"),
                                                       updates: 2, startedAt: .now),
                             sealed: sealed, work: server)
        let data = try JSONEncoder().encode(plan)
        let opened = item.openingSealed { _, _ in data }
        #expect(opened.title == "Ship 0.13")
        #expect(opened.work?.phases.map(\.title) == ["Plan", "Build"])
        #expect(opened.work?.steps.map(\.label) == ["Scope", "Code"])
        #expect(opened.work?.phases.first?.state == .done, "states stay the server's")
        #expect(opened.activity?.steps?.current == "Code", "the current step's label is found by id")
        let locked = item.openingSealed { _, _ in nil }
        #expect(locked.work?.phases.first?.title == nil && locked.work?.steps.first?.label == nil,
                "server-written text never shows for a sealed card")
        #expect(locked.workID == "wrk_1")
    }


    // MARK: Detail timeline (regression: sealed cards showed "Step 1…Step 5" though the envelope had labels)

    private func sealedFiveStepCard(digest: InboxCardDigest?, presented: Bool) -> InboxItem {
        let envelope = ReloEnvelope(v: "1", kind: "card", context: "c", sender: "k", recipients: [], nonce: "", ct: "", sig: "")
        let command = LiveActivityCommand(
            operation: .update, activityId: "act_five", generation: 1, targetDeviceId: "dev_1", style: "steps",
            sourceName: "Claude Code", headline: "Encrypted card", status: "Updating…",
            presentation: presented ? steps((1...5).map { ("step_\($0)", "Step \($0)", $0 < 3 ? .complete : $0 == 3 ? .current : .pending) })
                : nil)
        return InboxItem(id: "ntf_five", kind: .liveActivity, sourceName: "Claude Code", title: "Encrypted card", createdAt: .now,
                         liveActivity: command, activity: digest, sealed: InboxSealedNotice(alert: nil, content: envelope))
    }

    @Test func sealedFiveStepCardShowsItsOpenedLabelsInTheDetailTimeline() throws {
        let five = ["Read the code", "Plan the fix", "Write the fix", "Run the tests", "Commit"]
        let data = try JSONEncoder().encode(ReloSealedCardText(title: "Fix the timeline", status: "Writing", steps: five))
        let digest = InboxCardDigest(state: "active", steps: .init(done: 2, total: 5, current: "Step 3"), updates: 4, startedAt: .now)

        // The card's own steps ("Step n" from the server) take the opened labels.
        let withSteps = sealedFiveStepCard(digest: digest, presented: true).openingSealed { _, _ in data }
        guard case let .steps(presented) = try #require(withSteps.liveActivity).compositionalPresentation.visual
        else { Issue.record("steps"); return }
        let timeline = withSteps.timelineSteps(presented: presented)
        #expect(timeline.map(\.label) == five)
        #expect(timeline.map(\.state) == [.complete, .complete, .current, .pending, .pending])

        // Rebuilt from the digest's counts (History drops the command): still the real labels.
        let rebuilt = sealedFiveStepCard(digest: digest, presented: false).historySummary().openingSealed { _, _ in data }
        #expect(rebuilt.timelineSteps(presented: []).map(\.label) == five)
        #expect(rebuilt.activity?.steps?.current == "Write the fix")

        // The same through the offline cache.
        let cached = try JSONDecoder().decode(InboxItem.self, from: JSONEncoder().encode(rebuilt))
        #expect(cached.timelineSteps(presented: []).map(\.label) == five)

        // v2 text: labels by id from the phases.
        let v2 = try JSONEncoder().encode(ReloSealedCardText(title: "Fix", phases: [
            .init(id: "ph_a", title: "Look", steps: [.init(id: "step_1", label: "Read the code"), .init(id: "step_2", label: "Plan the fix")]),
            .init(id: "ph_b", title: "Do", steps: [.init(id: "step_3", label: "Write the fix"), .init(id: "step_4", label: "Run the tests"),
                                                   .init(id: "step_5", label: "Commit")]),
        ]))
        let opened = sealedFiveStepCard(digest: digest, presented: true).openingSealed { _, _ in v2 }
        #expect(opened.timelineSteps(presented: presented).map(\.label) == five)

        // Nothing opened: placeholders, and nothing the server wrote.
        let locked = sealedFiveStepCard(digest: digest, presented: true).openingSealed { _, _ in nil }
        #expect(locked.timelineSteps(presented: presented).map(\.label) == (1...5).map { "Step \($0)" })
    }
}
