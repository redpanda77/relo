import Combine
import ReloCore
import SwiftUI
import UIKit

struct NotificationDetailView: View {
    @Bindable var model: AppModel
    let item: InboxItem
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var confirmsWithdrawal = false
    private var currentItem: InboxItem {
        guard let detail = model.selectedNotificationDetail, detail.item.id == item.id else { return item }
        return detail.item
    }
    private var presentation: LiveActivityDisplayPresentation { InboxPresentationProjection.presentation(for: currentItem) }
    private var pending: Bool {
        guard let draft = model.currentDecision(notificationID: item.id) else { return false }
        return model.decisionAvailability(draft.identity).permitsSubmission
            && !model.responseIsQueued(for: item.id) && !model.responseIsAccepted(for: item.id)
    }
    /// The item's row in the Now summary: the server's state for it.
    private var nowItem: NowItem? { model.nowItemsByNotificationID[currentItem.id] }
    /// Stale only when the server says so (the item's owner state in the Now summary), never by the local clock.
    private var stale: Bool { nowItem?.owner.state == .stale }
    /// A sealed item this iPhone could not open says why, instead of an empty body.
    private var messageText: String? { currentItem.content?.body ?? presentation.subtitle ?? currentItem.unreadableLine }
    /// Where it came from and when, below the work itself: the harness and its session, the project and topic,
    /// the computer, then the time. Each row says what it is with an icon, so the card reads at a glance.
    private var aboutRows: [ReloAboutRow] {
        let context = InboxHierarchyProjection.context(for: currentItem)
        let row = HistoryRowProjection.row(currentItem, now: model.attentionDate)
        var rows: [ReloAboutRow] = []
        if let interaction = currentItem.interaction, interaction.state == .pending {
            rows.append(.init(symbol: "clock.badge.exclamationmark", label: "Respond by",
                              value: interaction.expiresAt.formatted(date: .omitted, time: .shortened)))
        }
        rows.append(.init(symbol: row.source.systemImageName, label: "From", value: row.source.name))
        if let session = context?.threadName, !session.isEmpty, session != presentation.title {
            rows.append(.init(symbol: "bubble.left.and.text.bubble.right", label: "Session", value: session))
        }
        if let project = row.project {
            rows.append(.init(symbol: "folder.fill", label: "Project", value: project.name,
                              tint: ReloProjectPalette.color(for: project, fallback: .reloSecondaryText)))
        }
        if let topic = row.topic, !topic.isEmpty, topic != context?.threadName {
            rows.append(.init(symbol: "number", label: "Topic", value: topic))
        }
        if let task = context?.taskTitle, !task.isEmpty, task != presentation.title {
            rows.append(.init(symbol: "checklist", label: "Task", value: task))
        }
        if let computer = context?.computer ?? row.origin, !computer.isEmpty {
            rows.append(.init(symbol: model.computerIcon(forOrigin: computer).systemImageName, label: "Computer", value: computer))
        }
        if currentItem.kind == .liveActivity {
            var ran = [Self.when(row.startedAt ?? currentItem.createdAt)]
            if let duration = row.duration { ran.append("took \(ReloDuration.format(duration))") }
            if let updates = row.updates, updates > 1 { ran.append("\(updates) updates") }
            rows.append(.init(symbol: "clock", label: "Started", value: ran.joined(separator: " · ")))
        } else {
            rows.append(.init(symbol: "clock", label: "Sent", value: Self.when(currentItem.createdAt)))
        }
        return rows
    }

