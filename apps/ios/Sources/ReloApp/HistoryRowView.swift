import ReloCore
import SwiftUI

/// A History row on the day's timeline: the time, a dot on the rail that says how it went (a symbol as well as a
/// color), then what it was, what came of it and where it ran. No plan bar: History is what is over.
struct HistoryRowView: View {
    let row: HistoryRow
    /// AM or PM under the time: on the day's first row and where the half of the day changes.
    var showsDayHalf = false
    /// The rail runs on below the dot, to the next row of the day.
    var continues = true
    var showsProject = true
    var responseStatus: String?
    /// The server's outcome when known; it replaces the state worked out from the row.
    var serverOutcome: ReloStateStyle? = nil
    /// The icon of the computer the row came from, looked up by the caller; a laptop when unknown.
    var computerIcon: ComputerIcon? = nil
    @ScaledMetric(relativeTo: .footnote) private var timeWidth: CGFloat = 46
    @ScaledMetric(relativeTo: .body) private var dot: CGFloat = 20
    private var railWidth: CGFloat { dot + 16 }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            time.frame(width: timeWidth, alignment: .trailing)
            marker.frame(width: railWidth)
            content.padding(.bottom, 22)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(alignment: .topLeading) {
            if continues {
                Capsule().fill(Color.primary.opacity(0.10)).frame(width: 2)
                    .padding(.top, dot + 6).padding(.bottom, 4)
                    .padding(.leading, timeWidth + railWidth / 2 - 1)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(unreadMessage ? "Unread" : "")
        .accessibilityHint("Opens details")
    }

    // MARK: Time and rail

    private var time: some View {
        VStack(alignment: .trailing, spacing: 1) {
            Text(row.at, format: Date.FormatStyle().hour(.defaultDigits(amPM: .omitted)).minute())
                .font(.system(.footnote, design: .monospaced).weight(.semibold)).monospacedDigit()
            if showsDayHalf, let half = HistoryClock.dayHalf(row.at) {
                Text(half).font(.system(.caption2, design: .monospaced)).foregroundStyle(Color.reloSecondaryText)
            }
        }
        .padding(.top, 1)
    }

    private var marker: some View {
        Circle().fill(color)
            .frame(width: dot, height: dot)
            .overlay {
                Image(systemName: glyph).font(.system(size: dot * 0.5, weight: .heavy))
                    .foregroundStyle(Color.black.opacity(0.78))
            }
            .accessibilityHidden(true)
    }

    // MARK: Content

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Unread shows only as the bolder headline: a coral dot on most rows read as "needs you".
            HStack(spacing: 6) {
                (Text(state.label.uppercased()).font(.system(.caption, design: .monospaced).weight(.bold)).tracking(0.8)
                    .foregroundColor(color)
                 + Text(context.map { " · \($0)" } ?? "").font(.caption).foregroundColor(.reloSecondaryText))
                    .lineLimit(1)
                if row.item.validatedDestinationURL != nil { ReloLinkMark() }
            }
            Text(row.headline).font(.body.weight(unreadMessage ? .bold : .semibold)).lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4)
            if let summary = row.summary {
                Text(summary).font(.subheadline).foregroundStyle(Color.reloSecondaryText).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 3)
            }
            // A pill that would only repeat the state above it (Withdrawn under WITHDRAWN) is left out.
            if let answer, answer.text.caseInsensitiveCompare(state.label) != .orderedSame {
                Text(answer.text).font(.subheadline.weight(.semibold)).lineLimit(1)
                    .foregroundStyle(answer.color)
                    .padding(.horizontal, 11).padding(.vertical, 5)
                    .background { Capsule().fill(answer.color.opacity(0.14)) }
                    .padding(.top, 8)
            }
            if !facts.isEmpty {
                HStack(spacing: 5) {
                    if row.origin != nil {
                        Image(systemName: computerIcon?.systemImageName ?? "laptopcomputer").font(.caption2)
                    }
                    Text(facts.joined(separator: " · ")).lineLimit(1)
                }
                .font(.caption).foregroundStyle(Color.reloSecondaryText)
                .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 4)
    }

    /// Where it came from: the project (or source), then the round it reports, the question's kind or the topic.
    private var context: String? {
        let place = showsProject ? row.project?.name ?? row.source.name : row.source.name
        let what: String? = if let round = row.round, round.n > 1 { "round \(round.n)" }
            else if row.item.interaction != nil { row.type }
            else { row.topic }
        return [place, what].compactMap { $0 }.joined(separator: " · ")
    }

    /// A question shows what became of it: the answer on the question's own row, or the question asked on a card.
    private var answer: (text: String, color: Color)? {
        if row.item.interaction != nil {
            switch row.outcome {
            case let .answered(answer):
                let declined = ["Declined", "No"].contains(answer)
                let text = switch answer {
                case "Approved": "You approved"
                case "Declined": "You declined"
                case "Yes": "You said yes"
                case "No": "You said no"
                case "Withdrawn": "Withdrawn"
                default: "You chose \(answer)"
                }
                return (text, declined ? ReloHoloTheme.color(.attention) : ReloHoloTheme.color(.done))
            case .unanswered: return ("No answer in time", Color.reloSecondaryText)
            default: return nil
            }
        }
        guard let decision = row.decision else { return nil }
        let tint = decision.pending ? Color.reloSignalCoral : decision.declined ? ReloHoloTheme.color(.attention) : ReloHoloTheme.color(.done)
        return ("\(decision.answer): \(decision.prompt)", tint)
    }

    private var unreadMessage: Bool { row.unread && row.outcome == .message }

    /// The state this row draws with: the server's, else the row's outcome; a message has none, so its type stands.
    private var base: ReloStateStyle? { serverOutcome ?? ReloStateStyle.make(outcome: row.outcome) }

    private var state: ReloStateStyle {
        if let responseStatus { return (base ?? .message).labelled(responseStatus) }
        return base ?? ReloStateStyle(label: row.type, color: .reloSecondaryText, symbol: "bell.fill")
    }

    /// The color of what it means, the same as its bar in the day's chart.
    private var color: Color { ReloHoloTheme.color(HistoryTimeline.signal(row)) }

    private var glyph: String {
        if row.item.interaction != nil { return "questionmark" }
        switch row.outcome {
        case .done: return "checkmark"
        case .stopped: return "exclamationmark"
        case .expired, .unanswered: return "clock"
        case .ended: return "stop.fill"
        case .replaced: return "arrow.triangle.2.circlepath"
        case .message: return "bell.fill"
        case .answered: return "questionmark"
        case .running: return "waveform"
        case .waitingForYou: return "hand.raised.fill"
        }
    }

    /// Where it ran and how long it took; why it left the screen comes first when the server says.
    private var facts: [String] {
        var parts: [String] = []
        if let absence = serverOutcome?.absence, let why = AbsenceWording.line(absence, computer: row.origin) { parts.append(why) }
        if let origin = row.origin { parts.append(origin) }
        if let duration = row.duration { parts.append(ReloDuration.format(duration)) }
        return parts
    }
}

