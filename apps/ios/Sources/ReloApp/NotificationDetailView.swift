import Combine
import ReloCore
import SwiftUI
import UIKit

struct NotificationDetailView: View {
    @ObservedObject var model: AppModel
    let item: InboxItem
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @State private var reply = ""
    @State private var submittingAction: NotificationInteractionAction?
    @State private var showsIdentifiers = false
    @State private var confirmsWithdrawal = false

    private var currentItem: InboxItem {
        let selectedActivityID = item.activitySummary?.id ?? item.liveActivity?.activityId
        return ([model.selectedNotificationDetail?.item, item].compactMap { $0 }
            + model.items + model.historyItems)
            .filter { candidate in
                guard let selectedActivityID else { return candidate.id == item.id }
                return candidate.activitySummary?.id == selectedActivityID
                    || candidate.liveActivity?.activityId == selectedActivityID
            }
            .max(by: isLessPreferred) ?? item
    }

    private var palette: ActivityPresentationPalette {
        ActivityPresentationPalette(
            presentation: presentation,
            hostColorScheme: colorScheme,
            usesSystemSurfaces: true
        )
    }

    private var presentation: LiveActivityDisplayPresentation {
        InboxPresentationProjection.presentation(for: currentItem)
    }

    private var context: InboxContext? {
        currentItem.activitySummary?.context ?? currentItem.context
    }

    private var isAwaitingResponse: Bool {
        guard let interaction = currentItem.interaction else { return false }
        return interaction.state == .pending
            && interaction.expiresAt > .now
            && !model.responseIsQueued(for: currentItem.id)
            && !model.responseIsAccepted(for: currentItem.id)
    }

    private var responseFeedback: NotificationResponseFeedback? {
        model.responseFeedback(for: currentItem.id)
    }

    private var replyConfiguration: (label: String, placeholder: String, maximumLength: Int)? {
        guard case let .unsupportedTextReply(label, placeholder, maximumLength) = presentation.behavior else {
            return nil
        }
        return (
            label,
            placeholder ?? "Type a response",
            min(maximumLength, NotificationReplyPolicy.maximumUTF16CodeUnits)
        )
    }

    var body: some View {
        ZStack {
            Color.reloCanvas
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 32) {
                    notificationCard
                    messageContent
                    responseStatus
                    metadata
                    destinationAction
                    withdrawalAction
                    if !isAwaitingResponse {
                        interactionControls
                    }
                    if let error = model.interactionError {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityLabel("Response error: \(error)")
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 16)
                .padding(.bottom, isAwaitingResponse ? 40 : 56)
            }
            .scrollIndicators(.hidden)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if isAwaitingResponse {
                interactionControls
                    .padding(.horizontal, 20)
                    .padding(.top, 34)
                    .padding(.bottom, 10)
                    .background {
                        LinearGradient(
                            colors: [.clear, palette.canvas.opacity(0.9), palette.canvas],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                        .ignoresSafeArea()
                    }
            }
        }
        .navigationTitle("Notification")
        .navigationBarTitleDisplayMode(.inline)
        .tint(.reloInteractive)
        .animation(
            reduceMotion ? nil : .snappy(duration: 0.32, extraBounce: 0.04),
            value: isAwaitingResponse
        )
        .confirmationDialog(
            "Withdraw this notification?",
            isPresented: $confirmsWithdrawal,
            titleVisibility: .visible
        ) {
            Button("Withdraw notification", role: .destructive) {
                Task { await model.withdrawNotification(currentItem.id) }
            }
            Button("Keep notification", role: .cancel) {}
        } message: {
            Text("Relo will remove it from active Inbox views after synchronization while retaining an evidence record.")
        }
    }

    @ViewBuilder
    private var messageContent: some View {
        if let content = currentItem.content {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Message")
                        .font(.title3.weight(.bold))
                    Spacer()
                    Text(content.format == .markdown ? "Markdown" : "Text")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.secondaryText)
                }
                Text(content.body)
                    .font(.body)
                    .foregroundStyle(palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .accessibilityLabel("Notification message")
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }

