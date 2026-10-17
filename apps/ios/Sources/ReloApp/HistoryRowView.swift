import ReloCore
import SwiftUI

/// The outcome the server derived for a History row (F.1a): never worked out from the clock.
struct HistoryServerOutcome: Equatable, Sendable {
    let label: String
    let color: Color
    let symbol: String
    /// Why the work left the screen or dimmed, from the server; shown as the first fact.
    var absence: Absence? = nil

    /// From the item's owner state and, for a question, its standing.
    /// The badge tells the truth (plan 12b, U4): Running only while moving; a work that declared it waits reads
    /// Waiting; a question reads Needs you; a delivered round reads Your turn. The server's state is the input.
    static func make(state: OwnerState?, standing: QuestionStanding?, answer: String? = nil, waiting: Bool = false) -> HistoryServerOutcome? {
        switch standing {
        case .missed?: return .init(label: "Missed", color: .reloSignalCoral, symbol: "clock.badge.xmark")
        case .answeredLate?:
            let late = answer.map { "\($0) (answered late)" } ?? "Answered late"
            return .init(label: late, color: answer.map { ["Declined", "No"].contains($0) } == true ? .reloWarning : .reloDone,
                         symbol: "checkmark.bubble.fill")
        default: break
        }
        switch state {
        case .done?: return .init(label: "Done", color: .reloDone, symbol: "checkmark")
        case .failed?: return .init(label: "Failed", color: .reloErrorText, symbol: "xmark.octagon.fill")
        case .dropped?: return .init(label: "Dropped", color: .reloWarning, symbol: "stop.fill")
        case .leftUnfinished?: return .init(label: "Left unfinished", color: .reloWarning, symbol: "exclamationmark.triangle.fill")
        case .moving?, .workingQuietly?:
            return waiting ? .init(label: "Waiting", color: .reloWarning, symbol: "hourglass")
                : .init(label: "Running", color: .reloSignalIndigo, symbol: "waveform")
        case .needsYou?: return .init(label: "Needs you", color: .reloSignalCoral, symbol: "exclamationmark.bubble.fill")
        case .waitingOnYou?: return .init(label: "Your turn", color: .reloSignalCoral, symbol: "hand.raised.fill")
        case .stale?: return .init(label: "Quiet", color: .reloInfo, symbol: "moon.zzz")
        case .stoppedResponding?: return .init(label: "Stopped responding", color: .reloInfo, symbol: "pause.circle")
        case .noSignal?: return .init(label: "No signal", color: .reloInfo, symbol: "antenna.radiowaves.left.and.right.slash")
        case .paused?: return .init(label: "Paused", color: .reloInfo, symbol: "pause.fill")
        case .unknown?, nil: return nil
        }
    }

    init(label: String, color: Color, symbol: String) {
        self.label = label; self.color = color; self.symbol = symbol
    }

    /// The outcome of a work the Now summary still lists (recent outcomes, missed questions).
    init?(item: NowItem) {
        guard let outcome = Self.make(state: item.owner.state, standing: item.question?.standing,
                                      waiting: PlanWaiting.reason(status: item.status) != nil) else { return nil }
        self = outcome
        absence = item.owner.absence
    }
}

/// A History row: the shared work card (`ReloWorkCard`) built from the row, with the question asked on it.
struct HistoryRowView: View {
    let row: HistoryRow
    var showsSource = true
    var showsProject = true
    var responseStatus: String?
    /// The server's outcome when known; it replaces the state worked out from the row.
    var serverOutcome: HistoryServerOutcome? = nil
    /// The icon of the computer the row came from, looked up by the caller; a laptop when unknown.
    var computerIcon: ComputerIcon? = nil

    var body: some View {
        ReloWorkCard(
            origin: ReloCardOrigin(source: row.source.name, sourceSymbol: row.source.systemImageName,
                                   project: showsProject ? row.project?.name : nil,
                                   projectColor: (showsProject ? row.project : nil).map(projectColor),
                                   topic: row.topic, showsSource: showsSource),
            at: row.at, title: row.title, summary: row.summary,
            steps: row.steps.map { NowItem.Steps(done: HistoryStepsMeter.done($0, outcome: row.outcome), total: $0.total,
                                                 current: $0.current, currentIndex: $0.currentIndex, fill: $0.fill) },
            progress: row.steps == nil ? row.progress : nil,
            color: color, state: state, facts: facts, computer: row.origin, computerIcon: computerIcon
        ) {
            if let decision = row.decision { decisionStrip(decision) }
        }
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens details")
    }

    /// How it turned out, in its color; a message has no outcome, so its type stands there instead.
    private var state: ReloCardState {
        if let label = responseStatus ?? serverOutcome?.label ?? row.outcome.label {
            return ReloCardState(label: label, color: color, symbol: symbol)
        }
        return ReloCardState(label: row.type, color: .reloSecondaryText, symbol: typeSymbol)
    }

    /// What it amounted to. The time closes the line; work cards need no "Live Activity" label.
    private var facts: [String] {
        var parts: [String] = []
        if let absence = serverOutcome?.absence, let why = AbsenceWording.line(absence, computer: row.origin) { parts.append(why) }
        if let steps = row.steps { parts.append(HistoryStepsMeter.caption(steps, outcome: row.outcome)) }
        else if let progress = row.progress { parts.append(progress.formatted(.percent.precision(.fractionLength(0)))) }
        if let duration = row.duration { parts.append(Self.duration(duration)) }
        let hasOutcome = responseStatus != nil || serverOutcome != nil || row.outcome.label != nil
        if hasOutcome && row.item.kind != .liveActivity { parts.append(row.type) }
        return parts
    }