    /// Today and yesterday by name, else the date: "Today, 10:29 PM".
    private static func when(_ date: Date) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        if Calendar.current.isDateInToday(date) { return "Today, \(time)" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday, \(time)" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private var asksNow: Bool { currentItem.interaction?.state == .pending }

    /// A Quiet work says why and since when (`Session idle since 3:12 PM`); else the card's own status.
    private var statusLine: String? {
        guard currentItem.kind == .liveActivity else { return nil }
        if let why = nowItem?.quietLine() { return why }
        return stale ? "Update overdue" : presentation.status
    }

    /// The work the owner may end from here: Quiet, Paused or Your turn, per the server's state.
    private var endTarget: EndWorkTarget? {
        guard currentItem.kind == .liveActivity, model.credential != nil, let nowItem, WorkEnding.isOffered(for: nowItem.owner.state)
        else { return nil }
        return EndWorkTarget(id: nowItem.id, title: presentation.title)
    }

    /// Shown after this phone ended the work: the item has left Now, so the button gives way to a line.
    private var endedHere: Bool { currentItem.kind == .liveActivity && model.endedNotificationIDs.contains(currentItem.id) }

    private var measuredProgress: Double? {
        if let value = currentItem.activitySummary?.progress { return value }
        if case let .progressBar(value, _) = presentation.visual { return value }
        return nil
    }

    /// The digest that carries the work's whole plan (the detail endpoint carries none; the History row of the same item does).
    private var planDigest: InboxCardDigest? {
        [currentItem.activity, item.activity, model.historyItems.first { $0.id == currentItem.id }?.activity]
            .lazy.compactMap { $0 }.first { $0.plan != nil }
    }

    /// What this phone opened of the item's work, its newest copy first. The plan is the work's current one, and this
    /// item's own text may predate its later rounds: a History event of round 17 drawing round 18 read "Not readable".
    private var workText: ReloWork.TextBook {
        let own = currentItem.work ?? currentItem.activity?.work
        guard let id = own?.id else { return ReloWork.TextBook(newestFirst: own.map { [$0] } ?? []) }
        let copies = (model.items + model.historyItems)
            .filter { ($0.work ?? $0.activity?.work)?.id == id }
            .sorted { $0.createdAt > $1.createdAt }
            .compactMap { $0.work ?? $0.activity?.work }
        return ReloWork.TextBook(newestFirst: copies + [own].compactMap { $0 })
    }

    /// The plan's steps with their text resolved: the server's label, else the one opened from the sealed
    /// text by step id (the work's newest copy on this phone), else the one this phone already showed, else
    /// "Step n". Nil without a whole plan.
    private var planEntries: [PlanOutline.Entry]? {
        guard let plan = planDigest?.plan else { return nil }
        let text = workText
        // The card's own window of steps, by plan position: the labels this phone already opened.
        let shown = presentation.timelineSteps(for: currentItem)
        let before = presentation.stepWindow.before
        let details = text.details
        return plan.enumerated().map { index, step in
            let placeholder = "Step \(index + 1)"
            let windowLabel = shown.indices.contains(index - before) ? shown[index - before].label : nil
            let opened = step.label.flatMap { ReloSealedCards.isPlaceholderStep($0) ? nil : $0 }
                ?? text.labels[step.id]
                ?? windowLabel.flatMap { ReloSealedCards.isPlaceholderStep($0) ? nil : $0 }
            // A label this phone cannot open is not "Step n": the row says so (U8).
            let label = opened ?? placeholder
            let state: LiveActivityDisplayPresentation.Step.State = switch step.state {
            case "done", "complete": .complete
            case "current": .current
            case "skipped": .skipped
            default: .pending
            }
            return PlanOutline.Entry(id: step.id, label: label, state: state, detail: step.detail ?? details[step.id],
                                     parent: step.parent, round: step.round ?? 1, readable: opened != nil,
                                     startedAt: step.startedAt, doneAt: step.doneAt, carriedFrom: step.carriedFrom)
        }
    }

    /// The plan as rounds and nested steps; round titles and outcomes the server withheld come from the sealed text.
    private var planOutline: PlanOutline? {
        guard let entries = planEntries else { return nil }
        let text = workText
        return PlanOutline.make(entries: entries, rounds: planDigest?.rounds, titles: text.titles, outcomes: text.outcomes)
    }

    /// The work's whole plan when the server sent it (the card carries only a window of a long one),
    /// with sealed labels opened by step id; else the card's own steps and the count of those it hides.
    private var planSteps: (steps: [LiveActivityDisplayPresentation.Step], window: LiveActivityDisplayPresentation.StepWindow) {
        if let entries = planEntries {
            return (entries.map { .init(id: $0.id, label: $0.label, state: $0.state) },
                    // The whole plan is drawn, but the count is still the server's when the card carries it.
                    .init(progress: presentation.stepWindow.progress))
        }
        return (presentation.timelineSteps(for: currentItem), presentation.stepWindow)
    }

    /// The work's card updates sent while `stepID` was current: from the History events of this work.
    private func stepUpdates(for stepID: String) -> [PlanStepUpdate] {
        let work = currentItem.activity?.work ?? currentItem.work
        return PlanStepUpdates.updates(stepID: stepID, workID: work?.id, in: model.historyItems + [currentItem])
    }

    @ViewBuilder private var progressSection: some View {
        let (steps, window) = planSteps
        // Nothing to measure: the status in the header already says how it stands.
        if currentItem.kind == .liveActivity, !steps.isEmpty || measuredProgress != nil {
            VStack(alignment: .leading, spacing: 16) {
                ReloMissionTimeline(item: currentItem, steps: steps, window: window, outline: planOutline,
                                    progress: measuredProgress, status: presentation.status, now: model.attentionDate,
                                    serverOutcome: nowItem.flatMap(ReloStateStyle.init(item:)),
                                    updates: { stepUpdates(for: $0) })
                ReloActivityVisual(item: currentItem, accountID: model.credential?.accountId, mediaOnly: true)
            }
            .reloEntrance(1)
        }
    }

    @ViewBuilder private var messageSection: some View {
        let kind = ReloMessageKind(item: currentItem, stale: stale)
        if messageText != nil || currentItem.validatedDestinationURL != nil || currentItem.validatedSourceImageURL != nil {
            VStack(alignment: .leading, spacing: 14) {
                if let messageText {
                    ReloMessageBody(text: messageText, markdown: currentItem.content?.format == .markdown)
                }
                if let imageURL = currentItem.validatedSourceImageURL {
                    ReloRemoteImage(url: imageURL, accountID: model.credential?.accountId, altText: "Image from \(currentItem.sourceName)")
                        .clipShape(RoundedRectangle(cornerRadius: ReloLayout.nestedRadius(), style: .continuous))
                }
                if let url = currentItem.validatedDestinationURL {
                    ReloLinkTile(url: url)
                }
            }
            .padding(ReloLayout.cardInset)
            .frame(maxWidth: .infinity, alignment: .leading)
            .reloCard(tint: kind.color)
            .reloEntrance(1)
        }
    }

    var body: some View {
        let kind = ReloMessageKind(item: currentItem, stale: stale)
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                ReloIdentityHeader(item: currentItem, title: presentation.title, kind: kind, status: statusLine,
                                   serverOutcome: nowItem.flatMap(ReloStateStyle.init(item:)),
                                   now: model.attentionDate)
                    .reloEntrance(0)
                // A question leads with the question; the work it belongs to follows.
                if asksNow {
                    messageSection
                    progressSection
                } else {
                    progressSection
                    messageSection
                }
                if currentItem.interaction != nil && !pending {
                    ResponseControls(model: model, item: currentItem).reloEntrance(2)
                }
                // Said once, here, where the late answer is given; the Missed card on Now only offers it.
                if nowItem?.question?.standing == .missed {
                    CardNote(NowScreenModel.lateAnswerNote, symbol: "clock.badge.xmark").reloEntrance(2)
                }
                // How it was delivered is the server's business: the owner sees where it came from.
                ReloDetailSection(title: "About") { ReloAboutList(rows: aboutRows) }
                    .reloEntrance(3)
                if endedHere {
                    EndWorkSection(model: model, target: EndWorkTarget(id: currentItem.id, title: presentation.title), ended: true)
                        .reloEntrance(5)
                } else if let target = endTarget {
                    EndWorkSection(model: model, target: target, ended: false).reloEntrance(5)
                }
            }
            .padding(.horizontal, ReloLayout.screenInset)
            .padding(.top, 8).padding(.bottom, 72) // clears the floating tab bar (U9)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(alignment: .top) {
            // A soft wash of the message's state color behind the header; static, never motion.
            EllipticalGradient(colors: [kind.color.opacity(0.22), .clear], center: .top,
                               startRadiusFraction: 0, endRadiusFraction: 0.75)
                .frame(height: 420).ignoresSafeArea().allowsHitTesting(false).accessibilityHidden(true)
        }
        .reloScreenBackground()
        .safeAreaInset(edge: .bottom) {
            if pending {
                ResponseControls(model: model, item: currentItem)
                    .padding(.horizontal, ReloLayout.screenInset).padding(.top, 12).padding(.bottom, 8)
                    .background {
                        if reduceTransparency { Color.reloSurface.ignoresSafeArea() } else {
                            Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
                                .overlay(alignment: .top) { Rectangle().fill(Color.white.opacity(0.10)).frame(height: 0.5) }
                        }
                    }
            }
        }
        .navigationTitle(currentItem.kind == .liveActivity ? "Activity" : "Message")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if model.canWithdraw(currentItem) {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Remove notification", role: .destructive) { confirmsWithdrawal = true }
                    } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("More actions")
                }
            }
        }
        .reloConfirmation(isPresented: $confirmsWithdrawal) {
            ReloConfirmSpec(
                title: "Remove this notification?", message: "It will disappear from Now. You can still find it in History.",
                symbol: "trash", actionTitle: "Remove notification",
                action: { await model.withdrawNotification(currentItem.id) })
        }
    }
}

