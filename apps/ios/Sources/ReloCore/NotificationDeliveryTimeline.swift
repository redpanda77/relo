import Foundation

/// The delivery story of one notification, in the order it happened. Only evidenced steps are
/// complete; at most one next step is shown as waiting, so the timeline never claims receipt early.
public struct NotificationDeliveryTimeline: Equatable, Sendable {
    public enum StepState: Equatable, Sendable { case complete, waiting, failed }

    public struct Step: Equatable, Sendable, Identifiable {
        public let id: String
        public let title: String
        public let detail: String?
        public let date: Date?
        public let state: StepState
    }

    public let steps: [Step]

    public static func make(_ item: InboxItem) -> Self {
        var steps = [Step(id: "sent", title: "Sent by \(item.sourceName)", detail: nil, date: item.createdAt, state: .complete)]
        switch item.deliveryState {
        case .rejected, .tokenInvalid:
            steps.append(.init(id: "failed", title: "Couldn't deliver",
                               detail: "Apple refused the push. Check notification settings on this iPhone.",
                               date: nil, state: .failed))
            return .init(steps: steps)
        default: break
        }
        let accepted = item.apnsAcceptedAt ?? (item.deliveryState == .acceptedByAPNs ? item.createdAt : nil)
        if let accepted {
            steps.append(.init(id: "apns", title: "Accepted by Apple", detail: nil, date: accepted, state: .complete))
        } else if item.receivedAt == nil && item.openedAt == nil {
            steps.append(.init(id: "apns", title: "Sending to Apple", detail: nil, date: nil, state: .waiting))
            return .init(steps: steps)
        }
        if let received = item.receivedAt {
            steps.append(.init(id: "received", title: "Received on this iPhone", detail: nil, date: received, state: .complete))
        } else if item.openedAt != nil || item.interaction?.respondedAt != nil {
            // Opening or answering proves this iPhone had it, but not when it arrived: no time is shown.
            steps.append(.init(id: "received", title: "Received on this iPhone", detail: nil, date: nil, state: .complete))
        } else if item.kind == .liveActivity {
            // Apple applies card updates straight to the Lock Screen; a card doesn't report each one
            // back, and an end removes the card. Apple's acceptance is the last fact we can show.
            if let index = steps.lastIndex(where: { $0.id == "apns" }) {
                let apns = steps[index]
                steps[index] = .init(id: apns.id, title: "Delivered to the card by Apple",
                                     detail: item.liveActivity?.operation == .end ? "The card ends on the Lock Screen when this iPhone receives it."
                                         : "Cards update on the Lock Screen without reporting each update back.",
                                     date: apns.date, state: apns.state)
            }
            return .init(steps: steps)
        } else {
            steps.append(.init(id: "received", title: "Waiting for this iPhone",
                               detail: "Apple has it; this iPhone hasn't confirmed receipt yet.",
                               date: nil, state: .waiting))
            return .init(steps: steps)
        }
        if let opened = item.openedAt {
            steps.append(.init(id: "opened", title: "Opened in Relo", detail: nil, date: opened, state: .complete))
        }
        if let interaction = item.interaction {
            if let responded = interaction.respondedAt {
                steps.append(.init(id: "answered", title: "Answered", detail: nil, date: responded, state: .complete))
            } else if interaction.state == .pending {
                steps.append(.init(id: "answered", title: "Waiting for your answer", detail: nil, date: nil, state: .waiting))
            }
        }
        if let withdrawn = item.withdrawnAt {
            steps.append(.init(id: "removed", title: "Removed", detail: nil, date: withdrawn, state: .complete))
        }
        return .init(steps: steps)
    }
}
