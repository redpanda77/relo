import ReloCore
import SwiftUI

extension Color {
    fileprivate init(reloHex hex: UInt32) {
        self.init(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255,
                  blue: Double(hex & 255) / 255)
    }

    /// Dashboard `--muted-foreground` (7:1 on the canvas).
    static let reloSecondaryText = Color(reloHex: 0xA4A4B6)
    static let reloErrorText = Color(reloHex: 0xF87171)
    /// Dashboard `--primary`: links, tint and the "act" color.
    static let reloInteractive = Color(reloHex: 0xFF6B57)
    /// State colors (`--status-*`): needs you, running, done.
    static let reloSignalCoral = Color(reloHex: 0xFF7A66)
    static let reloSignalIndigo = Color(reloHex: 0x8B7CFF)
    static let reloDone = Color(reloHex: 0x34D399)
    static let reloInfo = Color(reloHex: 0x94A3B8)
    static let reloWarning = Color(reloHex: 0xFBBF24)
}

/// The one table of how a piece of work stands: its words, symbol and color. History, the detail page, Now,
/// the Lock Screen and message kinds all read it, so "Running" is the same indigo wherever it appears.
/// Coral asks for the owner, indigo moves, green is done, amber stopped short, red failed, slate is quiet.
struct ReloStateStyle: Equatable, Sendable {
    let label: String
    let color: Color
    let symbol: String
    /// Why the work left the screen or dimmed, from the server; shown as the first fact.
    var absence: Absence? = nil

    init(label: String, color: Color, symbol: String) {
        self.label = label; self.color = color; self.symbol = symbol
    }

    // MARK: Named states

    static let running = ReloStateStyle(label: "Running", color: .reloSignalIndigo, symbol: "waveform")
    static let waiting = ReloStateStyle(label: "Waiting", color: .reloWarning, symbol: "hourglass")
    static let done = ReloStateStyle(label: "Done", color: .reloDone, symbol: "checkmark")
    static let failed = ReloStateStyle(label: "Failed", color: .reloErrorText, symbol: "xmark.octagon.fill")
    static let dropped = ReloStateStyle(label: "Dropped", color: .reloWarning, symbol: "stop.fill")
    static let leftUnfinished = ReloStateStyle(label: "Left unfinished", color: .reloWarning, symbol: "exclamationmark.triangle.fill")
    static let needsYou = ReloStateStyle(label: "Needs you", color: .reloSignalCoral, symbol: "exclamationmark.bubble.fill")
    static let yourTurn = ReloStateStyle(label: "Your turn", color: .reloSignalCoral, symbol: "hand.raised.fill")
    static let missed = ReloStateStyle(label: "Missed", color: .reloSignalCoral, symbol: "clock.badge.xmark")
    static let permission = ReloStateStyle(label: "Permission", color: .reloSignalCoral, symbol: "lock.shield.fill")
    static let quiet = ReloStateStyle(label: "Quiet", color: .reloInfo, symbol: "moon.zzz")
    static let stoppedResponding = ReloStateStyle(label: "Stopped responding", color: .reloInfo, symbol: "pause.circle")
    static let noSignal = ReloStateStyle(label: "No signal", color: .reloInfo, symbol: "antenna.radiowaves.left.and.right.slash")
    static let paused = ReloStateStyle(label: "Paused", color: .reloInfo, symbol: "pause.fill")
    static let unconfirmed = ReloStateStyle(label: "Unconfirmed", color: .reloInfo, symbol: "questionmark.circle")
    static let idle = ReloStateStyle(label: "Idle", color: .reloInfo, symbol: "circle.fill")
    static let ended = ReloStateStyle(label: "Ended", color: .reloInfo, symbol: "stop.fill")
    static let message = ReloStateStyle(label: "Message", color: .reloInfo, symbol: "bell.fill")

    func labelled(_ text: String) -> ReloStateStyle {
        var copy = ReloStateStyle(label: text, color: color, symbol: symbol)
        copy.absence = absence
        return copy
    }

    // MARK: From the server's state

    /// From the item's owner state and, for a question, its standing.
    /// The badge tells the truth: Running only while moving; a work that declared it waits reads Waiting; a
    /// question reads Needs you; a delivered round reads Your turn. The server's state is the input.
    static func make(state: OwnerState?, standing: QuestionStanding?, answer: String? = nil, waiting: Bool = false) -> ReloStateStyle? {
        switch standing {
        case .missed?: return .missed
        case .answeredLate?:
            let declined = answer.map { ["Declined", "No"].contains($0) } == true
            return ReloStateStyle(label: answer.map { "\($0) (answered late)" } ?? "Answered late",
                                  color: declined ? .reloWarning : .reloDone, symbol: "checkmark.bubble.fill")
        default: break
        }
        switch state {
        case .done?: return .done
        case .failed?: return .failed
        case .dropped?: return .dropped
        case .leftUnfinished?: return .leftUnfinished
        case .moving?, .workingQuietly?: return waiting ? .waiting : .running
        case .needsYou?: return .needsYou
        case .waitingOnYou?: return .yourTurn
        case .stale?: return .quiet
        case .stoppedResponding?: return .stoppedResponding
        case .noSignal?: return .noSignal
        case .paused?: return .paused
        case .unknown?, nil: return nil
        }
    }

    /// The outcome of a work the Now summary still lists (recent outcomes, missed questions).
    init?(item: NowItem) {
        guard let outcome = Self.make(state: item.owner.state, standing: item.question?.standing,
                                      waiting: PlanWaiting.reason(status: item.status) != nil) else { return nil }
        self = outcome
        absence = item.owner.absence
    }

    /// From a History row's outcome, when the server's state is not known.
    static func make(outcome: HistoryRow.Outcome) -> ReloStateStyle? {
        guard let label = outcome.label else { return nil }
        switch outcome {
        case .running: return .running
        case .done: return .done
        case .stopped: return ReloStateStyle(label: label, color: .reloWarning, symbol: "exclamationmark.triangle.fill")
        case .expired: return ReloStateStyle(label: label, color: .reloInfo, symbol: "clock.badge.xmark")
        case .ended: return ReloStateStyle(label: label, color: .reloInfo, symbol: "stop.fill")
        case .replaced: return ReloStateStyle(label: label, color: .reloInfo, symbol: "arrow.triangle.2.circlepath")
        case .waitingForYou: return ReloStateStyle.yourTurn.labelled(label)
        case let .answered(answer):
            return ReloStateStyle(label: label, color: ["Declined", "No"].contains(answer) ? .reloWarning : .reloDone,
                                  symbol: "checkmark.bubble.fill")
        case .unanswered: return ReloStateStyle(label: label, color: .reloInfo, symbol: "clock")
        case .message: return nil
        }
    }

    /// The style a bare History outcome draws with (a message has no state: its symbol and color only).
    static func glyph(outcome: HistoryRow.Outcome) -> (symbol: String, color: Color) {
        make(outcome: outcome).map { ($0.symbol, $0.color) } ?? (message.symbol, message.color)
    }
}
