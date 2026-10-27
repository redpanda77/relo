import Foundation

/// Relo for Mac's onboarding as one staged work in the notch: Started, Your turn while a choice waits, a step done on
/// each Continue, Failed, Done. It is never a server card and never reaches History; this only shapes the row a real
/// card in that state would produce, so the notch's painter and moments treat it like any work.
public struct OnboardingStage: Equatable, Sendable {
    public enum Phase: Equatable, Sendable { case working, yourTurn, failed, done }

    public var phase: Phase
    public var stepsDone: Int
    public var stepsTotal: Int
    public var title: String
    public var status: String?

    public init(phase: Phase, stepsDone: Int, stepsTotal: Int, title: String, status: String? = nil) {
        self.phase = phase; self.stepsDone = stepsDone; self.stepsTotal = stepsTotal; self.title = title; self.status = status
    }

    /// The staged work's fixed row id: moments and the closed notch find it by this.
    public static let rowID = "onboarding"
}

public extension NotchPresentation {
    /// What a real card in `stage`'s state produces: the focus row, its section, the counts and the plan bar's
    /// position. Nothing is spoken (the onboarding speaks itself).
    static func onboarding(_ stage: OnboardingStage, startedAt: Date) -> NotchPresentation {
        let total = max(0, stage.stepsTotal)
        let done = min(max(0, stage.stepsDone), total)
        let tone: Tone
        let kind: Section.Kind
        switch stage.phase {
        case .working: tone = .working; kind = .running
        case .yourTurn: tone = .yourTurn; kind = .waitingOnYou
        case .failed: tone = .failed; kind = .recent
        case .done: tone = .done; kind = .recent
        }
        let finished = stage.phase == .done
        let row = Row(
            id: OnboardingStage.rowID, title: stage.title, status: stage.status, project: nil, source: nil, tone: tone, chip: nil,
            stepsDone: total > 0 ? (finished ? total : done) : nil, stepsTotal: total > 0 ? total : nil, currentStep: nil,
            startedAt: startedAt, questionID: nil, notificationID: nil, questionPending: false, unreadable: false,
            computerSymbol: nil, declaredAt: startedAt, roundOutcome: nil,
            currentIndex: total > 0 && !finished ? min(done + 1, total) : nil, currentFill: total > 0 && !finished ? 0 : nil)
        let live = kind == .running || kind == .waitingOnYou
        return NotchPresentation(focus: row, needsYouCount: 0, activeCount: live ? 1 : 0,
                                 sections: [Section(kind: kind, rows: [row])], hasUnreadable: false)
    }
}
