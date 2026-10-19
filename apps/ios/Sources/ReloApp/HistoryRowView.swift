import ReloCore
import SwiftUI

/// A History row: the shared work card (`ReloWorkCard`) built from the row, with the question asked on it.
struct HistoryRowView: View {
    let row: HistoryRow
    var showsSource = true
    var showsProject = true
    var responseStatus: String?
    /// The server's outcome when known; it replaces the state worked out from the row.
    var serverOutcome: ReloStateStyle? = nil
    /// The icon of the computer the row came from, looked up by the caller; a laptop when unknown.
    var computerIcon: ComputerIcon? = nil

    var body: some View {
        ReloWorkCard(
            origin: ReloCardOrigin(source: row.source.name, sourceSymbol: row.source.systemImageName,
                                   project: showsProject ? row.project?.name : nil,
                                   projectColor: showsProject ? row.project.map { ReloProjectPalette.color(for: $0) } : nil,
                                   topic: row.topic, showsSource: showsSource),
            at: row.at, title: row.title, summary: row.summary,
            steps: row.steps.map { NowItem.Steps(done: HistorySteps.done($0, outcome: row.outcome), total: $0.total,
                                                 current: $0.current, currentIndex: $0.currentIndex, fill: $0.fill) },
            progress: row.steps == nil ? row.progress : nil,
            progressCaption: row.steps.map { HistorySteps.caption($0, outcome: row.outcome) }
                ?? row.progress.map { $0.formatted(.percent.precision(.fractionLength(0))) },
            color: color, state: state, facts: facts, computer: row.origin, computerIcon: computerIcon,
            surface: .listCell
        ) {
            if let decision = row.decision {
                CardDecisionLine(prompt: decision.prompt, answer: decision.answer,
                                 tint: decision.pending ? .reloSignalCoral : decision.declined ? .reloWarning : .reloDone,
                                 at: decision.at)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens details")
    }

    /// The state this row draws with: the server's, else the row's outcome; a message has none, so its type stands.
    private var base: ReloStateStyle? { serverOutcome ?? ReloStateStyle.make(outcome: row.outcome) }

    /// How it turned out, in its color; a message has no outcome, so its type stands there instead.
    private var state: ReloStateStyle {
        if let responseStatus { return (base ?? .message).labelled(responseStatus) }
        return base ?? ReloStateStyle(label: row.type, color: .reloSecondaryText, symbol: typeSymbol)
    }

    private var color: Color { base?.color ?? ReloStateStyle.message.color }

    /// What it amounted to. The time closes the line; work cards need no "Live Activity" label.
    private var facts: [String] {
        var parts: [String] = []
        if let absence = serverOutcome?.absence, let why = AbsenceWording.line(absence, computer: row.origin) { parts.append(why) }
        if let duration = row.duration { parts.append(ReloDuration.format(duration)) }
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
}

/// The plan counts a History row reads: finished work is finished, and the one plan line.
enum HistorySteps {
    /// Finished work is finished: cards ended before steps were completed on success still read as done.
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