    @ViewBuilder
    private var responseStatus: some View {
        if let feedback = responseFeedback {
            HStack(spacing: 13) {
                Image(systemName: responseStatusSymbol(feedback.phase))
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(responseStatusColor(feedback.phase))
                    .frame(width: 42, height: 42)
                    .background(responseStatusColor(feedback.phase).opacity(0.16), in: Circle())
                    .contentTransition(.symbolEffect(.replace))

                VStack(alignment: .leading, spacing: 2) {
                    Text(responseStatusTitle(feedback))
                        .font(.headline)
                        .foregroundStyle(palette.primaryText)
                    Text(responseStatusDetail(feedback.phase))
                        .font(.caption)
                        .foregroundStyle(palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(responseStatusColor(feedback.phase).opacity(0.24), lineWidth: 0.5)
            }
            .transition(
                reduceMotion
                    ? .opacity
                    : .scale(scale: 0.94, anchor: .bottom).combined(with: .opacity)
            )
            .accessibilityElement(children: .combine)
            .accessibilityHint(responseStatusHint(feedback.phase))
        }
    }

    private var notificationCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 8) {
                    Image(systemName: presentation.symbol.systemImageName)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(palette.accent)
                    Text(presentation.header ?? currentItem.sourceName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.primaryText)
                        .lineLimit(1)
                        .minimumScaleFactor(0.78)
                    Spacer(minLength: 8)
                    if currentItem.validatedDestinationURL != nil {
                        Image(systemName: "link")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(palette.accent)
                            .accessibilityLabel("Link attached")
                    }
                }

                Text(statusText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.accent)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text(presentation.title)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)

