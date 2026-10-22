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

// MARK: - Relo's cues (ADR 0013, sections 1 and 2)

/// The iPhone's sound set: the owner-meaningful moments that carry a sound. The raw value is the file's name
/// (`needs-you.caf`), the same name the server puts in a push's `aps.sound`. Onboarding and the notch's
/// interface sounds belong to the Mac and are not here.
public enum ReloCue: String, CaseIterable, Sendable {
    case needsYou = "needs-you", failed, yourTurn = "your-turn", done, sent, linked

    /// The `.caf` the push names and the app plays.
    public var fileName: String { rawValue + ".caf" }

    /// Highest first when one batch holds several moments: needs you, failed, your turn, done.
    var rank: Int {
        switch self {
        case .needsYou: 0
        case .failed: 1
        case .yourTurn: 2
        case .done: 3
        case .sent: 4
        case .linked: 5
        }
    }
}

/// The rules that keep cues from being too much (ADR 0013, section 2), as one value so they are testable:
/// - the first observation is the baseline: what already waits makes no sound;
/// - once per moment: an id is cued when it first appears, never again;
/// - one cue per batch, the highest moment wins, and at most one every `spacing` seconds;
/// - the owner acting is not news: an id the owner is looking at is consumed without a cue.
public struct ReloCueGate: Sendable {
    public var spacing: TimeInterval
    private var seen: Set<String> = []
    private var baselined = false
    private var lastCue = Date.distantPast

    public init(spacing: TimeInterval = 2) { self.spacing = spacing }

    /// Observes the moments present now (ids by cue) and returns the cue to play, if any.
    /// - Parameters:
    ///   - quiet: nothing is cued (not yet armed, hidden): the ids are still consumed, so they never cue later.
    ///   - looking: ids the owner is looking at: consumed without a cue.
    public mutating func observe(_ present: [ReloCue: Set<String>], at now: Date = .now,
                                 quiet: Bool = false, looking: Set<String> = []) -> ReloCue? {
        var fresh: [ReloCue] = []
        var all: Set<String> = []
        for (cue, ids) in present {
            all.formUnion(ids.map { Self.key(cue, $0) })
            let news = ids.filter { !seen.contains(Self.key(cue, $0)) && !looking.contains($0) }
            if !news.isEmpty { fresh.append(cue) }
        }
        let first = !baselined
        baselined = true
        seen.formUnion(all)
        // Bounded: ids that left the present set are forgotten once the memory grows.
        if seen.count > 1_000 { seen = all }
        guard !first, !quiet, let lead = fresh.min(by: { $0.rank < $1.rank }) else { return nil }
        return admit(lead, at: now)
    }

    /// One moment of the owner's own (their answer accepted, a link landing): once per id, and spaced.
    public mutating func admit(_ cue: ReloCue, id: String, at now: Date = .now) -> Bool {
        if seen.count > 1_000 { seen = [] }
        guard seen.insert(Self.key(cue, id)).inserted else { return false }
        return admit(cue, at: now) != nil
    }

    /// Forgets the baseline (the app returned from the background): the next observation is silent again.
    public mutating func rebaseline() { baselined = false }

    private mutating func admit(_ cue: ReloCue, at now: Date) -> ReloCue? {
        guard now.timeIntervalSince(lastCue) >= spacing else { return nil }
        lastCue = now
        return cue
    }

    private static func key(_ cue: ReloCue, _ id: String) -> String { cue.rawValue + "|" + id }
}
