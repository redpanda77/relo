import Foundation

/// A moment worth telling the owner about: a window crossed 80%, ran out, or reset.
public struct UsageCrossing: Sendable, Equatable {
    public enum Kind: Sendable, Equatable { case crossed80, reached100, reset }
    public var accountID: String
    public var accountName: String
    public var windowKind: String
    public var windowLabel: String
    public var kind: Kind
    public var usedPercent: Double
}

/// Derives crossings from successive readings. The first reading of a window only seeds its baseline; each
/// crossing fires once per window and fires again only after a reset.
struct UsageCrossingTracker {
    private struct State {
        var percent: Double
        var resetsAt: Date?
        var fired80: Bool
        var fired100: Bool
        /// The reset of this reading was already reported (the CLI keeps listing an expired window).
        var consumed = false
    }

    private var states: [String: State] = [:]

    private static func key(_ account: String, _ window: UsageWindow) -> String { "\(account)|\(window.kind)|\(window.minutes ?? 0)" }

    mutating func observe(_ accounts: [UsageAccount], now: Date) -> [UsageCrossing] {
        var out: [UsageCrossing] = []
        let ids = Set(accounts.map(\.id))
        states = states.filter { ids.contains(String($0.key.split(separator: "|", maxSplits: 1)[0])) }

        for account in accounts {
            var present = Set<String>()
            for window in account.windows {
                let k = Self.key(account.id, window)
                present.insert(k)
                func make(_ kind: UsageCrossing.Kind) -> UsageCrossing {
                    UsageCrossing(accountID: account.id, accountName: account.displayName, windowKind: window.kind,
                                  windowLabel: window.label, kind: kind, usedPercent: window.usedPercent)
                }
                let p = window.usedPercent
                if window.isExpired(now: now) {
                    if var prior = states[k], !prior.consumed {
                        if prior.percent >= 30 { out.append(make(.reset)) }
                        prior = State(percent: 0, resetsAt: window.resetsAt, fired80: false, fired100: false, consumed: true)
                        states[k] = prior
                    }
                    continue
                }
                guard var state = states[k] else {
                    states[k] = State(percent: p, resetsAt: window.resetsAt, fired80: p >= 80, fired100: p >= 99.5)
                    continue
                }
                if state.consumed {
                    state = State(percent: p, resetsAt: window.resetsAt, fired80: false, fired100: false)
                } else {
                    let passed = state.resetsAt.map { $0 <= now } ?? false
                    let fell = state.percent >= 30 && p <= 10 && state.percent - p >= 20
                    if (passed && state.percent >= 30) || fell {
                        out.append(make(.reset))
                        state.fired80 = false; state.fired100 = false
                    } else if passed {
                        state.fired80 = false; state.fired100 = false
                    }
                }
                if p >= 99.5 && !state.fired100 {
                    out.append(make(.reached100)); state.fired100 = true; state.fired80 = true
                } else if p >= 80 && !state.fired80 {
                    out.append(make(.crossed80)); state.fired80 = true
                }
                state.percent = p
                state.resetsAt = window.resetsAt
                states[k] = state
            }
            // A window the command stopped listing whose reset time passed has reset.
            for (k, state) in states where k.hasPrefix(account.id + "|") && !present.contains(k) && !state.consumed {
                guard let at = state.resetsAt, at <= now else { continue }
                let parts = k.split(separator: "|", omittingEmptySubsequences: false)
                if state.percent >= 30 {
                    let w = UsageWindow(kind: String(parts[1]), minutes: Int(parts[2]).flatMap { $0 == 0 ? nil : $0 }, usedPercent: 0, resetsAt: nil)
                    out.append(UsageCrossing(accountID: account.id, accountName: account.displayName, windowKind: w.kind,
                                             windowLabel: w.label, kind: .reset, usedPercent: 0))
                }
                states[k] = State(percent: 0, resetsAt: at, fired80: false, fired100: false, consumed: true)
            }
        }
        return out
    }
}
