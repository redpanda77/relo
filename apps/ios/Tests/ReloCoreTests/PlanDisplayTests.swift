import Foundation
import Testing
@testable import ReloCore

/// Plan cases of packages/contracts/fixtures/card-line-v1.json (no-plan cases are the status line's).
@Suite struct PlanDisplayTests {
    private struct Fixture: Decodable {
        struct Case: Decodable {
            struct Work: Decodable {
                struct Plan: Decodable {
                    struct Step: Decodable {
                        struct Progress: Decodable { let done: Int; let total: Int }
                        let state: String
                        let label: String?
                        let progress: Progress?
                    }
                    let steps: [Step]
                }
                let plan: Plan?
            }
            let name: String
            let work: Work
            let expected: String
        }
        let cases: [Case]
    }

    private static func fixture() throws -> Fixture? {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        let file = url.appendingPathComponent("packages/contracts/fixtures/card-line-v1.json")
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try JSONDecoder().decode(Fixture.self, from: data)
    }

    @Test func matchesSharedCardLineFixture() throws {
        guard let fixture = try Self.fixture() else { return }
        var checked = 0
        for c in fixture.cases {
            guard let plan = c.work.plan, !plan.steps.isEmpty else { continue }
            let steps = plan.steps.map {
                LiveActivityPlanDisplay.Step(
                    label: $0.label, state: LiveActivityPlanDisplay.StepState(rawValue: $0.state)!,
                    count: $0.progress.map { .init(done: $0.done, total: $0.total) })
            }
            #expect(LiveActivityPlanDisplay.line(steps) == c.expected, "\(c.name)")
            checked += 1
        }
        #expect(checked > 0)
    }

    @Test func linesWithoutFixture() {
        typealias S = LiveActivityPlanDisplay.Step
        #expect(LiveActivityPlanDisplay.line([
            S(label: "A", state: .done), S(label: "B", state: .current, count: .init(done: 2, total: 6)),
            S(label: "C", state: .open),
        ]) == "Step 2 · 1 to go · B · 2 of 6")
        #expect(LiveActivityPlanDisplay.line([S(label: "B", state: .current, count: .init(done: 6, total: 6))])
            == "Step 1 · 0 to go · B · 6 of 6 ✓")
        #expect(LiveActivityPlanDisplay.line([S(label: "A", state: .open), S(label: "B", state: .open)])
            == "2 steps planned · next: A")
        #expect(LiveActivityPlanDisplay.line([S(label: "A", state: .done), S(label: "B", state: .skipped)])
            == "The step is done")
        #expect(LiveActivityPlanDisplay.line([]) == nil)
    }

    @Test func growthChipOnlyWhenPlanGrew() {
        #expect(LiveActivityPlanDisplay.growthChip(previousStepCount: 4, stepCount: 6) == "+2 steps")
        #expect(LiveActivityPlanDisplay.growthChip(previousStepCount: 4, stepCount: 5) == "+1 step")
        #expect(LiveActivityPlanDisplay.growthChip(previousStepCount: 6, stepCount: 6) == nil)
        #expect(LiveActivityPlanDisplay.growthChip(previousStepCount: nil, stepCount: 6) == nil)
    }
}
