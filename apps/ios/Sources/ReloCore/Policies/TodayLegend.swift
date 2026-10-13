import Foundation

/// The one-line key under the activity strip: only the meanings present today.
public struct TodayLegendEntry: Equatable, Sendable {
    public let signal: NowSignal
    public let count: Int

    public var text: String { "\(count) \(Self.word(signal, count: count))" }

    static func word(_ signal: NowSignal, count: Int) -> String {
        switch signal {
        case .done: "done"
        case .running: "running"
        case .needsYou: "waiting"
        case .attention: "to review"
        case .failed: "stopped"
        case .message: count == 1 ? "message" : "messages"
        }
    }
}

public extension TodayActivity {
    /// Today's items counted by meaning, in a stable order, skipping meanings with none.
    var legend: [TodayLegendEntry] {
        var counts: [NowSignal: Int] = [:]
        for row in rows { counts[NowSignal.of(row.outcome), default: 0] += 1 }
        return NowSignal.allCases.compactMap { signal in
            counts[signal].flatMap { $0 > 0 ? TodayLegendEntry(signal: signal, count: $0) : nil }
        }
    }

    /// "5 done, 2 messages" for VoiceOver.
    var legendSpoken: String { legend.map(\.text).joined(separator: ", ") }
}
