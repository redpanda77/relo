import ReloCore
import UserNotifications

/// A question answered elsewhere (the notch, the Dashboard, another copy of it) or no longer asked
/// leaves Notification Center. The server's silent push names the settled notifications
/// (`relo.settled`), and every inbox sync sweeps any delivered question that is no longer pending, so a
/// push that never arrived is caught the next time the app reads the inbox.
enum SettledNotifications {
    /// The notification ids a silent settle push names.
    static func ids(in userInfo: [AnyHashable: Any]) -> Set<String> {
        guard let relo = userInfo["relo"] as? [String: Any], let ids = relo["settled"] as? [String] else { return [] }
        return Set(ids.filter { ReloIdentifier.isValid($0) })
    }

    /// The inbox items whose question is no longer pending, or that were withdrawn.
    static func ids(in items: [InboxItem]) -> Set<String> {
        Set(items.compactMap { item in
            if item.withdrawnAt != nil { return item.id }
            guard let state = item.interaction?.state, state != .pending else { return nil }
            return item.id
        })
    }

    /// The delivered notifications (by request identifier) that carry one of `ids` as `relo.notificationId`.
    static func requestIdentifiers(delivered: [(identifier: String, userInfo: [AnyHashable: Any])], settled ids: Set<String>) -> [String] {
        delivered.compactMap { notification in
            guard let relo = notification.userInfo["relo"] as? [String: Any],
                  let id = relo["notificationId"] as? String, ids.contains(id)
            else { return nil }
            return notification.identifier
        }
    }

    static func remove(_ ids: Set<String>, center: UNUserNotificationCenter = .current()) async {
        guard !ids.isEmpty else { return }
        let delivered = await center.deliveredNotifications().map { (identifier: $0.request.identifier, userInfo: $0.request.content.userInfo) }
        let stale = requestIdentifiers(delivered: delivered, settled: ids)
        if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale) }
    }
}
