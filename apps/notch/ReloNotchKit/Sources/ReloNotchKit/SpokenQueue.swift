import Foundation

/// The lines waiting to be said after their cue (ADR 0015): one at a time, never interrupting, most important first.
/// A burst says at most two lines; what is left becomes one count line ("And 2 more updates."), except open questions
/// and failures, which each get their own line. News that waited too long is dropped; a question stays while it is open.
public struct SpokenQueue: Sendable {
    public struct Line: Equatable, Sendable {
        public var id: String
        public var kind: NotchEvent.Kind
        public var text: String
        public var at: Date
        /// The cue to play right before the line, when it could not play on arrival because another line was being
        /// said: a sound never lands on top of the voice.
        public var cue: String?

        public init(id: String, kind: NotchEvent.Kind, text: String, at: Date, cue: String? = nil) {
            self.id = id
            self.kind = kind
            self.text = text
            self.at = at
            self.cue = cue
        }
    }

    /// A your-turn or finished line older than this is past news.
    public static let staleAfter: TimeInterval = 60
    /// Lines said in one burst before the rest becomes a count.
    public static let perBurst = 2

    public private(set) var waiting: [Line] = []
    private var saidInBurst = 0

    public init() {}

    public var isEmpty: Bool { waiting.isEmpty }

    /// Queues `lines`; a line already waiting for the same card and kind is replaced by the newer one.
    public mutating func add(_ lines: [Line]) {
        for line in lines {
            waiting.removeAll { $0.id == line.id && $0.kind == line.kind }
            waiting.append(line)
        }
        waiting = waiting.enumerated().sorted { a, b in
            a.element.kind.rank != b.element.kind.rank ? a.element.kind.rank < b.element.kind.rank : a.offset < b.offset
        }.map(\.element)
    }

    /// The next line to say, or nil when nothing is left (the burst ends). `open` says whether a question line's
    /// question is still waiting for an answer.
    public mutating func next(now: Date, open: (Line) -> Bool) -> Line? {
        waiting.removeAll { line in
            line.kind == .question ? !open(line) : now.timeIntervalSince(line.at) > Self.staleAfter
        }
        guard !waiting.isEmpty else {
            saidInBurst = 0
            return nil
        }
        if saidInBurst >= Self.perBurst {
            if let urgent = waiting.firstIndex(where: { $0.kind == .question || $0.kind == .failed }) {
                return waiting.remove(at: urgent)
            }
            let count = waiting.count
            waiting.removeAll()
            return Line(id: "", kind: .progressed, text: "And \(count) more update\(count == 1 ? "" : "s").", at: now)
        }
        saidInBurst += 1
        return waiting.removeFirst()
    }

    /// Drops everything (the microphone came on, alerts were paused): it would be stale by the time it could be said.
    public mutating func clear() {
        waiting.removeAll()
        saidInBurst = 0
    }
}
