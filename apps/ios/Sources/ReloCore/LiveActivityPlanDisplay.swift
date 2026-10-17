/// The one plan line (plan 12b, U2): "2 of 5 · <current step> · 1/3", "Round 2 delivered", "Paused at 2 of 5",
/// "5 of 5 done", "Stopped at 3 of 5". The count is `PlanProgress`: the server's when the card carries it,
/// else counted from the shown steps. No "Step N", no round number on the Lock Screen while moving.
/// Matches `packages/contracts/test/fixtures/plan-progress.json`.
public enum LiveActivityPlanDisplay {
    public enum StepState: String, Sendable { case done, current, open, skipped }

    public struct Step: Equatable, Sendable {
        public let id: String?
        public let label: String?
        public let state: StepState
        public let count: Count?

        public init(label: String?, state: StepState, count: Count? = nil, id: String? = nil) {
            self.id = id
            self.label = label
            self.state = state
            self.count = count
        }
    }

    public struct Count: Equatable, Sendable {
        public let done: Int
        public let total: Int
        public init(done: Int, total: Int) { self.done = done; self.total = total }
    }

    /// The count for these steps: the card's own `progress` when it has one, else counted from the shown ones.
    public static func progress(_ steps: [Step], window: LiveActivityDisplayPresentation.StepWindow = .whole) -> PlanProgress? {
        window.progress ?? PlanProgress.make(steps: steps, before: window.before, after: window.after)
    }

    /// The label of the current step: the one the progress names by id if the card lists it, else the one marked current.
    public static func currentLabel(_ steps: [Step], progress: PlanProgress?) -> String? {
        if let id = progress?.currentId, let label = steps.first(where: { $0.id == id })?.label { return label }
        return steps.first { $0.state == .current }?.label
    }

    /// Nil for an empty plan (callers show the status line instead). `standing` is how the work stands;
    /// a plan that is not moving reads as its state ("Paused at 2 of 5").
    public static func line(_ steps: [Step], window: LiveActivityDisplayPresentation.StepWindow = .whole,
                            standing: PlanProgress.Standing = .moving) -> String? {
        guard let progress = progress(steps, window: window) else { return nil }
        return progress.line(label: currentLabel(steps, progress: progress), standing: standing)
    }

    /// The line in pieces, for a surface that must keep the counts whole and let the label give way.
    public static func lineParts(_ steps: [Step], window: LiveActivityDisplayPresentation.StepWindow = .whole,
                                 standing: PlanProgress.Standing = .moving) -> PlanProgress.LineParts? {
        guard let progress = progress(steps, window: window) else { return nil }
        return progress.lineParts(label: currentLabel(steps, progress: progress), standing: standing)
    }

    /// Steps done and the plan's total, counting a long plan's hidden steps.
    public static func tally(_ steps: [Step], window: LiveActivityDisplayPresentation.StepWindow = .whole) -> (done: Int, total: Int) {
        guard let progress = progress(steps, window: window) else { return (0, 0) }
        return (progress.done, progress.total)
    }

    /// "+N steps" once, on the update that grew the plan; nil when it did not grow or the
    /// previous step count is unknown.
    public static func growthChip(previousStepCount: Int?, stepCount: Int) -> String? {
        guard let previousStepCount, stepCount > previousStepCount else { return nil }
        let added = stepCount - previousStepCount
        return "+\(added) step\(added == 1 ? "" : "s")"
    }

    /// Adapter for the presented card steps; `count` is the current step's count, if any.
    public static func steps(
        _ items: [LiveActivityDisplayPresentation.Step], count: (Int, Int)? = nil
    ) -> [Step] {
        items.map { item in
            // "Step n" is the server's stand-in for a label this phone could not open: never shown as text.
            let label = ReloSealedCards.isPlaceholderStep(item.label) ? PlanProgress.unreadable : item.label
            switch item.state {
            case .complete: return Step(label: label, state: .done, id: item.id)
            case .pending: return Step(label: label, state: .open, id: item.id)
            case .skipped: return Step(label: label, state: .skipped, id: item.id)
            case .current: return Step(label: label, state: .current, count: count.map { Count(done: $0.0, total: $0.1) }, id: item.id)
            }
        }
    }
}
