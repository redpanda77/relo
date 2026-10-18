import ReloCore
import SwiftUI

/// The answer area of every question, on Now and on its detail page: the sender's choices as one row of
/// equal buttons, and one status line under them (on a card the line moves up: the phase and the countdown
/// sit in the card's header corner, `Phase.corner`, and only a failure or a closed request adds a note). From the tap to "Sent" nothing moves: the chosen button
/// spins and then carries a check, the others dim, and only the line's words change. A failure says why
/// and leaves the buttons live; a closed request keeps only its line.
struct ReloDecisionActions: View {
    struct Choice: Identifiable, Equatable {
        var id: String
        var label: String
        var action: NotificationInteractionAction
        var optionID: String? = nil
        var prominent = false
    }

    enum Phase: Equatable {
        /// Answerable: the buttons are live and the line counts down.
        case ready
        /// Not confirmed current yet: the buttons wait, disabled.
        case checking
        /// A tap is on its way.
        case sending
        /// Stored on this iPhone; it goes as soon as Relo is reachable.
        case waiting
        /// Relo recorded it.
        case recorded
        /// Nothing was recorded; the words say why and the buttons are live again.
        case failed(String)
        /// Expired, answered elsewhere or replaced. The line says which; no buttons.
        case closed(String, symbol: String = "clock.badge.xmark")
    }

    enum Style {
        /// The detail page: full-size buttons, the status line under them.
        case page
        /// A card: compact equal-split actions; the card's header carries the countdown and the phase.
        case card
    }

    let choices: [Choice]
    let phase: Phase
    var style: Style = .page
    /// The choice the owner sent, when known (the feedback's action); a tap here sets it too.
    var sent: NotificationInteractionAction? = nil
    var deadline: Date? = nil
    let send: (Choice) -> Void

    @State private var tapped: Choice.ID?
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var live: Bool {
        switch phase {
        case .ready, .failed: true
        default: false
        }
    }

    private var answered: Bool { phase == .sending || phase == .waiting || phase == .recorded }

    private func isChosen(_ choice: Choice) -> Bool {
        guard answered else { return false }
        if let tapped { return tapped == choice.id }
        return choice.optionID == nil && choice.action == sent
    }

