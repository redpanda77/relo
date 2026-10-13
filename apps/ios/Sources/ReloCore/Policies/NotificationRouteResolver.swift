import Foundation

public enum NotificationRouteResolver {
    public static func contains(notificationID: String, in items: [InboxItem]) -> Bool {
        items.contains { $0.id == notificationID }
    }
}
