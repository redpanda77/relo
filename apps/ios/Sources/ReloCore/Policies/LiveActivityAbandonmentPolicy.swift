import Foundation

/// When a card on the phone may be ended locally because nothing will keep it current.
/// The server ends an idle card 10 minutes after it goes stale and every card at its absolute
/// expiry; a card past either point (with margin) can only be a leftover the server no longer
/// tracks, or one whose end push never arrived. Ending it locally needs no network.
public enum LiveActivityAbandonmentPolicy {
    public enum Reason: String, Equatable, Sendable { case expired, abandoned }

    /// Generous margin over the server's 10-minute idle end, so a live card is never cut short.
    public static let idleGrace: TimeInterval = 30 * 60

    public static func reason(expiresAt: Date?, staleAt: Date?, now: Date) -> Reason? {
        if let expiresAt, expiresAt <= now { return .expired }
        if let staleAt, staleAt.addingTimeInterval(idleGrace) <= now { return .abandoned }
        return nil
    }
}
