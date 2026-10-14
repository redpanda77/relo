import Foundation

/// The one plan line (slice 3, item 2.15): "Step 4 · 4 to go · <current step label>", with the
/// current step's own count when present ("· 2 of 6", "· 6 of 6 ✓"). No plan-wide ratio: plans grow.
/// Matches `packages/contracts/fixtures/card-line-v1.json`.
public enum LiveActivityPlanDisplay {
    public enum StepState: String, Sendable { case done, current, open, skipped }

    public struct Step: Equatable, Sendable {
        public let label: String?
        public let state: StepState
        public let count: Count?

        public init(label: String?, state: StepState, count: Count? = nil) {
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

    /// Nil for an empty plan (callers show the status line instead).
    public static func line(_ steps: [Step]) -> String? {
        let live = steps.filter { $0.state != .skipped }
        guard !live.isEmpty else { return nil }
        if let index = live.firstIndex(where: { $0.state == .current }) {
            let step = live[index]
            let toGo = live[(index + 1)...].filter { $0.state == .open }.count
            var parts = ["Step \(index + 1)", "\(toGo) to go"]
            if let label = clean(step.label) { parts.append(label) }
            if let count = step.count, count.total > 0 {
                parts.append(count.done >= count.total ? "\(count.done) of \(count.total) ✓" : "\(count.done) of \(count.total)")
            }
            return parts.joined(separator: " · ")
        }
        let open = live.filter { $0.state == .open }
        if open.isEmpty { return live.count == 1 ? "The step is done" : "All \(live.count) steps done" }
        let planned = "\(live.count) step\(live.count == 1 ? "" : "s") planned"
        if let next = clean(open.first?.label) { return "\(planned) · next: \(next)" }
        return planned
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
            switch item.state {
            case .complete: Step(label: item.label, state: .done)
            case .pending: Step(label: item.label, state: .open)
            case .current: Step(label: item.label, state: .current, count: count.map { Count(done: $0.0, total: $0.1) })
            }
        }
    }

    private static func clean(_ label: String?) -> String? {
        guard let label = label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty else { return nil }
        return label
    }
}
