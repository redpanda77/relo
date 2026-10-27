import Foundation
import ReloNotchKit

/// Relo for Mac's onboarding, shown in the notch as one staged work (never a server card, never History). Each call
/// restages the work; the notch's own painter and moments turn the changes into the start, step, your-turn, failed
/// and done moments.
@MainActor
enum ReloOnboardingNotch {
    static let title = "Setting up Relo"

    private static var stage: OnboardingStage?
    private static var startedAt = Date()

    /// The owner pressed Begin: the work starts with `total` steps, none done.
    static func start(total: Int) {
        startedAt = Date()
        stage = OnboardingStage(phase: .working, stepsDone: 0, stepsTotal: total, title: title)
        publish()
    }

    /// Opened again part way: the work comes back waiting on the owner, `done` of `total` steps behind it.
    static func resume(done: Int, total: Int) {
        startedAt = Date()
        stage = OnboardingStage(phase: .yourTurn, stepsDone: min(done, total), stepsTotal: total, title: title)
        publish()
    }

    /// Back: the plan shows `done` steps again, still waiting on the owner.
    static func set(stepsDone done: Int) { update { $0.stepsDone = min(max(0, done), $0.stepsTotal); $0.phase = .yourTurn; $0.status = nil } }

    /// A choice screen waits for the owner.
    static func yourTurn() { update { $0.phase = .yourTurn; $0.status = nil } }

    /// The owner continued: one more step is done and the work moves again.
    static func stepDone() { update { $0.stepsDone = min($0.stepsDone + 1, $0.stepsTotal); $0.phase = .working; $0.status = nil } }

    /// The work moves again with no step finished (a retry after a failure, or setup running).
    static func working() { update { $0.phase = .working; $0.status = nil } }

    static func failed(_ status: String) { update { $0.phase = .failed; $0.status = status } }

    /// Finished: the notch's done moment, titled with what is ready ("Ready to use with Claude Code").
    static func done(title: String? = nil) {
        update { $0.stepsDone = $0.stepsTotal; $0.phase = .done; $0.status = nil; if let title { $0.title = title } }
    }

    /// Takes the staged work off the notch: the server's own presentation returns.
    static func clear() {
        stage = nil
        ReloNotch.store.stageOnboarding(nil)
    }

    private static func update(_ change: (inout OnboardingStage) -> Void) {
        guard var current = stage else { return }
        change(&current)
        stage = current
        publish()
    }

    private static func publish() {
        guard let stage else { return }
        ReloNotch.store.stageOnboarding(.onboarding(stage, startedAt: startedAt))
    }
}
