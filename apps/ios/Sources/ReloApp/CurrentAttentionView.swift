import ReloCore
import SwiftUI

/// Needs you, Live now, then Today. One rhythm: a small monospaced caption in the section's
/// meaning color, 28pt between sections. Empty sections disappear.
struct CurrentAttentionView: View {
    @Bindable var model: AppModel
    var viewHistory: () -> Void = {}
    @AppStorage(ReloHistoryPreferences.clearedAtKey) private var clearedAt: Double = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let screen = model.currentPresentation
        let recent = screen.recentChanges.filter { clearedAt <= 0 || $0.updatedAt.timeIntervalSince1970 >= clearedAt }
        let cards = LiveNowProjection.make(history: model.historyItems, subjects: screen.running,
                                         sessions: isOffline ? [] : model.agentSessions,
                                         sessionsFetchedAt: model.agentSessionsFetchedAt, now: model.attentionDate)
        let allClear = screen.needsMe.isEmpty && cards.isEmpty
        let activity = todayActivity
        LazyVStack(alignment: .leading, spacing: 28) {
            persistenceWarning
            if !screen.needsMe.isEmpty {
                section("Needs you", count: screen.actionableCount ?? screen.needsMe.count, color: ReloHoloTheme.color(.needsYou)) {
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
            if !cards.isEmpty {
                // Offline, saved work may have ended since it was saved: never present it as running.
                section(isOffline ? "Last known" : "Live now", count: cards.count, color: ReloHoloTheme.color(.running)) {
                    ForEach(cards) { card in liveCard(card) }
                }
            }
            agentsSection(cards: cards)
            NowAllClearView(activity: activity, allClear: allClear,
                            openItem: { id in Task { await model.openNotification(notificationID: id) } },
                            viewHistory: viewHistory)
                .transition(.opacity)
            if !recent.isEmpty, activity.isEmpty {
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
        .animation(reduceMotion ? nil : .smooth(duration: 0.35), value: cards.map(\.id))
    }

    // MARK: Persistence

    @ViewBuilder
    private var persistenceWarning: some View {
        if model.currentState?.persistence == .unavailable {
            VStack(spacing: 10) {
                Label("This iPhone couldn't save current work. Unlock it and retry; fetched requests can still be reviewed.",
                      systemImage: "externaldrive.badge.exclamationmark")
                    .font(.footnote).foregroundStyle(Color.reloErrorText)
                Button("Retry saving") { model.retryCurrentStorage() }
                    .buttonStyle(.bordered).tint(.reloInteractive).frame(minHeight: 44)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private var todayActivity: TodayActivity {
        let items = InboxHistoryProjection.collapsedActivities(
            model.historyItems.filter { clearedAt <= 0 || $0.createdAt.timeIntervalSince1970 >= clearedAt })
        let rows = HistoryRowProjection.rows(items, events: model.historyItems, now: model.attentionDate)
            .filter { $0.outcome != .running && $0.outcome != .waitingForYou }
        return .make(rows: rows, now: model.attentionDate)
    }

    private var isOffline: Bool { model.currentState?.connection == .offline }

    // MARK: Sections

    private func section<Content: View>(_ title: String, count: Int?, color: Color,
                                        @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            NowSectionCaption(title: title, count: count, color: color)
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
                    ReloSignalGlyph(symbol: symbol(for: item.interaction.type), color: ReloHoloTheme.color(.needsYou), size: 40)
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
        .reloCard(tint: ReloHoloTheme.color(.needsYou))
    }

    @ViewBuilder
    private func liveCard(_ card: LiveNowProjection.Card) -> some View {
        let quiet = isOffline ? nil : card.quietFor(now: model.attentionDate)
        let agentQuiet = isOffline ? nil : card.agentQuietPhrase(now: model.attentionDate)
        let tone = ReloHoloTheme.color(quiet == nil && agentQuiet == nil ? .running : .attention)
        let body = VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(card.title).font(.headline).foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if agentQuiet != nil {
                    EmptyView()
                } else if let quiet {
                    Text("QUIET \(LiveNowProjection.Card.quietLabel(quiet))")
                        .font(.system(.caption2, design: .monospaced).weight(.semibold)).tracking(1.0)
                        .foregroundStyle(tone)
                } else if isOffline {
                    Label("Unconfirmed", systemImage: "wifi.slash")
                        .font(.caption.weight(.semibold)).foregroundStyle(Color.reloSecondaryText)
                } else if card.notificationID != nil {
                    ReloChevron()
                }
            }
            if let agentQuiet {
                Text(agentQuiet).font(.subheadline.weight(.medium)).foregroundStyle(tone).lineLimit(2)
            }
            if let status = card.status, !status.isEmpty {
                Text(status).font(.subheadline).foregroundStyle(Color.reloSecondaryText).lineLimit(2)
            }
            if let steps = card.row?.steps, let row = card.row {
                LiveStepsBar(steps: steps, color: tone, outcome: row.outcome, shimmer: quiet == nil && agentQuiet == nil && !isOffline)
            } else if let progress = card.progress, progress.isFinite {
                LiveProgressBar(value: progress, color: tone, shimmer: quiet == nil && agentQuiet == nil && !isOffline)
            }
            origin(card)
            HStack(spacing: 6) {
                if let startedAt = card.startedAt, startedAt <= model.attentionDate.addingTimeInterval(60) {
                    // The system ticks this timer; the card does not redraw once a second.
                    HStack(spacing: 4) {
                        Text("running")
                        Text(timerInterval: startedAt...Date.distantFuture, countsDown: false)
                            .monospacedDigit().multilineTextAlignment(.leading)
                            .frame(maxWidth: 64, alignment: .leading)
                    }
                    .fixedSize()
                    Text("·").accessibilityHidden(true)
                }
                Text("updated \(card.updatedAt.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated)))")
            }
            .font(.system(.caption2, design: .monospaced)).foregroundStyle(Color.reloSecondaryText.opacity(0.85))
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .reloCard()

        if let notificationID = card.notificationID {
            Button { Task { await model.openNotification(notificationID: notificationID) } } label: { body }
                .buttonStyle(ReloPressStyle())
                .accessibilityElement(children: .combine).accessibilityHint("Opens details")
        } else {
            body.accessibilityElement(children: .combine)
        }
    }

    // MARK: Agents

    @ViewBuilder
    private func agentsSection(cards: [LiveNowProjection.Card]) -> some View {
        let now = model.attentionDate
        let groups = isOffline ? [] : AgentSessionsProjection.groups(model.agentSessions, now: now)
        if !groups.isEmpty {
            // Counts the agents running now; idle ones (waiting for you), ended and lost still list.
            let count = AgentSessionsProjection.runningCount(groups.flatMap(\.sessions))
            section("Agents", count: count, color: ReloHoloTheme.agents) {
                ForEach(groups) { group in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(group.title).font(.system(.caption2, design: .monospaced).weight(.medium)).tracking(1.0)
                            .foregroundStyle(Color.reloSecondaryText).textCase(.uppercase)
                        VStack(spacing: 0) {
                            ForEach(Array(group.sessions.enumerated()), id: \.element.id) { index, session in
                                if index > 0 { Divider().padding(.leading, 16) }
                                agentRow(session, now: now, cards: cards)
                            }
                        }
                        .reloCard()
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func agentRow(_ session: AgentSession, now: Date, cards: [LiveNowProjection.Card]) -> some View {
        let live = AgentSessionsProjection.isRunning(session)
        let notificationID = (session.presence == .working || session.presence == .quiet)
            ? cards.first(where: { $0.id == session.card?.id })?.notificationID : nil
        let row = HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text([AgentSessionsProjection.harnessName(session.harness), session.project]
                    .compactMap { $0 }.joined(separator: " · "))
                    .font(.subheadline.weight(.medium)).foregroundStyle(.primary).lineLimit(1)
                agentChip(session, now: now)
                if live {
                    HStack(spacing: 4) {
                        Text("running")
                        Text(timerInterval: session.startedAt...Date.distantFuture, countsDown: false)
                            .monospacedDigit().multilineTextAlignment(.leading)
                            .frame(maxWidth: 64, alignment: .leading)
                    }
                    .fixedSize()
                    .font(.system(.caption2, design: .monospaced)).foregroundStyle(Color.reloSecondaryText.opacity(0.85))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if notificationID != nil { ReloChevron() }
        }
        .padding(.horizontal, 16).padding(.vertical, 12).frame(minHeight: 52)
        .contentShape(Rectangle())

        if let notificationID {
            Button { Task { await model.openNotification(notificationID: notificationID) } } label: { row }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine).accessibilityHint("Opens details")
        } else {
            row.accessibilityElement(children: .combine)
        }
    }

    private func agentChip(_ session: AgentSession, now: Date) -> some View {
        let text = AgentSessionsProjection.statusPhrase(session, fetchedAt: model.agentSessionsFetchedAt, now: now)
        let color: Color = switch session.presence {
        case _ where AgentSessionsProjection.isIdle(session): Color.reloSecondaryText
        case .working: ReloHoloTheme.color(.running)
        case .quiet: ReloHoloTheme.color(.attention)
        case .noCard, .ended: Color.reloSecondaryText
        case .lost: ReloHoloTheme.color(.failed)
        }
        return HStack(spacing: 6) {
            Circle().fill(color).frame(width: 6, height: 6).accessibilityHidden(true)
            Text(text).font(.caption.weight(.medium)).foregroundStyle(color).lineLimit(1)
        }
    }

    /// Source · project › topic.
    private func origin(_ card: LiveNowProjection.Card) -> some View {
        var parts: [String] = []
        if let row = card.row {
            parts.append(row.source.name)
            if let project = row.project?.name { parts.append(project) }
            let line = parts.joined(separator: " · ")
            return Text(row.topic.map { "\(line) › \($0)" } ?? line)
                .font(.footnote).foregroundStyle(Color.reloSecondaryText).lineLimit(1)
        }
        return Text(card.subject?.source ?? "")
            .font(.footnote).foregroundStyle(Color.reloSecondaryText).lineLimit(1)
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
        case .choice: "list.bullet.circle.fill"
        }
    }
}

/// Approve/Deny, Yes/No or a choice's options for a request in Needs you, with the sender's own labels.
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
        case .choice: .choice
        }
        return BinaryNotificationActionPresentation(kind: kind, style: "standard")
    }

    var body: some View {
        if decision.interaction.type == .choice, let options = decision.interaction.options,
           let draft = model.currentDecision(notificationID: decision.notificationId),
           model.decisionAvailability(draft.identity).permitsSubmission {
            ChoiceOptionButtons(options: options) { send(.choose, draft.identity, optionID: $0.id) }
                .disabled(model.respondingNotificationID != nil)
        } else if let actions, let draft = model.currentDecision(notificationID: decision.notificationId),
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

    private func send(_ action: NotificationInteractionAction, _ identity: CurrentDecisionIdentity, optionID: String? = nil) {
        Task {
            NotificationResponseHaptics.decisionStarted()
            await model.respond(to: identity, action: action, optionID: optionID)
            if let feedback = model.responseFeedback(for: decision.notificationId) {
                NotificationResponseHaptics.responseFinished(feedback.phase)
            }
        }
    }
}

/// The sweep of light used on live meters. It is a mask, not an overlay: it is drawn only
/// inside the shape it decorates (the filled part of a bar), so it never shows as a band over
/// the track or the label. It moves by sliding the gradient's start and end points.
private struct LiveSweep: View {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if active && !reduceMotion {
            // The shared clock: paused off screen, in Low Power Mode and when the device is hot.
            ReloMotionClock(framesPerSecond: 24, still: 0) { time in
                let cycle = 2.8
                // Travels from just before the left edge to just past the right, then rests.
                let phase = min(time.truncatingRemainder(dividingBy: cycle) / (cycle * 0.7), 1) * 1.6 - 0.3
                LinearGradient(stops: [.init(color: .clear, location: 0),
                                       .init(color: .white.opacity(0.55), location: 0.5),
                                       .init(color: .clear, location: 1)],
                               startPoint: UnitPoint(x: phase - 0.18, y: 0.5),
                               endPoint: UnitPoint(x: phase + 0.18, y: 0.5))
                    .blendMode(.plusLighter)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }
}

/// A flat bar for work that reports a fraction instead of steps; the sweep lives in the fill.
private struct LiveProgressBar: View {
    let value: Double
    let color: Color
    let shimmer: Bool

    private var fraction: Double { value.isFinite ? min(max(value, 0), 1) : 0 }

    var body: some View {
        HStack(spacing: 10) {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.1))
                    Capsule().fill(color)
                        .overlay { LiveSweep(active: shimmer) }
                        .clipShape(Capsule())
                        .frame(width: max(4, proxy.size.width * fraction))
                        .animation(.smooth(duration: 0.6), value: fraction)
                }
            }
            .frame(height: 4)
            Text(fraction, format: .percent.precision(.fractionLength(0)))
                .font(.caption.weight(.medium).monospacedDigit()).foregroundStyle(Color.reloSecondaryText)
        }
        .accessibilityElement(children: .ignore).accessibilityLabel("Progress")
        .accessibilityValue(fraction.formatted(.percent.precision(.fractionLength(0))))
    }
}

/// Steps as segments: finished ones in the meaning color with the sweep running through them
/// only (masked by their shapes), the current one a touch dimmer, pending ones faint track.
private struct LiveStepsBar: View {
    let steps: HistoryRow.Steps
    let color: Color
    let outcome: HistoryRow.Outcome
    let shimmer: Bool

    private var done: Int { HistoryStepsMeter.done(steps, outcome: outcome) }

    private func segments(_ fill: @escaping (Int) -> Color) -> some View {
        HStack(spacing: 3) {
            ForEach(0..<max(steps.total, 1), id: \.self) { index in
                Capsule().fill(fill(index)).frame(height: 4).frame(maxWidth: .infinity)
            }
        }
    }

    var body: some View {
        segments { index in index < done ? color : Color.white.opacity(index == done ? 0.28 : 0.1) }
            .overlay {
                LiveSweep(active: shimmer)
                    .mask(segments { index in index < done ? .black : .clear })
            }
            .frame(height: 4)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(HistoryStepsMeter.caption(steps, outcome: outcome))
    }
}