    private var typeSymbol: String {
        switch row.type {
        case "Live Activity": "waveform"
        case "Approval": "checkmark.seal"
        case "Question": "questionmark.circle"
        case "Reply request": "text.bubble"
        case "Response": "arrowshape.turn.up.left"
        default: "bell"
        }
    }

    /// The question asked on the card and its answer, on one line when it fits.
    private func decisionStrip(_ decision: HistoryRow.Decision) -> some View {
        let tint: Color = decision.pending ? .reloSignalCoral : decision.declined ? .reloWarning : .reloDone
        let answer = HStack(spacing: 4) {
            Text(decision.answer).foregroundStyle(tint).fontWeight(.semibold)
            if let at = decision.at {
                Text("· \(at.formatted(date: .omitted, time: .shortened))").foregroundStyle(Color.reloSecondaryText)
                    .monospacedDigit()
            }
        }
        let prompt = Label(decision.prompt, systemImage: "questionmark.bubble").labelStyle(ReloCardInlineLabelStyle())
            .foregroundStyle(.primary)
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { prompt.fixedSize(); Spacer(minLength: 8); answer.fixedSize() }
            VStack(alignment: .leading, spacing: 3) {
                prompt.fixedSize(horizontal: false, vertical: true)
                answer.fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.caption)
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background { RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Color.primary.opacity(0.06)) }
    }

    static func duration(_ seconds: TimeInterval) -> String {
        guard seconds >= 60 else { return "under a minute" }
        return Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes], width: .abbreviated, maximumUnitCount: 2))
    }

    private var symbol: String {
        if let serverOutcome { return serverOutcome.symbol }
        return switch row.outcome {
        case .running: "waveform"
        case .done: "checkmark"
        case .stopped: "exclamationmark.triangle.fill"
        case .expired: "clock.badge.xmark"
        case .ended: "stop.fill"
        case .replaced: "arrow.triangle.2.circlepath"
        case .waitingForYou: "hand.raised.fill"
        case .answered: "checkmark.bubble.fill"
        case .unanswered: "clock"
        case .message: "bell.fill"
        }
    }

    private var color: Color {
        if let serverOutcome { return serverOutcome.color }
        return switch row.outcome {
        case .running: .reloSignalIndigo
        case .done: .reloDone
        case .stopped: .reloWarning
        case .waitingForYou: .reloSignalCoral
        case let .answered(answer): ["Declined", "No"].contains(answer) ? .reloWarning : .reloDone
        case .expired, .ended, .replaced, .unanswered, .message: .reloInfo
        }
    }

    private func projectColor(_ project: InboxProjectIdentity) -> Color {
        guard let slot = project.paletteSlot else { return .primary }
        switch slot % 3 {
        case 0: return .reloInteractive
        case 1: return .reloSignalIndigo
        default: return .reloSignalCoral
        }
    }
}

/// One segment per step across the full width, so "4 of 6" reads at a glance; long plans become a bar.
struct HistoryStepsMeter: View {
    let steps: HistoryRow.Steps
    let color: Color
    let outcome: HistoryRow.Outcome
    /// Finished work is finished: cards ended before steps were completed on success still read as done.
    private var done: Int { Self.done(steps, outcome: outcome) }

    var body: some View {
        Group {
            if steps.total <= 12 {
                HStack(spacing: 3) {
                    ForEach(0..<steps.total, id: \.self) { index in
                        Capsule().fill(index < done ? color : Color.primary.opacity(index == done ? 0.28 : 0.1))
                            .frame(height: 4).frame(maxWidth: .infinity)
                    }
                }
            } else {
                HistoryProgressMeter(value: Double(done) / Double(steps.total), color: color, showsValue: false)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.caption(steps, outcome: outcome))
    }

    static func done(_ steps: HistoryRow.Steps, outcome: HistoryRow.Outcome) -> Int {
        outcome == .done ? steps.total : steps.done
    }

    /// The one plan line (U2): "2 of 5 · Patch token refresh", "5 of 5 done", "Stopped at 3 of 5".
    static func caption(_ steps: HistoryRow.Steps, outcome: HistoryRow.Outcome) -> String {
        let done = done(steps, outcome: outcome)
        let progress = PlanProgress(done: done, total: steps.total, current: outcome == .done ? nil : steps.currentIndex)
        let standing: PlanProgress.Standing = switch outcome {
        case .done: .done
        case .stopped, .expired, .ended, .replaced: .stopped
        default: done >= steps.total ? .done : .moving
        }
        return progress.line(label: steps.current, standing: standing) ?? "\(done) of \(steps.total)"
    }
}

struct HistoryProgressMeter: View {
    let value: Double
    let color: Color
    var showsValue = true
    private var fraction: Double { value.isFinite ? min(max(value, 0), 1) : 0 }

    var body: some View {
        HStack(spacing: 8) {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.1))
                    Capsule().fill(color).frame(width: max(4, proxy.size.width * fraction))
                }
            }
            .frame(height: 4)
            if showsValue {
                Text(fraction, format: .percent.precision(.fractionLength(0)))
                    .font(.caption.weight(.medium).monospacedDigit()).foregroundStyle(Color.reloSecondaryText)
            }
        }
        .accessibilityElement(children: .ignore).accessibilityLabel("Progress")
        .accessibilityValue(fraction.formatted(.percent.precision(.fractionLength(0))))
    }
}
