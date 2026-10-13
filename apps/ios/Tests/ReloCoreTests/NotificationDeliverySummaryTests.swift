import Foundation
import Testing
@testable import ReloCore

@Suite("Plain language message delivery")
struct NotificationDeliverySummaryTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func item(_ state: InboxItem.DeliveryState? = nil, received: Bool = false, opened: Bool = false,
                      removed: Bool = false, accepted: Bool = false) -> InboxItem {
        .init(id: "message", kind: .notification, sourceName: "Fixture", title: "Hello",
            withdrawnAt: removed ? now : nil, deliveryState: state, apnsAcceptedAt: accepted ? now : nil,
            receivedAt: received ? now : nil, openedAt: opened ? now : nil, createdAt: now)
    }
    @Test("Sending to Apple never implies receipt or opening")
    func acceptance() {
        let sent = NotificationDeliverySummary.make(item(.acceptedByAPNs, accepted: true))
        #expect(sent.title == "Sent")
        #expect(sent.detail == "Waiting for confirmation from this iPhone.")
        #expect(NotificationDeliverySummary.make(item()).title == "Delivery not confirmed")
        #expect(NotificationDeliverySummary.make(item(accepted: true)).title == "Sent")
    }
    @Test("Phone evidence and withdrawal override transport state")
    func authoritativeEvidence() {
        #expect(NotificationDeliverySummary.make(item(.rejected, received: true)).title == "Received on this iPhone")
        #expect(NotificationDeliverySummary.make(item(.sending, received: true, opened: true)).title == "Opened on this iPhone")
        #expect(NotificationDeliverySummary.make(item(.acceptedByAPNs, received: true, opened: true, removed: true)).title == "Removed")
    }
    @Test(arguments: [InboxItem.DeliveryState.queued, .sending, .retryable])
    func sending(state: InboxItem.DeliveryState) {
        #expect(NotificationDeliverySummary.make(item(state)).title == "Sending")
    }
    @Test(arguments: [InboxItem.DeliveryState.rejected, .tokenInvalid])
    func failures(state: InboxItem.DeliveryState) {
        let result = NotificationDeliverySummary.make(item(state))
        #expect(result.title == "Couldn't deliver")
        #expect(result.confirmedAt == nil)
    }
}
