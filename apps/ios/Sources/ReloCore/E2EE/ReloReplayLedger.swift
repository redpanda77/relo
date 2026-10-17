import Foundation

/// Replay protection for sealed content (docs/ENCRYPTION-PROTOCOL.md, E6.3). A server holds old
/// envelopes and could re-deliver one as a new notification; its signature would still verify. Every
/// envelope is bound to its request `context`, so the phone remembers which item first carried each
/// context and refuses the same context under a different item.
public protocol ReloReplayLedger: Sendable {
    /// True when `context` is new or already belongs to `itemID`; false for a replay.
    func admit(context: String, itemID: String, now: Date) -> Bool
}

public struct ReloReplayEntry: Codable, Equatable, Sendable {
    public var itemID: String
    public var seenAt: Date
}

public enum ReloReplayRules {
    /// Contexts remembered; the oldest are forgotten first. Content older than the server's
    /// retention window is gone anyway, so this comfortably covers it.
    public static let capacity = 4_000

    public static func admit(_ entries: inout [String: ReloReplayEntry], context: String, itemID: String, now: Date) -> Bool {
        if let known = entries[context] { return known.itemID == itemID }
        entries[context] = ReloReplayEntry(itemID: itemID, seenAt: now)
        if entries.count > capacity {
            let overflow = entries.count - capacity
            for (key, _) in entries.sorted(by: { $0.value.seenAt < $1.value.seenAt }).prefix(overflow) { entries.removeValue(forKey: key) }
        }
        return true
    }
}
