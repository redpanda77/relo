import Foundation

public enum LiveActivityResponsePolicy {
    public static let acceptedDismissalDelay: TimeInterval = 5

    public static func terminalDismissalDate(presentedAt: Date) -> Date {
        presentedAt.addingTimeInterval(acceptedDismissalDelay)
    }

    public static func canonicalState(for action: NotificationInteractionAction) -> String? {
        switch action {
        case .approve: "approved"
        case .deny: "denied"
        case .yes: "yes"
        case .no: "no"
        case .choose: "replied"
        case .answer, .opened, .received: nil
        }
    }

    public static func isCanonicalResponse(
        _ state: String,
        for action: NotificationInteractionAction
    ) -> Bool {
        canonicalState(for: action) == state
    }

    public static func supports(_ action: NotificationInteractionAction, kind: String) -> Bool {
        switch kind {
        case "approval": [.approve, .deny].contains(action)
        case "yes_no": [.yes, .no].contains(action)
        case "choice": action == .choose
        default: false
        }
    }

    public static func isValid(
        phase: LiveActivityResponsePhase?,
        action: NotificationInteractionAction?,
        interactionKind: String,
        interactionState: String
    ) -> Bool {
        guard phase != nil || action != nil else { return true }
        guard
            let phase,
            let action,
            canonicalState(for: action) != nil,
            supports(action, kind: interactionKind)
        else { return false }
        if phase == .accepted {
            return isCanonicalResponse(interactionState, for: action)
        }
        return interactionState == "pending"
    }

    /// A choice names the picked option (`optionLabel`) in place of the generic action word,
    /// so the card ends showing what was chosen.
    public static func status(
        phase: LiveActivityResponsePhase,
        action: NotificationInteractionAction,
        confirmedState: String? = nil,
        optionLabel: String? = nil
    ) -> String {
        if action == .choose, let optionLabel {
            switch phase {
            case .sending: return "Sending \(optionLabel)…"
            case .queued: return "\(optionLabel) queued"
            case .accepted: return optionLabel
            case .rejected: return "Response not recorded"
            }
        }
        let label = actionLabel(action)
        switch phase {
        case .sending: return "Sending \(label)…"
        case .queued: return "\(label) queued"
        case .accepted:
            return (confirmedState ?? canonicalState(for: action) ?? label).replacingOccurrences(
                of: "_",
                with: " "
            ).capitalized
        case .rejected: return "Response not recorded"
        }
    }

    public static func actionLabel(_ action: NotificationInteractionAction) -> String {
        switch action {
        case .approve: "approval"
        case .deny: "denial"
        case .yes: "yes"
        case .no: "no"
        case .answer: "reply"
        case .choose: "choice"
        case .opened: "opened"
        case .received: "received"
        }
    }
}