                if let subtitle = presentation.subtitle {
                    Text(subtitle)
                        .font(.body)
                        .foregroundStyle(palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if case .image = presentation.visual {
                EmptyView()
            } else if let imageURL = currentItem.validatedSourceImageURL {
                SafeNotificationImage(url: imageURL, sourceName: currentItem.sourceName)
            }

            ActivityPresentationVisual(
                presentation: presentation,
                palette: palette,
                accountID: model.credential?.accountId,
                surface: .detail
            )
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.reloSurface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var metadata: some View {
        VStack(alignment: .leading, spacing: 30) {
            if let taskTitle = context?.taskTitle {
                detailSection("Instruction") {
                    detailRow("Summary", value: taskTitle, systemImage: "text.alignleft")
                }
            }

            detailSection("Details") {
                detailRow(
                    "Date",
                    value: formatted(currentItem.createdAt),
                    systemImage: "clock"
                )
                detailRow("Type", value: currentItem.kind.displayName, systemImage: "rectangle.stack")
                detailRow("Status", value: statusText, systemImage: "waveform.path.ecg")
                detailRow(
                    "Read state",
                    value: currentItem.readAt == nil ? "Unread" : "Read",
                    systemImage: currentItem.readAt == nil ? "envelope.badge" : "envelope.open"
                )
                if let withdrawnAt = currentItem.withdrawnAt {
                    detailRow("Withdrawn", value: formatted(withdrawnAt), systemImage: "trash")
                }
                if let result = currentItem.result, result != statusText {
                    detailRow("Result", value: result, systemImage: "checkmark.circle")
                }
                if responseFeedback == nil, let interaction = currentItem.interaction {
                    detailRow(
                        "Response",
                        value: interaction.state.displayName,
                        systemImage: interaction.state == .pending ? "hourglass" : "checkmark.circle"
                    )
                }
                if let apnsAcceptedAt = currentItem.apnsAcceptedAt {
                    detailRow("Apple accepted", value: formatted(apnsAcceptedAt), systemImage: "paperplane")
                }
                if let receivedAt = currentItem.receivedAt {
                    detailRow("Received", value: formatted(receivedAt), systemImage: "iphone")
                }
                if let openedAt = currentItem.openedAt {
                    detailRow("Opened", value: formatted(openedAt), systemImage: "envelope.open")
                }
            }

            detailSection("Origin") {
                detailRow("Source", value: currentItem.sourceName, systemImage: "dot.radiowaves.left.and.right")
                if let providerName = context?.providerName {
                    detailRow("Provider", value: providerName, systemImage: "cpu")
                }
                if let producerKind = context?.producerKind {
                    detailRow("Origin", value: humanized(producerKind), systemImage: "arrow.turn.up.right")
                }
                if let computer = context?.computer {
                    detailRow("Computer", value: computer, systemImage: "desktopcomputer")
                }
                if let project = context?.project {
                    detailRow("Project", value: project, systemImage: "folder")
                }
                if let threadName = context?.threadName {
                    detailRow("Thread", value: threadName, systemImage: "bubble.left.and.bubble.right")
                }
            }

            if currentItem.liveActivity != nil || currentItem.activitySummary != nil {
                detailSection("Activity") {
                    if let activity = currentItem.liveActivity {
                        detailRow(
                            "Event",
                            value: operationLabel(activity.operation),
                            systemImage: activity.operation == .end ? "checkmark.circle" : "waveform.path.ecg"
                        )
                        detailRow(
                            "Version",
                            value: "Update \(activity.sequence ?? 0) · Generation \(activity.generation)",
                            systemImage: "arrow.triangle.2.circlepath"
                        )
                    }
                    if let summary = currentItem.activitySummary {
                        detailRow(
                            "State",
                            value: humanized(summary.state),
                            systemImage: summary.state == "active" ? "bolt.horizontal.circle" : "checkmark.circle"
                        )
                        detailRow(
                            "Canonical version",
                            value: "Sequence \(summary.sequence) · Generation \(summary.generation)",
                            systemImage: "point.3.connected.trianglepath.dotted"
                        )
                        if let reason = summary.terminalReason {
                            detailRow("End reason", value: humanized(reason), systemImage: "info.circle")
                        }
                        if let createdAt = summary.createdAt {
                            detailRow("Started", value: formatted(createdAt), systemImage: "play.circle")
                        }
                        if let updatedAt = summary.updatedAt {
                            detailRow("Updated", value: formatted(updatedAt), systemImage: "clock.arrow.circlepath")
                        }
                        if let endedAt = summary.endedAt {
                            detailRow("Ended", value: formatted(endedAt), systemImage: "stop.circle")
                        }
                        if let staleAt = summary.staleAt {
                            detailRow("Stale after", value: formatted(staleAt), systemImage: "clock.badge.exclamationmark")
                        }
                        if let expiresAt = summary.expiresAt {
                            detailRow("Expires", value: formatted(expiresAt), systemImage: "calendar.badge.clock")
                        }
                    }
                }
            }

            if let evidence = model.selectedNotificationDetail?.evidence {
                detailSection("Evidence") {
                    if evidence.timeline.isEmpty {
                        detailRow(
                            "Delivery attempts",
                            value: String(evidence.deliveries.count),
                            systemImage: "paperplane"
                        )
                        if let latest = evidence.deliveries.last {
                            detailRow(
                                "Latest delivery",
                                value: humanized(latest.state),
                                systemImage: latest.acceptedAt == nil
                                    ? "clock.arrow.circlepath"
                                    : "checkmark.circle"
                            )
                        }
                        if !evidence.interactions.isEmpty {
                            detailRow(
                                "Device receipts",
                                value: String(evidence.interactions.count),
                                systemImage: "iphone"
                            )
                        }
                        if let withdrawal = evidence.withdrawals.last {
                            detailRow(
                                "Withdrawal",
                                value: humanized(withdrawal.outcome),
                                systemImage: "trash"
                            )
                        }
                    } else {
                        ForEach(evidence.timeline) { stage in
                            detailRow(
                                humanized(stage.stage),
                                value: "\(humanized(stage.state)) · \(formatted(stage.occurredAt))",
                                systemImage: evidenceSystemImage(stage.stage)
                            )
                        }
                    }
                }
            }

            DisclosureGroup(isExpanded: $showsIdentifiers) {
                VStack(alignment: .leading, spacing: 15) {
                    detailRow("Notification", value: currentItem.id, systemImage: "number")
                    if let activityID = currentItem.activitySummary?.id ?? currentItem.liveActivity?.activityId {
                        detailRow("Activity", value: activityID, systemImage: "waveform.path.ecg")
                    }
                    if let originThreadID = currentItem.activitySummary?.originThreadId {
                        detailRow("Relo correlation", value: originThreadID, systemImage: "point.3.connected.trianglepath.dotted")
                    }
                    if let conversationID = currentItem.activitySummary?.conversationId {
                        detailRow("Conversation", value: conversationID, systemImage: "bubble.left.and.bubble.right")
                    }
                    if let workItemID = currentItem.activitySummary?.workItemId {
                        detailRow("Work item", value: workItemID, systemImage: "list.number")
                    }
                    if let providerThreadID = context?.providerThreadId {
                        detailRow("Provider task", value: providerThreadID, systemImage: "number.square")
                    }
                    if let providerWorkItemID = context?.providerWorkItemId {
                        detailRow("Provider instruction", value: providerWorkItemID, systemImage: "list.number")
                    }
                }
                .padding(.top, 14)
            } label: {
                Label("Technical identifiers", systemImage: "number.square")
                    .font(.headline)
            }
            .tint(.reloInteractive)
            .accessibilityValue(showsIdentifiers ? "Expanded" : "Collapsed")
        }
    }

    private func detailSection<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Rectangle()
                .fill(Color.primary.opacity(0.12))
                .frame(height: 0.5)
            Text(title)
                .font(.title3.weight(.bold))
                .foregroundStyle(.primary)
            VStack(alignment: .leading, spacing: 15) {
                content()
            }
        }
    }

