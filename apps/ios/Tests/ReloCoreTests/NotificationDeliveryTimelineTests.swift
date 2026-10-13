import Foundation
import Testing
@testable import ReloCore

@Suite("Notification delivery timeline")
struct NotificationDeliveryTimelineTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func item(_ state: InboxItem.DeliveryState? = nil, accepted: Date? = nil, received: Date? = nil,
              opened: Date? = nil, interaction: InboxInteraction? = nil) -> InboxItem {
        InboxItem(id: "ntf_1", kind: .notification, sourceName: "Codex", title: "Done", deliveryState: state,
                  apnsAcceptedAt: accepted, receivedAt: received, openedAt: opened, createdAt: now, interaction: interaction)
    }

    @Test("Only evidenced steps complete, with one waiting step after them")
    func evidencedSteps() {
        let sent = NotificationDeliveryTimeline.make(item(.acceptedByAPNs, accepted: now + 1)).steps
        #expect(sent.map(\.id) == ["sent", "apns", "received"])
        #expect(sent.map(\.state) == [.complete, .complete, .waiting])

        let opened = NotificationDeliveryTimeline.make(item(accepted: now + 1, received: now + 2, opened: now + 3)).steps
        #expect(opened.map(\.id) == ["sent", "apns", "received", "opened"])
        #expect(opened.allSatisfy { $0.state == .complete })
    }

    @Test("A card command ends at Apple's delivery and never waits for a receipt it cannot get")
    func cardCommands() {
        for operation in [LiveActivityCommand.Operation.update, .end] {
            let card = InboxItem(id: "ntf_card", kind: .liveActivity, sourceName: "Codex", title: "Release",
                deliveryState: .acceptedByAPNs, apnsAcceptedAt: now + 1, createdAt: now,
                liveActivity: LiveActivityCommand(operation: operation, activityId: "act_card123456", generation: 1,
                    targetDeviceId: "dev_card123456", style: "steps", sourceName: "Codex", headline: "Release",
                    status: "Working", sequence: 1))
            let steps = NotificationDeliveryTimeline.make(card).steps
            #expect(steps.map(\.id) == ["sent", "apns"])
            #expect(steps.allSatisfy { $0.state == .complete })
            #expect(steps.last?.title == "Delivered to the card by Apple")
        }
    }

    @Test("A rejected push stops at a failed step")
    func failure() {
        let steps = NotificationDeliveryTimeline.make(item(.tokenInvalid)).steps
        #expect(steps.map(\.state) == [.complete, .failed])
    }

    @Test("A pending decision waits for the answer; a response completes it")
    func decisions() {
        let pending = InboxInteraction(id: "int_1", kind: .approval, prompt: "Ship?", state: .pending, expiresAt: now + 600)
        #expect(NotificationDeliveryTimeline.make(item(accepted: now, received: now + 1, interaction: pending)).steps.last?.state == .waiting)
        let answered = InboxInteraction(id: "int_1", kind: .approval, prompt: "Ship?", state: .approved,
                                        expiresAt: now + 600, respondedAt: now + 30)
        let steps = NotificationDeliveryTimeline.make(item(accepted: now, received: now + 1, interaction: answered)).steps
        #expect(steps.last?.id == "answered")
        #expect(steps.last?.state == .complete)
    }

    @Test("Receipt never borrows the time the app was opened")
    func openedIsNotReceived() {
        let steps = NotificationDeliveryTimeline.make(item(accepted: now + 1, opened: now + 140)).steps
        #expect(steps.map(\.id) == ["sent", "apns", "received", "opened"])
        #expect(steps[2].state == .complete)
        #expect(steps[2].date == nil)
        #expect(steps[3].title == "Opened in Relo")
    }

    @Test("An answer from this iPhone proves it had the request")
    func answerIsReceipt() {
        let answered = InboxInteraction(id: "int_1", kind: .yesNo, prompt: "Ship?", state: .no,
                                        expiresAt: now + 300, respondedAt: now + 20)
        let steps = NotificationDeliveryTimeline.make(item(accepted: now + 1, interaction: answered)).steps
        #expect(steps.map(\.id) == ["sent", "apns", "received", "answered"])
        #expect(steps.allSatisfy { $0.state == .complete })
    }
}
