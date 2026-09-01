import ReloCore

enum InboxPresentationProjection {
    static func presentation(for item: InboxItem) -> LiveActivityDisplayPresentation {
        if let liveActivity = item.liveActivity {
            let base = liveActivity.compositionalPresentation
            guard let summary = item.activitySummary else { return base }
            let semanticContext = summary.context ?? item.context
            return LiveActivityDisplayPresentation(
                header: base.header ?? item.sourceName,
                title: semanticContext?.taskTitle ?? summary.title,
                subtitle: summary.detail ?? base.subtitle,
                status: summary.status,
                visual: canonicalVisual(base.visual, progress: summary.progress),
                behavior: base.behavior,
                theme: base.theme,
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
        case nil:
            behavior = .informational
            symbol = InboxHierarchyProjection.project(for: item).presentationSymbol
            status = item.result ?? item.kind.rawValue
            accentColor = LiveActivityPresentationFormatting.defaultAccentColor
            secondaryColor = nil
        }

        return LiveActivityDisplayPresentation(
            header: item.sourceName,
            title: item.title,
            subtitle: item.detail ?? item.interaction?.prompt,
            status: status,
            visual: .none,
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
