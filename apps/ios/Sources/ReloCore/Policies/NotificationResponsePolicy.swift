import Foundation

public enum NotificationResponsePolicy {
    public static func canonicalState(for action: NotificationInteractionAction) -> String? {
        switch action {
        case .approve: "approved"
        case .deny: "denied"
        case .yes: "yes"
        case .no: "no"
        case .answer: "replied"
        case .opened, .received: nil
        }
    }

    public static func supports(_ action: NotificationInteractionAction, kind: InboxInteraction.Kind) -> Bool {
        switch kind {
        case .approval: [.approve, .deny].contains(action)
        case .yesNo: [.yes, .no].contains(action)
        case .text: action == .answer
        }
    }

    public static func actionLabel(_ action: NotificationInteractionAction) -> String {
        switch action {
        case .approve: "approval"
        case .deny: "denial"
        case .yes: "yes"
        case .no: "no"
        case .answer: "reply"
        case .opened: "opened"
        case .received: "received"
        }
    }
}
