import Foundation

public enum NotificationReceiptScopePolicy {
    public static func eligible(
        pendingNotificationIDs: [String],
        authoritativeNotificationIDs: Set<String>
    ) -> [String] {
        var seen = Set<String>()
        return pendingNotificationIDs.filter {
            authoritativeNotificationIDs.contains($0) && seen.insert($0).inserted
        }
    }
}