/// One line of the About card: an icon, what the line is, and its value.
struct ReloAboutRow: Identifiable {
    let symbol: String
    let label: String
    let value: String
    var tint: Color? = nil
    var id: String { label }
}

struct ReloAboutList: View {
    let rows: [ReloAboutRow]
    @ScaledMetric(relativeTo: .subheadline) private var iconWidth: CGFloat = 22

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Image(systemName: row.symbol)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(row.tint ?? Color.reloSecondaryText)
                        .frame(width: iconWidth)
                        .accessibilityHidden(true)
                    Text(row.label).font(.subheadline).foregroundStyle(Color.reloSecondaryText)
                    Spacer(minLength: 12)
                    Text(row.value).font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                        .multilineTextAlignment(.trailing)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                .padding(.vertical, 10)
                .accessibilityElement(children: .combine)
                if index < rows.count - 1 {
                    Divider().overlay(Color.white.opacity(0.06)).padding(.leading, iconWidth + 12)
                }
            }
        }
        .padding(.vertical, -6)
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
        usesSystemSurfaces: Bool = false
    ) {
        // The host owns reading surfaces, even when sender appearance disagrees.
        accent = .reloInteractive
        secondary = .secondary
        primaryText = .primary
        secondaryText = .reloSecondaryText
        canvas = .reloCanvas
        surface = .reloSurface
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
        case let .steps(items, _):
            VStack(alignment: .leading, spacing: surface == .detail ? 9 : 6) {
                HStack(spacing: 6) {
                    ForEach(items) { item in
                        Capsule()
                            .fill(item.state == .pending ? palette.primaryText.opacity(0.14)
                                : item.state == .current ? palette.accent.opacity(0.42) : palette.accent)
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
            ReloImmutableImage(reference: reference, accountID: accountID, row: surface == .row)
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
