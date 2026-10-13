import Foundation

/// Friendly delivery wording preserves the distinction between sending and receipt.
public struct NotificationDeliverySummary: Equatable, Sendable {
    public let title: String
    public let symbol: String
    public let detail: String?
    public let confirmedAt: Date?

    public static func make(_ item: InboxItem) -> Self {
        if let date = item.withdrawnAt { return .init(title: "Removed", symbol: "minus.circle", detail: nil, confirmedAt: date) }
        if let date = item.openedAt { return .init(title: "Opened on this iPhone", symbol: "checkmark.circle.fill", detail: nil, confirmedAt: date) }
        if let date = item.receivedAt { return .init(title: "Received on this iPhone", symbol: "checkmark.circle", detail: nil, confirmedAt: date) }
        switch item.deliveryState {
        case .rejected, .tokenInvalid:
            return .init(title: "Couldn't deliver", symbol: "exclamationmark.circle", detail: "Check your notification settings.", confirmedAt: nil)
        case .queued, .sending, .retryable:
            return .init(title: "Sending", symbol: "paperplane", detail: nil, confirmedAt: nil)
        case .acceptedByAPNs:
            return .init(title: "Sent", symbol: "paperplane.fill", detail: "Waiting for confirmation from this iPhone.", confirmedAt: item.apnsAcceptedAt)
        case .reconciliationRequired, nil:
            if let date = item.apnsAcceptedAt {
                return .init(title: "Sent", symbol: "paperplane.fill", detail: "Waiting for confirmation from this iPhone.", confirmedAt: date)
            }
            return .init(title: "Delivery not confirmed", symbol: "clock", detail: nil, confirmedAt: nil)
        }
    }
}
