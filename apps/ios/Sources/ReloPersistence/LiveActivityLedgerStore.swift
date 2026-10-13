import Foundation
import ReloCore

extension AccountScopedProtectedActionStore {
    public func load() throws -> LiveActivityCommandLedger {
        try decode(LiveActivityCommandLedger.self, from: "live-activity-ledger.json") ?? LiveActivityCommandLedger()
    }

    public func save(_ ledger: LiveActivityCommandLedger) throws {
        try encode(ledger, to: "live-activity-ledger.json")
    }
}
