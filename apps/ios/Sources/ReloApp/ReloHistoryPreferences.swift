import ReloCore
import SwiftUI
import UserNotifications

/// The person's choice of how much past to see on this iPhone, shared by Now, History and Settings.
enum ReloHistoryPreferences {
    static let retentionKey = "relo.history.retention"
    static let clearedAtKey = "relo.history.clearedAt"

    static func retention(_ raw: String) -> HistoryRetention { HistoryRetention(rawValue: raw) ?? .standard }

    static func since(retention raw: String, clearedAt: Double, now: Date) -> Date? {
        retention(raw).visibleSince(clearedAt: clearedAt > 0 ? Date(timeIntervalSince1970: clearedAt) : nil, now: now)
    }

    /// Clearing also empties Notification Center, so nothing old lingers on the Lock Screen.
    @MainActor static func clear(_ clearedAt: inout Double) {
        clearedAt = Date.now.timeIntervalSince1970
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }
}
