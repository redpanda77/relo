import Foundation
import Testing

// SwiftPM builds the shared activity sources as ReloActivityResponse; Xcode compiles them into the app.
#if canImport(ReloActivityResponse)
@testable import ReloActivityResponse
#else
@testable import Relo
#endif
@testable import ReloCore

@Suite("Live Activity surface truth and content budgets")
struct LiveActivitySurfaceProjectionTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func interaction(
        state: String = "pending", phase: LiveActivityResponsePhase? = nil,
        deadline: Int64 = 1_800_000_600
    ) -> LiveActivityContentInteraction {
        .init(
            id: "int_reference123456", notificationID: "ntf_reference123456",
            targetDeviceID: "dev_reference123456", accountID: "acc_reference123456",
            kind: "approval", state: state, credential: String(repeating: "x", count: 43),
            expiresAtUnixSeconds: deadline, responsePhase: phase, selectedAction: .approve)
    }

    private func presentation(
        components: [LiveActivityPresentation.Component] = [],
        decision: Bool = false,
        surfaces: LiveActivityPresentation.Surfaces? = nil,
        kind: String = "active"
    ) -> LiveActivityPresentation {
        let ids = components.map(\.id)
        return .init(
            title: "Deploy release #42", subtitle: "Target: Relo server", status: "Working",
            components: components,
            surfaces: surfaces
                ?? .init(
                    lockScreen: ids, expandedBottom: ids,
                    compactTrailing: ids, minimal: Array(ids.prefix(1))),
            state: .init(kind: decision ? "needs_action" : kind, tone: "live", icon: .active),
            behavior: decision ? .approval(primary: "Approve", secondary: "Deny") : .progress)
    }

    private var steps: LiveActivityPresentation.Component {
        .steps(
            id: "steps", colorRole: .thread,
            items: [
                .init(id: "build", label: "Build", state: .complete),
                .init(id: "test", label: "Test", state: .current),
                .init(id: "ship", label: "Ship", state: .pending),
            ])
    }
    private var progress: LiveActivityPresentation.Component {
        .progressBar(id: "progress", colorRole: .project, value: 0.42, label: "Tests")
    }

    @Test(
        "A decision outranks a percentage on every small surface",
        arguments: [LiveActivityPresentation.Surface.compactTrailing, .minimal, .expandedTrailing])
    func decisionPriority(surface: LiveActivityPresentation.Surface) {
        let p = LiveActivitySurfaceProjection.make(
            presentation: presentation(components: [progress], decision: true),
            surface: surface, interaction: interaction(), now: now)
        #expect(p.fact == .symbol("questionmark.circle.fill", "Approval needed"))
        #expect(p.components.isEmpty)
    }

    @Test("Measured progress wins over stage fraction, independent of array order")
    func measuredPriority() {
        let p = LiveActivitySurfaceProjection.make(
            presentation: presentation(components: [steps, progress]),
            surface: .compactTrailing, now: now)
        #expect(p.fact == .percentage(0.42, .project))
        #expect(p.phase?.label == "Test")
        #expect(p.phase?.current == 2)
        #expect(p.phase?.completed == 1)
    }

    @Test("Surface assignment is respected without borrowing from the bottom region")
    func membership() {
        let input = presentation(components: [progress], surfaces: .init(expandedBottom: ["progress"]))
        let p = LiveActivitySurfaceProjection.make(
            presentation: input, surface: .expandedTrailing, now: now)
        #expect(p.fact == .symbol("waveform.path.ecg", "Working"))
        #expect(p.components.isEmpty)
    }

    @Test("The card renders at most one measured bar and one phase context")
    func boundedComponents() {
        let input = presentation(
            components: [steps, progress]
                + (1...6).map {
                    .progressBar(id: "extra\($0)", colorRole: .project, value: 0.1, label: "Extra")
                })
        let p = LiveActivitySurfaceProjection.make(presentation: input, surface: .lockScreen, now: now)
        #expect(p.components.map(\.id) == ["steps", "progress"])
    }

    @Test("All-pending stages do not invent a current phase")
    func allPending() {
        let component = LiveActivityPresentation.Component.steps(
            id: "steps", colorRole: .thread,
            items: (1...8).map { .init(id: "s\($0)", label: "Stage \($0)", state: .pending) })
        let p = LiveActivitySurfaceProjection.make(
            presentation: presentation(components: [component]),
            surface: .lockScreen, now: now)
        #expect(p.phase?.current == nil)
        #expect(p.phase?.label == "Not started")
        #expect(p.fact == .stages(0, 8))
    }

    @Test("Overdue progress is not completion or failure")
    func stale() {
        let p = LiveActivitySurfaceProjection.make(
            presentation: presentation(components: [progress]),
            surface: .minimal, isStale: true, now: now)
        #expect(p.fact == .symbol("exclamationmark.clock.fill", "Update overdue"))
        #expect(p.status == "Update overdue")
    }

    @Test("100 percent does not invent terminal lifecycle")
    func fullProgressIsNotSuccess() {
        let component = LiveActivityPresentation.Component.progressBar(
            id: "p", colorRole: .project, value: 1, label: nil)
        let p = LiveActivitySurfaceProjection.make(
            presentation: presentation(components: [component]),
            surface: .compactTrailing, now: now)
        #expect(p.fact == .percentage(1, .project))
        #expect(p.status == "Working")
    }

    @Test("Terminal lifecycle wins over a stale progress metric")
    func terminal() {
        let p = LiveActivitySurfaceProjection.make(
            presentation: presentation(components: [progress], kind: "completed"),
            surface: .minimal, isStale: true, now: now)
        #expect(p.fact == .symbol("checkmark.circle.fill", "Completed"))
    }

    @Test(
        "Response states have truthful labels and symbols",
        arguments: [
            ("denied", LiveActivityResponsePhase.accepted, "Denied", "xmark.circle.fill"),
            ("approved", .accepted, "Approved", "checkmark.circle.fill"),
            ("pending", .queued, "Waiting to send", "clock.arrow.circlepath"),
            ("pending", .rejected, "Response not recorded", "exclamationmark.triangle.fill"),
        ])
    func responseTruth(state: String, phase: LiveActivityResponsePhase, label: String, symbol: String) {
        let p = LiveActivitySurfaceProjection.make(
            presentation: presentation(decision: true),
            surface: .compactTrailing, interaction: interaction(state: state, phase: phase), now: now)
        #expect(p.status == label)
        #expect(p.fact == .symbol(symbol, label))
    }

    @Test("Pending decisions expire exactly at their deadline")
    func expiry() {
        let p = LiveActivitySurfaceProjection.make(
            presentation: presentation(decision: true),
            surface: .minimal, interaction: interaction(deadline: 1_800_000_000), now: now)
        #expect(p.status == "Request expired")
        #expect(p.fact == .symbol("clock.badge.xmark", "Request expired"))
    }

    @Test("An earlier request deadline is included in ActivityKit invalidation")
    func deadlineInvalidation() {
        #expect(
            LiveActivitySurfaceProjection.invalidationDate(
                staleAt: now.addingTimeInterval(900),
                interaction: interaction()) == now.addingTimeInterval(600))
        #expect(
            LiveActivitySurfaceProjection.invalidationDate(
                staleAt: now.addingTimeInterval(60),
                interaction: interaction()) == now.addingTimeInterval(60))
        #expect(
            LiveActivitySurfaceProjection.invalidationDate(
                staleAt: nil,
                interaction: interaction()) == now.addingTimeInterval(600))
        #expect(
            LiveActivitySurfaceProjection.invalidationDate(
                staleAt: nil,
                interaction: interaction(state: "denied", phase: .accepted)) == nil)
    }

    @Test(
        "Recorded negative and text outcomes retain the correct widget glyph",
        arguments: [
            ("denied", "Denied", "xmark.circle.fill"),
            ("no", "Answered No", "xmark.circle.fill"),
            ("replied", "Reply sent", "checkmark.circle.fill"),
        ])
    func responseWidgetOutcome(state: String, label: String, symbol: String) {
        let visual = LiveActivityResponseWidgetPresentation.make(
            interaction: interaction(state: state, phase: .accepted, deadline: 1),
            primary: "Approve", secondary: "Deny", now: now)
        #expect(visual.mode == .accepted)
        #expect(visual.label == label)
        #expect(visual.symbol == symbol)
        #expect(!visual.showsProgress)
    }

    @Test("Expired text replies use terminal feedback, not a reply affordance")
    func expiredTextReply() {
        let input = LiveActivityContentInteraction(
            id: "int_reference123456", notificationID: "ntf_reference123456",
            targetDeviceID: "dev_reference123456", accountID: "acc_reference123456",
            kind: "text", state: "pending", credential: String(repeating: "x", count: 43),
            expiresAtUnixSeconds: 1)
        let visual = LiveActivityResponseWidgetPresentation.make(
            interaction: input, primary: "Reply", secondary: "Reply", now: now)
        #expect(visual.mode == .terminal)
        #expect(visual.label == "Request expired")
        #expect(visual.symbol == "clock.badge.xmark")
    }

    @Test("Private payloads never expose task text, metrics, or inline actions")
    func privacy() {
        let input = LiveActivityPresentation(
            title: "Secret task", subtitle: "Secret target", status: "Secret status",
            components: [progress], surfaces: .init(minimal: ["progress"]),
            behavior: .approval(primary: "Approve", secondary: "Deny"), privacy: .private)
        let p = LiveActivitySurfaceProjection.make(
            presentation: input, surface: .minimal,
            interaction: interaction(), now: now)
        #expect(p.fact == .symbol("lock.fill", "Private activity"))
        #expect(p.components.isEmpty)
        #expect(!p.permitsInlineResponse)
    }
}
