import ReloCore

enum InboxPresentationProjection {
    static func presentation(for item: InboxItem) -> LiveActivityDisplayPresentation {
        if let liveActivity = item.liveActivity {
            let base = liveActivity.compositionalPresentation
            guard let summary = item.activitySummary else { return base }
            let semanticContext = summary.context ?? item.context
            return LiveActivityDisplayPresentation(
                header: base.header ?? item.sourceName,
                title: ReloSealedCards.readableTitle(semanticContext?.taskTitle ?? summary.title,
                                                     prompt: item.interaction?.prompt ?? summary.detail),
                subtitle: summary.detail ?? base.subtitle,
                // An ended card keeps the status it ended with ("Shipped", "Tests failed").
                status: InboxAttentionProjection.finalStatus(item, now: .now)
                    ?? InboxAttentionProjection.activityEnding(item, now: .now).map { $0 == .expired ? "Expired" : "Ended" }
                    ?? summary.status,
                visual: canonicalVisual(base.visual, progress: summary.progress),
                behavior: base.behavior,
                accentColor: base.accentColor,
                secondaryColor: base.secondaryColor,
                symbol: base.symbol,
                privacy: base.privacy
            ).projectedForDisplay
        }

        let behavior: LiveActivityDisplayPresentation.Behavior
        let symbol: LiveActivityDisplayPresentation.Symbol
        let status: String
        let accentColor: String
        let secondaryColor: String?
        switch item.interaction?.kind {
        case .approval:
            behavior = .approval(primary: "Approve", secondary: "Deny")
            symbol = .question
            status = interactionStatus(item.interaction?.state, pending: "Approval needed")
            accentColor = "#FF8A2A"
            secondaryColor = "#FF453A"
        case .yesNo:
            behavior = .yesNo(primary: "Yes", secondary: "No")
            symbol = .question
            status = interactionStatus(item.interaction?.state, pending: "Response needed")
            accentColor = LiveActivityPresentationFormatting.defaultAccentColor
            secondaryColor = nil
        case .text:
            behavior = .unsupportedTextReply(
                label: "Send",
                placeholder: item.interaction?.prompt,
                maxLength: NotificationReplyPolicy.maximumUTF16CodeUnits
            )
            symbol = .reply
            status = interactionStatus(item.interaction?.state, pending: "Reply needed")
            accentColor = LiveActivityPresentationFormatting.defaultAccentColor
            secondaryColor = nil
        case .choice:
            behavior = .choice(item.interaction?.options ?? [])
            symbol = .question
            status = item.interaction?.chosenLabel
                ?? interactionStatus(item.interaction?.state, pending: "Response needed")
            accentColor = LiveActivityPresentationFormatting.defaultAccentColor
            secondaryColor = nil
        case nil:
            behavior = .informational
            symbol = InboxHierarchyProjection.project(for: item).presentationSymbol
            status = item.result ?? item.kind.displayName
            accentColor = LiveActivityPresentationFormatting.defaultAccentColor
            secondaryColor = nil
        }

        return LiveActivityDisplayPresentation(
            header: item.sourceName,
            title: ReloSealedCards.readableTitle(item.activitySummary?.context?.taskTitle ?? item.activitySummary?.title ?? item.title,
                                                 prompt: item.interaction?.prompt),
            subtitle: item.activitySummary?.detail ?? item.detail ?? item.interaction?.prompt,
            status: item.interaction != nil ? status : (item.activitySummary?.status ?? status),
            visual: item.activitySummary?.progress.map { .progressBar(value: $0, label: "Progress") } ?? .none,
            behavior: behavior,
            accentColor: accentColor,
            secondaryColor: secondaryColor,
            symbol: symbol,
            privacy: item.privacy == .private ? .private : .standard
        ).projectedForDisplay
    }

    private static func canonicalVisual(
        _ visual: LiveActivityDisplayPresentation.Visual,
        progress: Double?
    ) -> LiveActivityDisplayPresentation.Visual {
        switch visual {
        case let .progressBar(_, label):
            progress.map { .progressBar(value: $0, label: label) } ?? .none
        case .none, .steps, .image:
            visual
        }
    }

    private static func interactionStatus(
        _ state: InboxInteraction.State?,
        pending: String
    ) -> String {
        switch state {
        case .pending, nil: pending
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
