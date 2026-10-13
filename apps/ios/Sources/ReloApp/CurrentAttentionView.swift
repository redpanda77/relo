import ReloCore
import SwiftUI

/// Needs you, then Running, then Recent. Empty sections disappear: the hero already says
/// "All clear", so nothing repeats it below.
struct CurrentAttentionView: View {
    @Bindable var model: AppModel
    @AppStorage(ReloHistoryPreferences.clearedAtKey) private var clearedAt: Double = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let screen = model.currentPresentation
        let recent = screen.recentChanges.filter { clearedAt <= 0 || $0.updatedAt.timeIntervalSince1970 >= clearedAt }
        LazyVStack(alignment: .leading, spacing: 32) {
            status
            if !screen.needsMe.isEmpty {
                section("Needs you", count: screen.actionableCount ?? screen.needsMe.count, color: .reloSignalCoral) {
                    ForEach(screen.needsMe) { item in requestCard(item) }
                    if model.currentState?.snapshot.pending?.metadata?.hasMore == true {
                        moreButton("Show more requests", busy: model.currentState?.pendingConnection == .connecting) {
                            Task { await model.loadMorePending() }
                        }
                    }
                    if model.currentState?.pendingConnection == .offline {
                        Text("Couldn't refresh requests. Saved requests stay visible and are checked again when you reconnect.")
                            .font(.footnote).foregroundStyle(Color.reloSecondaryText)
                    }
                }
            }
            if !screen.running.isEmpty {
                // Offline, saved work may have ended since it was saved: never present it as running.
                section(isOffline ? "Last known" : "Running", count: screen.running.count, color: .reloSignalIndigo) {
                    ForEach(screen.running) { subject in runningCard(subject) }
                }
            }
            if !recent.isEmpty {
                section("Recent", count: nil, color: .reloInteractive) {
                    VStack(spacing: 0) {
                        ForEach(Array(recent.enumerated()), id: \.element.id) { index, subject in
                            if index > 0 { Divider().padding(.leading, 16) }
                            recentRow(subject)
                        }
                    }
                    .reloCard()
                }
            }
            if model.currentState?.snapshot.metadata?.hasMore == true {
                moreButton("Show more current work", busy: model.currentState?.isLoadingCurrentPage == true) {
                    Task { await model.loadMoreCurrent() }
                }
            }
        }
        .animation(reduceMotion ? nil : .smooth(duration: 0.35), value: screen.needsMe.map(\.id))
        .animation(reduceMotion ? nil : .smooth(duration: 0.35), value: screen.running.map(\.id))
    }

    // MARK: Status

    @ViewBuilder
    private var status: some View {
        let lines = statusLines
        if !lines.isEmpty || model.currentState?.persistence == .unavailable {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(lines, id: \.text) { line in
                    Label(line.text, systemImage: line.symbol)
                        .font(.footnote).foregroundStyle(Color.reloSecondaryText)
                        .symbolRenderingMode(.hierarchical)
                }
                if model.currentState?.persistence == .unavailable {
                    Label("This iPhone couldn't save current work. Unlock it and retry; fetched requests can still be reviewed.",
                          systemImage: "externaldrive.badge.exclamationmark")
                        .font(.footnote).foregroundStyle(Color.reloErrorText)
                    Button("Retry saving") { model.retryCurrentStorage() }
                        .buttonStyle(.bordered).tint(.reloInteractive).frame(minHeight: 44)
                }
            }
        }
    }

    private var isOffline: Bool { model.currentState?.connection == .offline }

    private var statusLines: [(text: String, symbol: String)] {
        var lines: [(String, String)] = []
        if model.currentState?.connection == .offline {
            lines.append(("Offline · showing saved work", "wifi.slash"))
        } else if model.currentState?.timeVerified != true {
            lines.append(("Checking current work…", "arrow.triangle.2.circlepath"))
        }
        if model.pendingResponseCount > 0 {
            let count = model.pendingResponseCount
            lines.append((count == 1 ? "1 response waiting for confirmation" : "\(count) responses waiting for confirmation",
                          "paperplane"))
        }
        return lines.map { (text: $0.0, symbol: $0.1) }
    }

    // MARK: Sections

    private func section<Content: View>(_ title: String, count: Int?, color: Color,
                                        @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title).font(.title3.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
                if let count {
                    Text(count.formatted())
                        .font(.subheadline.weight(.semibold).monospacedDigit())
                        .foregroundStyle(color)
                        .contentTransition(.numericText(value: Double(count)))
                        .accessibilityLabel("\(count)")
                }
                Spacer(minLength: 0)
            }
            content()
        }
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    private func requestCard(_ item: PendingCurrentDecision) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            // The text opens the full request; the answer buttons are right here.
            Button {
                Task { await model.openNotification(notificationID: item.notificationId) }
            } label: {
                HStack(alignment: .top, spacing: 14) {
                    ReloSignalGlyph(symbol: symbol(for: item.interaction.type), color: .reloSignalCoral, size: 40)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(item.source).font(.caption.weight(.semibold)).foregroundStyle(Color.reloSecondaryText)
                        Text(item.title).font(.headline).foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                        if !item.summary.isEmpty, item.summary != item.title {
                            Text(item.summary).font(.subheadline).foregroundStyle(.primary).lineLimit(4)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the full request")
            if let feedback = model.responseFeedback(for: item.notificationId) {
                Text(feedback.status).font(.footnote.weight(.medium)).foregroundStyle(Color.reloSecondaryText)
            } else {
                ReloAnswerCountdown(deadline: item.interaction.expiresAt)
                CurrentDecisionButtons(model: model, decision: item)
            }
        }
        .padding(16)
        .reloCard(tint: .reloSignalCoral)
    }

    @ViewBuilder
    private func runningCard(_ subject: CurrentSubjectProjection) -> some View {
        let card = VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(subject.title).font(.headline).foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if let label = CurrentInboxPresentation.freshnessLabel(for: subject, now: model.currentTime) {
                    Label(label, systemImage: "clock.badge.exclamationmark")
                        .font(.caption.weight(.semibold)).foregroundStyle(Color.reloWarning)
                } else if isOffline {
                    Label("Unconfirmed", systemImage: "wifi.slash")
                        .font(.caption.weight(.semibold)).foregroundStyle(Color.reloSecondaryText)
                } else if subject.notificationId != nil {
                    ReloChevron()
                }
            }
            if !subject.summary.isEmpty {
                Text(subject.summary).font(.subheadline).foregroundStyle(Color.reloSecondaryText).lineLimit(2)
            }
            if let progress = subject.activity?.progress, progress.isFinite {
                ReloProgressTrack(value: progress)
            }
            Label(subject.source, systemImage: "waveform.path")
                .font(.footnote).foregroundStyle(Color.reloSecondaryText)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .reloCard(tint: .reloSignalIndigo)

        if let notificationID = subject.notificationId {
            Button { Task { await model.openNotification(notificationID: notificationID) } } label: { card }
                .buttonStyle(ReloPressStyle())
                .accessibilityElement(children: .combine).accessibilityHint("Opens details")
        } else {
            card.accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private func recentRow(_ subject: CurrentSubjectProjection) -> some View {
        let row = HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(subject.title).font(.subheadline.weight(.medium)).foregroundStyle(.primary).lineLimit(2)
                HStack(spacing: 6) {
                    Text(subject.source)
                    Text("·").accessibilityHidden(true)
                    Text(subject.updatedAt.formatted(.relative(presentation: .named)))
                }
                .font(.caption).foregroundStyle(Color.reloSecondaryText).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if subject.notificationId != nil { ReloChevron() }
        }
        .padding(.horizontal, 16).padding(.vertical, 12).frame(minHeight: 52)
        .contentShape(Rectangle())

        if let notificationID = subject.notificationId {
            Button { Task { await model.openNotification(notificationID: notificationID) } } label: { row }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine).accessibilityHint("Opens details")
        } else {
            row.accessibilityElement(children: .combine)
        }
    }

    private func moreButton(_ title: String, busy: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy { ProgressView().controlSize(.small) }
                Text(title)
            }
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered).tint(.reloInteractive).disabled(busy)
    }

    private func symbol(for kind: CurrentDecision.Kind) -> String {
        switch kind {
        case .approval: "checkmark.seal.fill"
        case .yesNo: "arrow.triangle.branch"
        case .text: "text.bubble.fill"
        }
    }
}

