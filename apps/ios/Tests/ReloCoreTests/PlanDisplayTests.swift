import Foundation
import Testing
@testable import ReloCore

/// The plan line on a card event (plan 12b, U2); the shared cases are in PlanProgressTests.
@Suite struct PlanDisplayTests {
    @Test func linesFromTheShownSteps() {
        typealias S = LiveActivityPlanDisplay.Step
        #expect(LiveActivityPlanDisplay.line([
            S(label: "A", state: .done), S(label: "B", state: .current, count: .init(done: 2, total: 6)),
            S(label: "C", state: .open),
        ]) == "Step 2 of 3 · B · 2/6")
        #expect(LiveActivityPlanDisplay.line([S(label: "A", state: .done), S(label: "B", state: .skipped)]) == "1 of 1 done")
        #expect(LiveActivityPlanDisplay.line([S(label: "A", state: .done), S(label: "B", state: .open)], standing: .paused)
            == "Paused at 1 of 2")
        #expect(LiveActivityPlanDisplay.line([S(label: "A", state: .done), S(label: "B", state: .open)], standing: .stopped)
            == "Stopped at 1 of 2")
        #expect(LiveActivityPlanDisplay.line([]) == nil)
    }

    @Test func theCardsOwnProgressWinsAndCountsNeverTruncate() {
        typealias S = LiveActivityPlanDisplay.Step
        let steps = [S(label: "Patch token refresh", state: .current, id: "s2"), S(label: "Inner", state: .open, id: "s3")]
        let progress = PlanProgress(done: 1, total: 4, currentId: "s2", sub: .init(done: 1, total: 3))
        let window = LiveActivityDisplayPresentation.StepWindow(progress: progress)
        #expect(LiveActivityPlanDisplay.line(steps, window: window) == "1 of 4 · Patch token refresh · 1/3")
        let parts = LiveActivityPlanDisplay.lineParts(steps, window: window)
        #expect(parts?.lead == "1 of 4" && parts?.trail == "1/3" && parts?.label == "Patch token refresh")
        #expect(progress.compact == "1/4")
        // The server's `progress` rides on the steps component and survives a round trip.
        let component = LiveActivityPresentation.Component.steps(
            id: "plan", colorRole: .state, items: [.init(id: "s2", label: "A", state: .current)], window: window)
        let data = try? JSONEncoder().encode(component)
        let back = data.flatMap { try? JSONDecoder().decode(LiveActivityPresentation.Component.self, from: $0) }
        #expect(back == component)
    }

    @Test func aPlaceholderLabelReadsNotReadable() {
        let items = [LiveActivityDisplayPresentation.Step(id: "s1", label: "Step 3", state: .current)]
        #expect(LiveActivityPlanDisplay.line(LiveActivityPlanDisplay.steps(items)) == "Step 1 of 1 · Not readable")
    }

    @Test func growthChipOnlyWhenPlanGrew() {
        #expect(LiveActivityPlanDisplay.growthChip(previousStepCount: 4, stepCount: 6) == "+2 steps")
        #expect(LiveActivityPlanDisplay.growthChip(previousStepCount: 4, stepCount: 5) == "+1 step")
        #expect(LiveActivityPlanDisplay.growthChip(previousStepCount: 6, stepCount: 6) == nil)
        #expect(LiveActivityPlanDisplay.growthChip(previousStepCount: nil, stepCount: 6) == nil)
    }

    /// A 10-step plan arrives as an 8-step window; every number is still the whole plan's.
    @Test func longPlanWindowCountsTheWholePlan() {
        typealias Step = LiveActivityPlanDisplay.Step
        let window = (0..<8).map { Step(label: "Phase \($0 + 1)", state: $0 == 0 ? .current : .open) }
        let after = LiveActivityDisplayPresentation.StepWindow(before: 0, after: 2)
        #expect(LiveActivityPlanDisplay.line(window, window: after) == "Step 1 of 10 · Phase 1")
        #expect(LiveActivityPlanDisplay.tally(window, window: after).total == 10)
        let middle = (0..<8).map { Step(label: "Phase \($0 + 3)", state: $0 < 2 ? .done : $0 == 2 ? .current : .open) }
        let both = LiveActivityDisplayPresentation.StepWindow(before: 2, after: 0)
        #expect(LiveActivityPlanDisplay.line(middle, window: both) == "Step 5 of 10 · Phase 5")
        #expect(LiveActivityPlanDisplay.tally(middle, window: both) == (done: 4, total: 10))
        let phase = LiveActivitySurfaceProjection.Phase(
            items: middle.enumerated().map { index, step in
                LiveActivityDisplayPresentation.Step(id: "step_\(index + 1)", label: step.label ?? "",
                                                     state: step.state == .done ? .complete : step.state == .current ? .current : .pending)
            }, window: both)
        #expect(phase.current == 5 && phase.total == 10 && phase.completed == 4)
    }
}