/// The time column's words: AM and PM only where the locale reads a 12-hour clock.
enum HistoryClock {
    /// The locale's AM and PM words, read once and again only when the locale changes: building a formatter for
    /// every row of a long list was the cost.
    private struct Halves {
        let usesDayHalves: Bool
        let am: String
        let pm: String
    }

    nonisolated(unsafe) private static var cached: (identifier: String, halves: Halves)?

    private static var halves: Halves {
        let locale = Locale.current
        if let cached, cached.identifier == locale.identifier { return cached.halves }
        let formatter = DateFormatter()
        formatter.locale = locale
        let halves = Halves(
            usesDayHalves: DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: locale)?.contains("a") == true,
            am: formatter.amSymbol, pm: formatter.pmSymbol)
        cached = (locale.identifier, halves)
        return halves
    }

    static var usesDayHalves: Bool { halves.usesDayHalves }

    static func dayHalf(_ date: Date, calendar: Calendar = .current) -> String? {
        let halves = halves
        guard halves.usesDayHalves else { return nil }
        return calendar.component(.hour, from: date) < 12 ? halves.am : halves.pm
    }

    /// The chart's four hour marks: 12a 6a 12p 6p, or 00 06 12 18 on a 24-hour clock.
    static var axis: [String] { usesDayHalves ? ["12a", "6a", "12p", "6p"] : ["00", "06", "12", "18"] }
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