/// Approve/Deny or Yes/No for a request in Needs you, with the sender's own button labels.
private struct CurrentDecisionButtons: View {
    @Bindable var model: AppModel
    let decision: PendingCurrentDecision

    private var actions: BinaryNotificationActionPresentation? {
        if let item = model.items.first(where: { $0.id == decision.notificationId }),
           let labelled = BinaryNotificationActionPresentation(
            behavior: InboxPresentationProjection.presentation(for: item).behavior) {
            return labelled
        }
        let kind: InboxInteraction.Kind = switch decision.interaction.type {
        case .approval: .approval
        case .yesNo: .yesNo
        case .text: .text
        }
        return BinaryNotificationActionPresentation(kind: kind, style: "standard")
    }

    var body: some View {
        if let actions, let draft = model.currentDecision(notificationID: decision.notificationId),
           model.decisionAvailability(draft.identity).permitsSubmission {
            HStack(spacing: 12) {
                Button { send(actions.secondaryAction, draft.identity) } label: {
                    Text(actions.secondaryLabel).frame(maxWidth: .infinity, minHeight: 32)
                }
                .buttonStyle(.bordered).tint(.reloInteractive)
                Button { send(actions.primaryAction, draft.identity) } label: {
                    Text(actions.primaryLabel).frame(maxWidth: .infinity, minHeight: 32)
                }
                .buttonStyle(.borderedProminent).tint(.reloActionFill)
            }
            .disabled(model.respondingNotificationID != nil)
        }
    }

    private func send(_ action: NotificationInteractionAction, _ identity: CurrentDecisionIdentity) {
        Task {
            NotificationResponseHaptics.decisionStarted()
            await model.respond(to: identity, action: action)
            if let feedback = model.responseFeedback(for: decision.notificationId) {
                NotificationResponseHaptics.responseFinished(feedback.phase)
            }
        }
    }
}
