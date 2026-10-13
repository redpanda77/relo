import ReloCore
import SwiftUI

struct ResponseControls: View {
    @Bindable var model: AppModel
    let item: InboxItem
    @Environment(\.dynamicTypeSize) private var typeSize
    private var state: ResponsePresentationState {
        let eligible = model.currentDecision(notificationID: item.id).map {
            model.decisionAvailability($0.identity).permitsSubmission
        } ?? false
        return .make(item: item, now: model.attentionDate, feedback: model.responseFeedback(for: item.id),
                     queued: model.responseIsQueued(for: item.id),
                     submitting: model.respondingNotificationID == item.id, eligible: eligible)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            feedback
            if state.allowsSubmission {
                if let actions = BinaryNotificationActionPresentation(
                    behavior: InboxPresentationProjection.presentation(for: item).behavior) {
                    if typeSize.isAccessibilitySize {
                        VStack(spacing: 8) { secondary(actions); primary(actions) }
                    } else {
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 12) { secondary(actions); primary(actions) }
                            VStack(spacing: 8) { secondary(actions); primary(actions) }
                        }
                    }
                }
                if let deadline = item.interaction?.expiresAt {
                    ReloAnswerCountdown(deadline: deadline)
                }
            }
        }
        .disabled(model.respondingNotificationID != nil || model.requiresReauthentication || model.accountState == .disabled || !model.isRegistered)
        .task(id: item.id) { await verifyIfUnconfirmed() }
    }
    private var availability: CurrentActionAvailability? {
        model.currentDecision(notificationID: item.id).map { model.decisionAvailability($0.identity) }
    }
    private var deadlinePassed: Bool { (item.interaction?.expiresAt ?? .distantPast) <= model.attentionDate }
    /// Not answerable yet is not the same as gone: say why, and keep "Checking" while it is unconfirmed.
    @ViewBuilder private var unavailableReason: some View {
        if deadlinePassed {
            Label("Request expired", systemImage: "clock.badge.xmark")
        } else {
            switch availability {
            case nil, .unverified?: Label("Checking this request…", systemImage: "arrow.triangle.2.circlepath")
            case .answered?: Label("Already answered", systemImage: "checkmark.circle")
            case .replaced?: Label("Replaced by a newer request", systemImage: "arrow.uturn.forward.circle")
            case .differentAccount?: Label("Belongs to a different account", systemImage: "person.crop.circle.badge.xmark")
            default: Label("Request no longer available", systemImage: "clock.badge.xmark")
            }
        }
    }
    /// A request opened before current work loaded (say, from a push at cold launch) is confirmed once here.
    private func verifyIfUnconfirmed() async {
        guard item.interaction?.state == .pending, !deadlinePassed else { return }
        if let draft = model.currentDecision(notificationID: item.id) {
            await model.verifyCurrentDecision(draft.identity)
        } else {
            _ = await model.refresh()
        }
    }
    @ViewBuilder private var feedback: some View {
        switch state {
        case .idle: EmptyView()
        case .sending: Label("Sending…", systemImage: "arrow.up.circle")
        case .queued: Label("Waiting to send", systemImage: "clock.arrow.circlepath")
        case .accepted: Label("Response recorded", systemImage: "checkmark.circle")
        case .rejected:
            Text(model.responseFeedback(for: item.id)?.message ?? "Response not recorded. Try again.")
                .foregroundStyle(Color.reloErrorText).font(.subheadline)
        case .expired: unavailableReason
        case .resolved: Text(item.interaction?.state.rawValue.capitalized ?? "")
        }
    }
    private func secondary(_ actions: BinaryNotificationActionPresentation) -> some View {
        Button { send(actions.secondaryAction) } label: {
            Text(actions.secondaryLabel).frame(maxWidth: .infinity, minHeight: 32)
        }
            .buttonStyle(.bordered).tint(.reloInteractive)
    }
    private func primary(_ actions: BinaryNotificationActionPresentation) -> some View {
        Button { send(actions.primaryAction) } label: {
            Text(actions.primaryLabel).frame(maxWidth: .infinity, minHeight: 32)
        }
            .buttonStyle(.borderedProminent).tint(.reloActionFill)
    }
    private func send(_ action: NotificationInteractionAction) {
        guard state.allowsSubmission, model.respondingNotificationID == nil else { return }
        Task {
            NotificationResponseHaptics.decisionStarted()
            await model.respond(to: item, action: action)
            if let feedback = model.responseFeedback(for: item.id) { NotificationResponseHaptics.responseFinished(feedback.phase) }
        }
    }
}