    var body: some View {
        VStack(alignment: .leading, spacing: ReloLayout.footerGap) {
            if case .closed = phase {} else { buttons }
            if style == .page { statusLine } else if let note = phase.note { cardNote(note) }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: phase)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: tapped)
        .onChange(of: phase) { _, next in if case .failed = next { tapped = nil } }
    }

    @ViewBuilder private var buttons: some View {
        if typeSize.isAccessibilitySize {
            VStack(spacing: ReloLayout.inlineGap) { buttonRow }
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: style == .card ? ReloLayout.inlineGap : ReloLayout.footerGap) { buttonRow }
                VStack(spacing: ReloLayout.inlineGap) { buttonRow }
            }
        }
    }

    private func cardNote(_ note: Phase.Note) -> some View {
        Label(note.text, systemImage: note.symbol)
            .font(ReloLayout.cardMeta).foregroundStyle(note.color)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var buttonRow: some View {
        ForEach(choices) { choice in
            let chosen = isChosen(choice)
            Button {
                guard live else { return }
                tapped = choice.id
                send(choice)
            } label: {
                ZStack {
                    // The label keeps the button's size while a spinner or a check stands in.
                    Text(choice.label).lineLimit(2).multilineTextAlignment(.center)
                        .opacity(chosen && phase != .recorded ? 0 : 1)
                    if chosen && phase != .recorded {
                        ProgressView().controlSize(.small)
                            .tint(choice.prominent ? Color.reloOnAction : Color.primary)
                    }
                }
                .overlay(alignment: .leading) {
                    if chosen && phase == .recorded {
                        Image(systemName: "checkmark").font(.subheadline.weight(.bold))
                            .padding(.leading, ReloLayout.cardInset - 2).transition(.opacity)
                    }
                }
            }
            .modifier(ChoiceButtonStyle(style: style, prominent: choice.prominent))
            .disabled(!live && !chosen)
            .allowsHitTesting(live)
            .accessibilityHint(live ? "Sends this answer to Relo" : "")
            .accessibilityAddTraits(chosen ? .isSelected : [])
        }
    }

    private var statusLine: some View {
        ZStack(alignment: .leading) {
            // One line's height is held from the first frame, so no state grows the card.
            Text("Sending…").hidden().accessibilityHidden(true)
            status
                .transition(.opacity)
                .id(statusKey)
        }
        .font(.footnote)
        .foregroundStyle(Color.reloSecondaryText)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var statusKey: String {
        switch phase {
        case .ready: "ready"
        case .checking: "checking"
        case .sending: "sending"
        case .waiting: "waiting"
        case .recorded: "recorded"
        case let .failed(text): "failed-\(text)"
        case let .closed(text, _): "closed-\(text)"
        }
    }

    @ViewBuilder private var status: some View {
        switch phase {
        case .ready:
            if let deadline, deadline > .now {
                Label {
                    HStack(spacing: 4) {
                        Text("Answer within")
                        Text(timerInterval: Date.now...deadline, countsDown: true)
                            .monospacedDigit().fontWeight(.semibold)
                    }
                } icon: { Image(systemName: "timer") }
                    .accessibilityElement(children: .combine)
            }
        case .checking: Label("Checking this request…", systemImage: "arrow.triangle.2.circlepath")
        case .sending: Label("Sending…", systemImage: "arrow.up.circle")
        case .waiting: Label("Saved here; it sends when Relo is reachable", systemImage: "clock.arrow.circlepath")
        case .recorded: Label("Sent", systemImage: "checkmark.circle").foregroundStyle(Color.reloDone)
        case let .failed(text):
            Label(text, systemImage: "exclamationmark.circle").foregroundStyle(Color.reloErrorText)
                .fixedSize(horizontal: false, vertical: true)
        case let .closed(text, symbol):
            Label(text, systemImage: symbol).fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The answer button's look: the page's full-size button, or a card's compact equal-split action.
private struct ChoiceButtonStyle: ViewModifier {
    let style: ReloDecisionActions.Style
    let prominent: Bool

    func body(content: Content) -> some View {
        switch style {
        case .page: content.buttonStyle(.relo(prominent ? .primary : .secondary))
        case .card: content.buttonStyle(.cardAction(prominent ? .primary : .secondary, fill: true))
        }
    }
}

extension ReloDecisionActions.Choice {
    /// A yes/no or approval question's two answers, the sender's labels, the affirmative one prominent.
    static func binary(_ actions: BinaryNotificationActionPresentation) -> [Self] {
        [.init(id: actions.secondaryAction.rawValue, label: actions.secondaryLabel, action: actions.secondaryAction),
         .init(id: actions.primaryAction.rawValue, label: actions.primaryLabel, action: actions.primaryAction, prominent: true)]
    }

    /// A choice question's options, each of equal weight.
    static func options(_ options: [InteractionOption]) -> [Self] {
        options.map { .init(id: "option-\($0.id)", label: $0.label, action: .choose, optionID: $0.id) }
    }
}

extension ReloDecisionActions.Phase {
    struct Note: Equatable {
        var text: String
        var symbol: String
        var color: Color
    }

    /// What a card's header corner says while this phase lasts: the countdown while answerable, then the
    /// words for the send ("Sending…", "Sent").
    func corner(deadline: Date?) -> CardCorner {
        switch self {
        case .ready:
            if let deadline, deadline > .now { return .countdown(deadline) }
            return .none
        case .checking: return .phase("Checking…", symbol: "arrow.triangle.2.circlepath", color: .reloSecondaryText)
        case .sending: return .phase("Sending…", symbol: "arrow.up.circle", color: .reloSecondaryText)
        case .waiting: return .phase("Saved here", symbol: "clock.arrow.circlepath", color: .reloSecondaryText)
        case .recorded: return .phase("Sent", symbol: "checkmark.circle", color: .reloDone)
        case .failed, .closed: return .none
        }
    }

    /// A sentence a card cannot fit in its corner: why nothing was recorded, why it is closed, when it sends.
    var note: Note? {
        switch self {
        case .waiting: Note(text: "Saved here; it sends when Relo is reachable", symbol: "clock.arrow.circlepath", color: .reloSecondaryText)
        case let .failed(text): Note(text: text, symbol: "exclamationmark.circle", color: .reloErrorText)
        case let .closed(text, symbol): Note(text: text, symbol: symbol, color: .reloSecondaryText)
        default: nil
        }
    }
    /// The phase of an answer sent from this iPhone, when there is one: sending, stored, recorded or failed.
    static func answer(_ feedback: NotificationResponseFeedback?, submitting: Bool) -> Self? {
        if submitting || feedback?.phase == .sending { return .sending }
        switch feedback?.phase {
        case .accepted?: return .recorded
        case .queued?: return .waiting
        case .rejected?: return .failed(feedback?.message ?? "Not recorded. Try again.")
        default: return nil
        }
    }

    /// Why a request that is not answerable here says so, in a few words.
    static func unavailable(_ availability: CurrentActionAvailability) -> Self {
        switch availability {
        case .available: .ready
        case .unverified: .checking
        case .expired: .closed("This request expired")
        case .replaced: .closed("Replaced by a newer request")
        case .answered: .closed("Already answered", symbol: "checkmark.circle")
        case .unavailable: .closed("No longer available")
        case .differentAccount: .closed("Belongs to a different account")
        }
    }
}

/// A question's answer area on its detail page.
struct ResponseControls: View {
    @Bindable var model: AppModel
    let item: InboxItem

    private var availability: CurrentActionAvailability? {
        model.currentDecision(notificationID: item.id).map { model.decisionAvailability($0.identity) }
    }

    private var deadlinePassed: Bool { (item.interaction?.expiresAt ?? .distantPast) <= model.attentionDate }

    private var choices: [ReloDecisionActions.Choice] {
        if let interaction = item.interaction, interaction.kind == .choice, let options = interaction.options {
            return ReloDecisionActions.Choice.options(options)
        }
        return BinaryNotificationActionPresentation(
            behavior: InboxPresentationProjection.presentation(for: item).behavior).map(ReloDecisionActions.Choice.binary) ?? []
    }

    private var phase: ReloDecisionActions.Phase {
        let feedback = model.responseFeedback(for: item.id)
        if let answer = ReloDecisionActions.Phase.answer(feedback, submitting: model.respondingNotificationID == item.id) {
            // A failure past the deadline is told as expired below: retrying could not help.
            if case .failed = answer, deadlinePassed {} else { return answer }
        }
        if model.responseIsQueued(for: item.id) { return .waiting }
        guard let interaction = item.interaction, interaction.state == .pending else {
            return .closed(item.interaction?.chosenLabel.map { "Chose \($0)" }
                           ?? item.interaction?.state.rawValue.capitalized ?? "Answered", symbol: "checkmark.circle")
        }
        if deadlinePassed { return .closed("This request expired") }
        if !model.isRegistered || model.requiresReauthentication || model.accountState == .disabled {
            return .closed("Sign in again to answer", symbol: "person.crop.circle.badge.exclamationmark")
        }
        guard let availability else { return .checking }
        return .unavailable(availability)
    }

    var body: some View {
        ReloDecisionActions(choices: choices, phase: phase, sent: model.responseFeedback(for: item.id)?.action,
                            deadline: item.interaction?.expiresAt) { send($0) }
            .task(id: item.id) { await verifyIfUnconfirmed() }
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

    private func send(_ choice: ReloDecisionActions.Choice) {
        guard model.respondingNotificationID == nil else { return }
        Task {
            NotificationResponseHaptics.decisionStarted()
            await model.respond(to: item, action: choice.action, optionID: choice.optionID)
            if let feedback = model.responseFeedback(for: item.id) { NotificationResponseHaptics.responseFinished(feedback.phase) }
        }
    }
}
