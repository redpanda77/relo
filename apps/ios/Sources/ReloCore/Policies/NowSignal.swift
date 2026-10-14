import Foundation

/// What a thing on the Now screen means. Every color in the app maps to exactly one of these,
/// so the orb, the readouts, badges, activity bars and Live Activities all speak one language:
/// done is green, running is cyan, needs you is orange, attention is yellow, failed is red,
/// and messages are violet.
public enum NowSignal: Int, CaseIterable, Sendable {
    case done, running, needsYou, attention, failed, message

    public var label: String {
        switch self {
        case .done: "Done"
        case .running: "Running"
        case .needsYou: "Needs you"
        case .attention: "Attention"
        case .failed: "Failed"
        case .message: "Messages"
        }
    }

    /// The meaning of a History row's outcome.
    public static func of(_ outcome: HistoryRow.Outcome) -> NowSignal {
        switch outcome {
        case .done: .done
        case .running: .running
        case .waitingForYou: .needsYou
        case .stopped: .failed
        case .expired, .ended, .replaced, .unanswered: .attention
        case let .answered(answer): ["Declined", "No"].contains(answer) ? .attention : .done
        case .message: .message
        }
    }
}

/// Today's work by meaning: how much of it is each signal. The orb is colored in these
/// proportions, so the sphere itself shows how the day is going.
public struct NowMix: Equatable, Sendable {
    public let counts: [NowSignal: Int]

    public init(counts: [NowSignal: Int]) { self.counts = counts.filter { $0.value > 0 } }

    /// Today's rows plus what is live right now (requests waiting and running cards).
    public static func make(today rows: [HistoryRow], needsYou: Int, running: Int) -> NowMix {
        var counts: [NowSignal: Int] = [:]
        for row in rows where row.outcome != .running && row.outcome != .waitingForYou {
            counts[NowSignal.of(row.outcome), default: 0] += 1
        }
        counts[.needsYou, default: 0] += needsYou
        counts[.running, default: 0] += running
        return NowMix(counts: counts)
    }

    public var total: Int { counts.values.reduce(0, +) }
    public var isEmpty: Bool { total == 0 }

    /// Present signals in display order with their share of the whole.
    public var shares: [(signal: NowSignal, share: Double)] {
        let total = Double(max(self.total, 1))
        return NowSignal.allCases.compactMap { signal in
            counts[signal].map { (signal, Double($0) / total) }
        }
    }

    /// The signal at a position along the mix (0...1), for coloring a particle by its slot.
    public func signal(at position: Double) -> NowSignal? {
        var cumulative = 0.0
        for (signal, share) in shares {
            cumulative += share
            if position < cumulative { return signal }
        }
        return shares.last?.signal
    }
}

/// One hour of today's activity, split by meaning, for the activity strip.
public struct NowHourMix: Equatable, Sendable {
    public let hour: Int
    public let counts: [NowSignal: Int]
    public var total: Int { counts.values.reduce(0, +) }
}

public extension TodayActivity {
    /// Each hour's items split by meaning, in display order.
    var hourMixes: [NowHourMix] {
        let calendar = Calendar.current
        var hours = (0..<24).map { _ in [NowSignal: Int]() }
        for row in rows {
            let hour = min(23, max(0, calendar.component(.hour, from: row.at)))
            hours[hour][NowSignal.of(row.outcome), default: 0] += 1
        }
        return hours.enumerated().map { NowHourMix(hour: $0.offset, counts: $0.element) }
    }
}