    private func detailRow(_ label: String, value: String, systemImage: String) -> some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: systemImage)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.reloInteractive)
                .frame(width: 20, alignment: .center)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }

    private func formatted(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .standard)
    }

    private func humanized(_ value: String) -> String {
        value.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private func evidenceSystemImage(_ stage: String) -> String {
        switch stage {
        case "accepted", "canonicalized": "checkmark.seal"
        case "queued": "tray"
        case "attempted": "paperplane"
        case "provider_accepted": "checkmark.circle"
        case "provider_rejected": "xmark.circle"
        case "provider_ambiguous": "questionmark.circle"
        case "device_applied": "waveform.path.ecg"
        case "device_received": "iphone"
        case "opened": "envelope.open"
        case "responded": "bubble.left.and.text.bubble.right"
        case "withdrawn": "trash"
        case "reconciled": "arrow.triangle.2.circlepath"
        default: "circle.dotted"
        }
    }

    @ViewBuilder
    private var destinationAction: some View {
        if let destination = currentItem.validatedDestinationURL {
            Link(destination: destination) {
                Label("Open attached link", systemImage: "arrow.up.right.square")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .tint(.reloInteractive)
        }
    }

    @ViewBuilder
    private var withdrawalAction: some View {
        if model.canWithdraw(currentItem) {
            Button(role: .destructive) {
                confirmsWithdrawal = true
            } label: {
                HStack(spacing: 8) {
                    if model.withdrawingNotificationID == currentItem.id {
                        ProgressView().controlSize(.small)
                    }
                    Label("Withdraw notification", systemImage: "trash")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(model.withdrawingNotificationID != nil)
        }
    }

    @ViewBuilder
    private var interactionControls: some View {
        if let interaction = currentItem.interaction {
            if interaction.state == .pending
                && interaction.expiresAt > .now
                && !model.responseIsQueued(for: currentItem.id)
                && !model.responseIsAccepted(for: currentItem.id) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Your response")
                        .font(.headline)
                    if let actions = BinaryNotificationActionPresentation(behavior: presentation.behavior) {
                        binaryButtons(
                            primary: actions.primaryLabel,
                            primaryAction: actions.primaryAction,
                            secondary: actions.secondaryLabel,
                            secondaryAction: actions.secondaryAction
                        )
                    } else if let replyConfiguration {
                        TextField(replyConfiguration.placeholder, text: $reply, axis: .vertical)
                            .textFieldStyle(.plain)
                            .padding(14)
                            .background(palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: 14, style: .continuous)
                                    .stroke(palette.primaryText.opacity(0.14), lineWidth: 0.5)
                            }
                            .lineLimit(3...6)
                        Text("\(NotificationReplyPolicy.utf16Count(reply))/\(replyConfiguration.maximumLength)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(replyIsValid ? palette.secondaryText : Color.red)
                            .accessibilityLabel("Response character count")
                        Button(replyConfiguration.label) {
                            guard let response = NotificationReplyPolicy.normalized(reply),
                                  replyIsValid
                            else { return }
                            submit(.answer, text: response)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(palette.accent)
                        .disabled(
                            model.respondingNotificationID == currentItem.id
                                || !replyIsValid
                        )
                    }
                    Text("Expires \(interaction.expiresAt.formatted(date: .omitted, time: .shortened))")
                        .font(.caption)
                        .foregroundStyle(palette.secondaryText)
                }
            } else if interaction.state == .pending && interaction.expiresAt <= .now {
                Label("Response window expired", systemImage: "clock.badge.xmark")
                    .font(.headline)
                    .foregroundStyle(palette.secondaryText)
            } else if !model.responseIsQueued(for: currentItem.id)
                && !model.responseIsAccepted(for: currentItem.id) {
                Label(
                    "Response: \(interaction.state.displayName)",
                    systemImage: terminalResponseSymbol(interaction.state)
                )
                    .font(.headline)
                    .foregroundStyle(terminalResponseColor(interaction.state))
            }
        }
    }

    private func binaryButtons(
        primary: String,
        primaryAction: NotificationInteractionAction,
        secondary: String,
        secondaryAction: NotificationInteractionAction
    ) -> some View {
        HStack(spacing: 10) {
            let secondaryIsLoading = model.respondingNotificationID == currentItem.id
                && submittingAction == secondaryAction
            let primaryIsLoading = model.respondingNotificationID == currentItem.id
                && submittingAction == primaryAction
            Button {
                submit(secondaryAction)
            } label: {
                responseButtonLabel(secondary, action: secondaryAction)
            }
            .buttonStyle(DetailDecisionButtonStyle(
                emphasized: false,
                accent: palette.accent,
                primaryText: palette.primaryText,
                isLoading: secondaryIsLoading
            ))
            Button {
                submit(primaryAction)
            } label: {
                responseButtonLabel(primary, action: primaryAction)
            }
            .buttonStyle(DetailDecisionButtonStyle(
                emphasized: true,
                accent: palette.accent,
                primaryText: palette.primaryText,
                isLoading: primaryIsLoading
            ))
        }
        .disabled(model.respondingNotificationID == currentItem.id)
    }

    @ViewBuilder
    private func responseButtonLabel(
        _ label: String,
        action: NotificationInteractionAction
    ) -> some View {
        HStack(spacing: 7) {
            if model.respondingNotificationID == currentItem.id && submittingAction == action {
                ProgressView().controlSize(.small)
                Text(responseInFlightLabel(for: action))
                    .contentTransition(.opacity)
            } else {
                Text(label)
                    .contentTransition(.opacity)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func responseInFlightLabel(for action: NotificationInteractionAction) -> String {
        switch action {
        case .approve: "Approving…"
        case .deny: "Denying…"
        case .yes: "Sending yes…"
        case .no: "Sending no…"
        case .answer: "Sending…"
        case .opened, .received: "Sending…"
        }
    }

    private func submit(_ action: NotificationInteractionAction, text: String? = nil) {
        guard submittingAction == nil else { return }
        NotificationResponseHaptics.decisionStarted()
        submittingAction = action
        Task {
            await model.respond(to: currentItem, action: action, text: text)
            if let phase = model.responseFeedback(for: currentItem.id)?.phase {
                NotificationResponseHaptics.responseFinished(phase)
            }
            submittingAction = nil
        }
    }

    private func terminalResponseSymbol(_ state: InboxInteraction.State) -> String {
        switch state {
        case .pending: "clock.arrow.circlepath"
        case .expired, .canceled: "xmark.circle.fill"
        default: "checkmark.circle.fill"
        }
    }

    private func terminalResponseColor(_ state: InboxInteraction.State) -> Color {
        switch state {
        case .pending: .orange
        case .expired, .canceled: .secondary
        default: palette.accent
        }
    }

    private func responseStatusSymbol(_ phase: NotificationResponsePhase) -> String {
        switch phase {
        case .sending: "arrow.up.circle.fill"
        case .queued: "clock.arrow.circlepath"
        case .accepted: "checkmark.circle.fill"
        case .rejected: "exclamationmark.triangle.fill"
        }
    }

    private func responseStatusColor(_ phase: NotificationResponsePhase) -> Color {
        switch phase {
        case .sending, .queued, .accepted: palette.accent
        case .rejected: .red
        }
    }

    private func responseStatusDetail(_ phase: NotificationResponsePhase) -> String {
        switch phase {
        case .sending: "Sending securely to Relo server"
        case .queued: "Saved on this iPhone while Relo server confirms it"
        case .accepted: "Relo server confirmed and recorded your response"
        case .rejected: "Nothing was recorded. You can try again"
        }
    }

    private func responseStatusTitle(_ feedback: NotificationResponseFeedback) -> String {
        feedback.phase == .rejected ? "Response not recorded" : feedback.status
    }

    private func responseStatusHint(_ phase: NotificationResponsePhase) -> String {
        switch phase {
        case .sending: "Relo is sending the response to Relo server"
        case .queued: "The response is protected on this iPhone and is not complete until Relo server confirms it"
        case .accepted: "Relo server authenticated and recorded this response"
        case .rejected: "Nothing was assumed; the response can be retried"
        }
    }

    private var statusText: String {
        if let feedback = responseFeedback {
            return feedback.status
        }
        if let interaction = currentItem.interaction {
            switch interaction.kind {
            case .approval:
                return interaction.state == .pending ? "Approval needed" : interaction.state.displayName
            case .yesNo:
                return interaction.state == .pending ? "Response needed" : interaction.state.displayName
            case .text:
                break
            }
        }
        return presentation.status
    }

    private var replyIsValid: Bool {
        guard let replyConfiguration else { return false }
        return NotificationReplyPolicy.isValid(reply)
            && NotificationReplyPolicy.utf16Count(reply) <= replyConfiguration.maximumLength
    }

    private func isLessPreferred(_ left: InboxItem, _ right: InboxItem) -> Bool {
        let leftSequence = left.activitySummary?.sequence ?? left.liveActivity?.sequence ?? -1
        let rightSequence = right.activitySummary?.sequence ?? right.liveActivity?.sequence ?? -1
        if leftSequence != rightSequence { return leftSequence < rightSequence }
        let leftRichness = richness(of: left)
        let rightRichness = richness(of: right)
        if leftRichness != rightRichness { return leftRichness < rightRichness }
        return left.createdAt < right.createdAt
    }

    private func richness(of candidate: InboxItem) -> Int {
        let context = candidate.activitySummary?.context ?? candidate.context
        return [
            candidate.detail,
            candidate.result,
            candidate.activitySummary?.detail,
            candidate.activitySummary?.terminalReason,
            context?.providerName,
            context?.computer,
            context?.project,
            context?.threadName,
            context?.taskTitle,
        ].compactMap { $0 }.count
    }

    private func operationLabel(_ operation: LiveActivityCommand.Operation) -> String {
        switch operation {
        case .start: "Activity started"
        case .update: "Activity updated"
        case .end: "Activity ended"
        }
    }
}

struct ActivityPresentationPalette {
    let accent: Color
    let secondary: Color
    let primaryText: Color
    let secondaryText: Color
    let canvas: Color
    let surface: Color

    init(item: InboxItem) {
        self.init(presentation: InboxPresentationProjection.presentation(for: item))
    }

    init(
        presentation: LiveActivityDisplayPresentation,
        hostColorScheme: ColorScheme = .dark,
        usesSystemSurfaces: Bool = false
    ) {
        let resolvedAccent = Color.presentationHex(presentation.accentColor) ?? .mint
        let usesLightCanvas = switch presentation.theme {
        case .light: true
        case .dark: false
        case .system: hostColorScheme == .light
        }
        accent = resolvedAccent
        secondary = presentation.secondaryColor.flatMap(Color.presentationHex)
            ?? resolvedAccent.opacity(0.58)
        if usesSystemSurfaces {
            primaryText = .primary
            secondaryText = .secondary
            canvas = Color(uiColor: .secondarySystemBackground)
            surface = Color(uiColor: .tertiarySystemBackground)
            return
        }
        primaryText = usesLightCanvas ? .black.opacity(0.88) : .white
        secondaryText = primaryText.opacity(0.68)
        canvas = usesLightCanvas
            ? Color(red: 0.96, green: 0.95, blue: 0.93)
            : .detailBackground
        surface = primaryText.opacity(usesLightCanvas ? 0.055 : 0.1)
    }
}

enum ActivityPresentationVisualSurface {
    case detail
    case row
}

struct ActivityPresentationVisual: View {
    let presentation: LiveActivityDisplayPresentation
    let palette: ActivityPresentationPalette
    let accountID: String?
    let surface: ActivityPresentationVisualSurface
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @ViewBuilder
    var body: some View {
        switch presentation.visual {
        case .none:
            EmptyView()
        case let .progressBar(value, label):
            VStack(alignment: .leading, spacing: 7) {
                progressHeading(value: value, label: label)
                ProgressView(value: value)
                    .tint(palette.accent)
            }
            .animation(reduceMotion ? nil : .snappy(duration: 0.28), value: value)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label ?? "Progress")
            .accessibilityValue("\(Int((value * 100).rounded())) percent")
        case let .steps(items):
            VStack(alignment: .leading, spacing: surface == .detail ? 9 : 6) {
                HStack(spacing: 6) {
                    ForEach(items) { item in
                        Capsule()
                            .fill(item.state == .pending ? palette.primaryText.opacity(0.14) : palette.accent)
                            .frame(height: surface == .detail ? 8 : 5)
                    }
                }
                if surface == .detail, let active = items.first(where: { $0.state == .current }) {
                    Text(active.label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.secondaryText)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Progress")
            .accessibilityValue(stepsAccessibilityValue(items))
        case let .image(reference):
            if let image = ImmutablePresentationAssetCache.image(for: reference, accountID: accountID) {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: reference.contentMode == .fill ? .fill : .fit)
                    .frame(
                        maxWidth: .infinity,
                        minHeight: surface == .detail ? 140 : 56,
                        maxHeight: surface == .detail ? 260 : 96
                    )
                    .clipShape(RoundedRectangle(cornerRadius: surface == .detail ? 18 : 10, style: .continuous))
                    .accessibilityLabel(reference.altText)
            } else {
                Label("Image unavailable", systemImage: "photo.badge.exclamationmark")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(palette.secondaryText)
            }
        }
    }

    private func progressHeading(value: Double, label: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label ?? "Progress")
                .font(surface == .detail ? .caption.weight(.semibold) : .caption2.weight(.semibold))
                .foregroundStyle(palette.secondaryText)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(value, format: .percent.precision(.fractionLength(0)))
                .font(surface == .detail ? .title3.weight(.bold) : .caption.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(palette.primaryText)
                .contentTransition(.numericText(value: value))
        }
    }

    private func stepsAccessibilityValue(_ items: [LiveActivityDisplayPresentation.Step]) -> String {
        guard !items.isEmpty else { return "No steps" }
        let completed = items.filter { $0.state == .complete }.count
        return "\(completed) of \(items.count) complete"
    }
}

struct ActivityPresentationBackdrop: View {
    let palette: ActivityPresentationPalette

    var body: some View {
        ZStack {
            palette.canvas
            LinearGradient(
                colors: [palette.accent.opacity(0.42), palette.secondary.opacity(0.2), palette.canvas.opacity(0.96)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            RadialGradient(
                colors: [palette.secondary.opacity(0.34), .clear],
                center: .bottomTrailing,
                startRadius: 0,
                endRadius: 420
            )
        }
    }
}

private struct DetailDecisionButtonStyle: ButtonStyle {
    let emphasized: Bool
    let accent: Color
    let primaryText: Color
    let isLoading: Bool
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(emphasized ? Color.black.opacity(0.78) : primaryText)
            .frame(maxWidth: .infinity, minHeight: 54)
            .background(
                emphasized ? accent : primaryText.opacity(0.11),
                in: Capsule()
            )
            .overlay {
                if !emphasized {
                    Capsule().stroke(primaryText.opacity(0.16), lineWidth: 0.5)
                }
            }
            .opacity(isLoading ? 1 : isEnabled ? (configuration.isPressed ? 0.78 : 1) : 0.36)
            .scaleEffect(isLoading ? 0.985 : configuration.isPressed ? 0.96 : 1)
            .shadow(
                color: emphasized && isEnabled ? accent.opacity(configuration.isPressed ? 0.12 : 0.22) : .clear,
                radius: configuration.isPressed ? 5 : 12,
                y: configuration.isPressed ? 2 : 7
            )
            .animation(
                reduceMotion ? nil : .snappy(duration: 0.2, extraBounce: 0.05),
                value: configuration.isPressed
            )
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.18),
                value: isLoading
            )
    }
}

@MainActor
enum NotificationResponseHaptics {
    static func decisionStarted() {
        let generator = UIImpactFeedbackGenerator(style: .medium)
        generator.prepare()
        generator.impactOccurred(intensity: 0.82)
    }

    static func responseFinished(_ phase: NotificationResponsePhase) {
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        switch phase {
        case .accepted: generator.notificationOccurred(.success)
        case .queued: generator.notificationOccurred(.warning)
        case .rejected: generator.notificationOccurred(.error)
        case .sending: break
        }
    }
}

private struct SafeNotificationImage: View {
    let url: URL
    let sourceName: String
    @StateObject private var loader = SafeNotificationImageLoader()

    var body: some View {
        Group {
            if let image = loader.image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if loader.failed {
                Label("Image unavailable", systemImage: "photo.badge.exclamationmark")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.white.opacity(0.7))
            } else {
                ProgressView().tint(.white)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 120, maxHeight: 240)
        .background(.white.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityLabel("Notification image from \(sourceName)")
        .task(id: url) { await loader.load(url: url, maximumBytes: 10 * 1_024 * 1_024) }
    }
}

struct SafeNotificationAvatar: View {
    let url: URL
    let sourceName: String
    let fallback: AnyView
    @StateObject private var loader = SafeNotificationImageLoader()

    var body: some View {
        Group {
            if let image = loader.image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                fallback
            }
        }
        .accessibilityLabel("Source image for \(sourceName)")
        .task(id: url) { await loader.load(url: url, maximumBytes: 2 * 1_024 * 1_024) }
    }
}

@MainActor
private final class SafeNotificationImageLoader: ObservableObject {
    @Published private(set) var image: UIImage?
    @Published private(set) var failed = false

    func load(url: URL, maximumBytes: Int64) async {
        guard NotificationImagePolicy.validatedURL(url) != nil else {
            failed = true
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        let session = URLSession(
            configuration: configuration,
            delegate: NotificationImageRedirectDelegate(),
            delegateQueue: nil
        )
        defer { session.invalidateAndCancel() }

        do {
            let (temporaryURL, response) = try await session.download(for: request)
            guard
                !Task.isCancelled,
                let http = response as? HTTPURLResponse,
                (200..<300).contains(http.statusCode),
                let finalURL = response.url,
                NotificationImagePolicy.validatedURL(finalURL) != nil
            else { throw URLError(.badServerResponse) }
            let size = Int64(try temporaryURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
            guard
                size > 0,
                size <= maximumBytes,
                response.expectedContentLength <= 0 || response.expectedContentLength <= maximumBytes,
                let decoded = UIImage(data: try Data(contentsOf: temporaryURL))
            else { throw URLError(.dataLengthExceedsMaximum) }
            image = decoded
            failed = false
        } catch {
            guard !Task.isCancelled else { return }
            image = nil
            failed = true
        }
    }
}

private final class NotificationImageRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        guard let url = request.url, NotificationImagePolicy.validatedURL(url) != nil else { return nil }
        return request
    }
}

private extension InboxInteraction.State {
    var displayName: String {
        switch self {
        case .pending: "Pending"
        case .approved: "Approved"
        case .denied: "Denied"
        case .yes: "Yes"
        case .no: "No"
        case .replied: "Replied"
        case .expired: "Expired"
        case .canceled: "Canceled"
        }
    }
}

extension InboxItem.Kind {
    var displayName: String {
        switch self {
        case .notification: "Notification"
        case .liveActivity: "Live Activity"
        case .response: "Response"
        }
    }
}

private extension Color {
    static func presentationHex(_ value: String) -> Color? {
        guard value.range(of: #"^#[0-9A-F]{6}$"#, options: .regularExpression) != nil,
              let rgb = UInt64(value.dropFirst(), radix: 16) else { return nil }
        return Color(
            red: Double((rgb >> 16) & 0xff) / 255,
            green: Double((rgb >> 8) & 0xff) / 255,
            blue: Double(rgb & 0xff) / 255
        )
    }

    static let detailBackground = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.04, green: 0.05, blue: 0.06, alpha: 1)
            : UIColor(red: 0.96, green: 0.95, blue: 0.93, alpha: 1)
    })
}
