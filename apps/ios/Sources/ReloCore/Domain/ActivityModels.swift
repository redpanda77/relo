import Foundation

public enum NotificationPrivacy: String, Codable, Equatable, Sendable {
    case standard
    case `private`
}

public enum NotificationAlertOwner: String, Codable, Equatable, Sendable {
    case apns
    case app
    case none
}

public enum LiveActivitySymbol: String, Codable, Equatable, Sendable {
    case terminal
    case code
    case build
    case success
    case warning
    case info
    case question
    case reply
    case image
    case lock

    public var systemImageName: String {
        switch self {
        case .terminal: "terminal.fill"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .build: "hammer.fill"
        case .success: "checkmark.circle.fill"
        case .warning: "exclamationmark.triangle.fill"
        case .info: "info.circle.fill"
        case .question: "questionmark.circle.fill"
        case .reply: "arrowshape.turn.up.left.fill"
        case .image: "photo.fill"
        case .lock: "lock.fill"
        }
    }
}

public struct LiveActivityActionLabels: Equatable, Sendable {
    public let primary: String
    public let secondary: String

    public init(style: String, primaryLabel: String? = nil, secondaryLabel: String? = nil) {
        let defaults = switch style {
        case "shell": ("[ allow ]", "[ reject ]")
        case "verdict": ("YES", "NO")
        case "signal": ("Respond", "Dismiss")
        default: ("Approve", "Deny")
        }
        primary = LiveActivityPresentationFormatting.normalizedActionLabel(primaryLabel) ?? defaults.0
        secondary = LiveActivityPresentationFormatting.normalizedActionLabel(secondaryLabel) ?? defaults.1
    }
}

public struct BinaryNotificationActionPresentation: Equatable, Sendable {
    public let primaryLabel: String
    public let primaryAction: NotificationInteractionAction
    public let secondaryLabel: String
    public let secondaryAction: NotificationInteractionAction

    public init?(
        kind: InboxInteraction.Kind,
        style: String,
        primaryLabel: String? = nil,
        secondaryLabel: String? = nil
    ) {
        guard kind != .text, kind != .choice else { return nil }
        let labels = LiveActivityActionLabels(
            style: style,
            primaryLabel: primaryLabel,
            secondaryLabel: secondaryLabel
        )
        self.primaryLabel = labels.primary
        self.secondaryLabel = labels.secondary
        switch kind {
        case .approval:
            primaryAction = .approve
            secondaryAction = .deny
        case .yesNo:
            primaryAction = .yes
            secondaryAction = .no
        case .text, .choice:
            return nil
        }
    }

    public init?(behavior: LiveActivityDisplayPresentation.Behavior) {
        switch behavior {
        case let .approval(primary, secondary):
            primaryLabel = primary
            primaryAction = .approve
            secondaryLabel = secondary
            secondaryAction = .deny
        case let .yesNo(primary, secondary):
            primaryLabel = primary
            primaryAction = .yes
            secondaryLabel = secondary
            secondaryAction = .no
        case .informational, .progress, .choice, .unsupportedTextReply:
            return nil
        }
    }
}

public struct LiveActivityTokenRegistration: Codable, Equatable, Sendable {
    public let token: String
    public let nativeActivityId: String
    public let environment: String
    public let generation: Int

    public init(token: String, nativeActivityId: String, environment: String, generation: Int) {
        precondition(generation > 0, "Live Activity generation must be positive")
        self.token = token
        self.nativeActivityId = nativeActivityId
        self.environment = environment
        self.generation = generation
    }
}

public struct LiveActivityIdentity: Codable, Equatable, Hashable, Sendable {
    public let activityID: String
    public let generation: Int

    public init(activityID: String, generation: Int) {
        self.activityID = activityID
        self.generation = generation
    }

    public var isValid: Bool {
        ReloIdentifier.isValid(activityID) && generation > 0
    }

    public var storageKey: String { "\(activityID)|\(generation)" }

    private enum CodingKeys: String, CodingKey { case activityID, generation }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        activityID = try values.decode(String.self, forKey: .activityID)
        generation = try values.decode(Int.self, forKey: .generation)
        guard isValid else {
            throw DecodingError.dataCorruptedError(
                forKey: .generation,
                in: values,
                debugDescription: "Live Activity identity must contain a valid ID and positive generation"
            )
        }
    }
}

public struct TaskLiveActivityMutationMetadata: Codable, Equatable, Sendable {
    public struct Activity: Codable, Equatable, Sendable {
        public let id: String
        public let generation: Int

        public var identity: LiveActivityIdentity {
            LiveActivityIdentity(activityID: id, generation: generation)
        }

        private enum CodingKeys: String, CodingKey { case id, generation }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            id = try values.decode(String.self, forKey: .id)
            generation = try values.decode(Int.self, forKey: .generation)
            guard generation > 0 else {
                throw DecodingError.dataCorruptedError(
                    forKey: .generation,
                    in: values,
                    debugDescription: "Live Activity generation must be a positive integer"
                )
            }
        }
    }

    public let activity: Activity
    public let replayed: Bool
    public let reused: Bool
    public let resumed: Bool

    private enum CodingKeys: String, CodingKey { case activity, replayed, reused, resumed }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        activity = try values.decode(Activity.self, forKey: .activity)
        replayed = try values.decode(Bool.self, forKey: .replayed)
        reused = try values.decodeIfPresent(Bool.self, forKey: .reused) ?? false
        resumed = try values.decodeIfPresent(Bool.self, forKey: .resumed) ?? false
    }
}

public struct LiveActivityLockScreenDisplay: Equatable, Sendable {
    public let style: String
    public let sourceName: String
    public let headline: String
    public let detail: String?
    public let status: String
    public let progress: Double?
    public let symbol: LiveActivitySymbol
    public let accentColor: String
    public let primaryLabel: String
    public let secondaryLabel: String
    public let allowsInteraction: Bool

    public init(
        style: String,
        sourceName: String,
        headline: String,
        detail: String?,
        status: String,
        progress: Double?,
        symbol: LiveActivitySymbol = .terminal,
        accentColor: String = LiveActivityPresentationFormatting.defaultAccentColor,
        primaryLabel: String? = nil,
        secondaryLabel: String? = nil,
        allowsInteraction: Bool
    ) {
        self.style = style
        self.sourceName = sourceName
        self.headline = headline
        self.detail = detail
        self.status = status
        self.progress = progress
        self.symbol = symbol
        self.accentColor = LiveActivityPresentationFormatting.normalizedAccentColor(accentColor)
        let labels = LiveActivityActionLabels(
            style: style,
            primaryLabel: primaryLabel,
            secondaryLabel: secondaryLabel
        )
        self.primaryLabel = labels.primary
        self.secondaryLabel = labels.secondary
        self.allowsInteraction = allowsInteraction
    }
}

public struct LiveActivityCommand: Codable, Equatable, Sendable {
    public enum Operation: String, Codable, Sendable {
        case start
        case update
        case end
    }

    public let operation: Operation
    public let activityId: String
    public let generation: Int
    public let targetDeviceId: String
    public let style: String
    public let sourceName: String
    public let headline: String
    public let detail: String?
    public let status: String
    public let progress: Double?
    public let symbol: LiveActivitySymbol
    public let privacy: NotificationPrivacy
    public let privacyMode: NotificationPrivacy
    public let accentColor: String
    public let expiresAt: Date?
    public let staleAt: Date?
    public let primaryLabel: String?
    public let secondaryLabel: String?
    public let alertOwner: NotificationAlertOwner
    public let sequence: Int?
    public let relevanceScore: Double
    public let presentationState: String
    public let otherActiveCount: Int
    public let dismissAfterSeconds: Int?
    public let interaction: LiveActivityInteractionCommand?
    public let presentation: LiveActivityPresentation
    /// This phone's sealed card or question text (E5); the Live Activity opens it like a push.
    public var sealed: ReloEnvelope? = nil
    /// The work this card shows (ADR 0007); absent from servers before works.
    public var work: ReloWork? = nil

    public init(
        operation: Operation,
        activityId: String,
        generation: Int,
        targetDeviceId: String,
        style: String,
        sourceName: String,
        headline: String,
        detail: String? = nil,
        status: String,
        progress: Double? = nil,
        symbol: LiveActivitySymbol = .terminal,
        privacy: NotificationPrivacy? = nil,
        privacyMode: NotificationPrivacy = .standard,
        accentColor: String = LiveActivityPresentationFormatting.defaultAccentColor,
        expiresAt: Date? = nil,
        staleAt: Date? = nil,
        primaryLabel: String? = nil,
        secondaryLabel: String? = nil,
        alertOwner: NotificationAlertOwner = .none,
        sequence: Int = 0,
        relevanceScore: Double = 0.5,
        presentationState: String = "unknown",
        otherActiveCount: Int = 0,
        dismissAfterSeconds: Int? = nil,
        interaction: LiveActivityInteractionCommand? = nil,
        presentation: LiveActivityPresentation? = nil
    ) {
        precondition(generation > 0, "Live Activity generation must be positive")
        let validatedInteraction = interaction?.isValidForPresentation == true ? interaction : nil
        self.operation = operation
        self.activityId = activityId
        self.generation = generation
        self.targetDeviceId = targetDeviceId
        self.style = LiveActivityStylePolicy.resolvedStyle(
            style,
            hasValidatedInteraction: validatedInteraction != nil
        )
        self.sourceName = sourceName
        self.headline = headline
        self.detail = detail
        self.status = status
        self.progress = progress
        self.symbol = symbol
        let effectivePrivacy = privacy ?? privacyMode
        self.privacy = effectivePrivacy
        self.privacyMode = effectivePrivacy
        self.accentColor = LiveActivityPresentationFormatting.normalizedAccentColor(accentColor)
        self.expiresAt = expiresAt
        self.staleAt = staleAt
        self.primaryLabel = LiveActivityPresentationFormatting.normalizedActionLabel(primaryLabel)
        self.secondaryLabel = LiveActivityPresentationFormatting.normalizedActionLabel(secondaryLabel)
        self.alertOwner = alertOwner
        self.sequence = sequence
        self.relevanceScore = min(max(relevanceScore, 0), 1)
        self.presentationState = presentationState
        self.otherActiveCount = max(otherActiveCount, 0)
        self.dismissAfterSeconds = dismissAfterSeconds
        self.interaction = validatedInteraction
        let component: LiveActivityPresentation.Component? = progress.map {
            .progressBar(id: "progress", colorRole: .project, value: min(max($0, 0), 1), label: nil)
        }
        let behavior: LiveActivityDisplayPresentation.Behavior = switch validatedInteraction?.kind {
        case .approval?: .approval(primary: primaryLabel ?? "Approve", secondary: secondaryLabel ?? "Deny")
        case .yesNo?: .yesNo(primary: primaryLabel ?? "Yes", secondary: secondaryLabel ?? "No")
        // Choice options travel only in a full presentation; this fallback has none to draw.
        case .text?, .choice?: .informational
        case nil: component == nil ? .informational : .progress
        }
        let componentIDs = component.map { [$0.id] } ?? []
        self.presentation = presentation ?? LiveActivityPresentation(
            header: sourceName, title: headline, subtitle: detail, status: status,
            components: component.map { [$0] } ?? [],
            surfaces: .init(
                lockScreen: componentIDs, expandedTrailing: componentIDs,
                expandedBottom: componentIDs, compactTrailing: componentIDs,
                minimal: Array(componentIDs.prefix(1))
            ),
            state: validatedInteraction == nil
                ? .init(kind: "active", tone: "live", icon: LiveActivityPresentation.SemanticIcon(rawValue: symbol.rawValue) ?? .active)
                : .init(kind: "needs_action", tone: "attention", icon: .needsAction),
            behavior: behavior,
            appearance: .init(theme: style == "terminal" || style == "shell" ? .dark : .system),
            privacy: effectivePrivacy == .private ? .private : .standard
        )
    }

    private enum CodingKeys: String, CodingKey {
        case operation, activityId, generation, targetDeviceId, style, sourceName, headline, detail, status
        case progress, symbol, privacy, privacyMode, accentColor, expiresAt, staleAt
        case primaryLabel, secondaryLabel, alertOwner, sequence, dismissAfterSeconds, interaction
        case relevanceScore, presentationState, otherActiveCount, sealed, work
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let decodedPresentation = try LiveActivityPresentation(from: decoder)
        sealed = try? values.decodeIfPresent(ReloEnvelope.self, forKey: .sealed)
        work = (try? values.decodeIfPresent(ReloWork.self, forKey: .work)).flatMap { $0.isEmpty ? nil : $0 }
        let rawInteraction = try values.decodeSupportedInteraction(
            LiveActivityInteractionCommand.self, forKey: .interaction, isSupported: InboxInteraction.isSupported
        )
        let decodedInteraction = rawInteraction?.isValidForPresentation == true ? rawInteraction : nil
        operation = try values.decode(Operation.self, forKey: .operation)
        activityId = try values.decode(String.self, forKey: .activityId)
        generation = try values.decode(Int.self, forKey: .generation)
        guard generation > 0 else {
            throw DecodingError.dataCorruptedError(
                forKey: .generation,
                in: values,
                debugDescription: "Live Activity generation must be a positive integer"
            )
        }
        targetDeviceId = try values.decode(String.self, forKey: .targetDeviceId)
        relevanceScore = min(max(
            try values.decodeIfPresent(Double.self, forKey: .relevanceScore) ?? 0.5,
            0
        ), 1)
        presentationState = try values.decodeIfPresent(String.self, forKey: .presentationState)
            ?? "unknown"
        otherActiveCount = max(
            try values.decodeIfPresent(Int.self, forKey: .otherActiveCount) ?? 0,
            0
        )
        presentation = decodedPresentation
        sourceName = try values.decodeIfPresent(String.self, forKey: .sourceName)
            ?? decodedPresentation.identity.project?.label ?? decodedPresentation.header ?? "Relo"
        headline = decodedPresentation.title
        detail = decodedPresentation.subtitle
        status = decodedPresentation.status
        progress = decodedPresentation.components.lazy.compactMap { component -> Double? in
            switch component {
            case let .progressBar(_, _, value, _): value
            case let .steps(_, _, items): Double(items.filter { $0.state == .complete }.count) / Double(items.count)
            case .image: nil
            }
        }.first
        style = switch decodedPresentation.behavior {
            case .approval, .choice: "approval"
            case .yesNo: "verdict"
            case .informational, .progress, .unsupportedTextReply:
                presentation.components.contains { if case .steps = $0 { true } else { false } }
                    ? "steps" : "standard"
        }
        symbol = LiveActivitySymbol(rawValue: presentation.state.icon.displaySymbol.rawValue) ?? .warning
        privacy = presentation.privacy == .private ? .private : .standard
        privacyMode = privacy
        accentColor = presentation.color(for: presentation.appearance.roles.cardIdentity)
        expiresAt = try values.decodeIfPresent(Date.self, forKey: .expiresAt)
        staleAt = try values.decodeIfPresent(Date.self, forKey: .staleAt)
        switch presentation.behavior {
            case let .approval(primary, secondary), let .yesNo(primary, secondary):
                primaryLabel = primary; secondaryLabel = secondary
            case .informational, .progress, .choice, .unsupportedTextReply:
                primaryLabel = nil; secondaryLabel = nil
        }
        alertOwner = try values.decodeIfPresent(NotificationAlertOwner.self, forKey: .alertOwner) ?? .none
        sequence = try values.decodeIfPresent(Int.self, forKey: .sequence) ?? 0
        dismissAfterSeconds = try values.decodeIfPresent(Int.self, forKey: .dismissAfterSeconds)
        interaction = presentation.permitsLiveActivityActions ? decodedInteraction : nil
    }

    public func encode(to encoder: Encoder) throws {
        try presentation.encode(to: encoder)
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(operation, forKey: .operation)
        try values.encode(activityId, forKey: .activityId)
        try values.encode(generation, forKey: .generation)
        try values.encode(targetDeviceId, forKey: .targetDeviceId)
        try values.encode(sourceName, forKey: .sourceName)
        try values.encodeIfPresent(expiresAt, forKey: .expiresAt)
        try values.encodeIfPresent(staleAt, forKey: .staleAt)
        try values.encode(alertOwner, forKey: .alertOwner)
        try values.encodeIfPresent(sequence, forKey: .sequence)
        try values.encode(relevanceScore, forKey: .relevanceScore)
        try values.encodeIfPresent(sealed, forKey: .sealed)
        try values.encodeIfPresent(work, forKey: .work)
        try values.encode(presentationState, forKey: .presentationState)
        try values.encode(otherActiveCount, forKey: .otherActiveCount)
        try values.encodeIfPresent(dismissAfterSeconds, forKey: .dismissAfterSeconds)
        try values.encodeIfPresent(interaction, forKey: .interaction)
    }

    public var lockScreenDisplay: LiveActivityLockScreenDisplay {
        if privacy == .private {
            return LiveActivityLockScreenDisplay(
                style: "standard",
                sourceName: "Relo",
                headline: "Private activity",
                detail: nil,
                status: "Open Relo to view",
                progress: nil,
                symbol: .terminal,
                accentColor: LiveActivityPresentationFormatting.defaultAccentColor,
                allowsInteraction: false
            )
        }
        return LiveActivityLockScreenDisplay(
            style: style,
            sourceName: sourceName,
            headline: headline,
            detail: detail,
            status: status,
            progress: progress,
            symbol: symbol,
            accentColor: accentColor,
            primaryLabel: primaryLabel,
            secondaryLabel: secondaryLabel,
            allowsInteraction: interaction != nil
        )
    }

    public var compositionalPresentation: LiveActivityDisplayPresentation {
        presentation.displayProjection.projectedForDisplay
    }

    public var requiresAppAlert: Bool {
        alertOwner == .app && (operation == .start || interaction?.state == .pending)
    }

    public var permitsLocalStart: Bool {
        operation == .start && alertOwner != .apns
    }

    public var permitsLocalRecovery: Bool {
        operation == .update
            && (presentationState == "foreground" || presentationState == "pending_token")
    }

    public var identity: LiveActivityIdentity {
        LiveActivityIdentity(activityID: activityId, generation: generation)
    }
}

public struct ActivityProgressPresentation: Equatable, Sendable {
    public static let stepCount = 5

    public let normalizedValue: Double?

    public init(progress: Double?) {
        guard let progress, progress.isFinite else {
            normalizedValue = nil
            return
        }
        normalizedValue = min(max(progress, 0), 1)
    }

    public var percentage: Int? {
        normalizedValue.map { Int(($0 * 100).rounded()) }
    }

    public var completedStepCount: Int? {
        normalizedValue.map {
            min(Self.stepCount, max(0, Int(($0 * Double(Self.stepCount)).rounded(.up))))
        }
    }

    public var accessibilityValue: String {
        percentage.map { "\($0) percent" } ?? "Progress unavailable"
    }
}

public enum LiveActivityCommandOrderingDecision: Equatable, Sendable {
    case apply
    case stale
    case conflict
}

public struct LiveActivityAccessibilitySummary: Equatable, Sendable {
    public let label: String
    public let value: String
    public let hint: String

    public init(
        source: String,
        headline: String,
        status: String,
        detail: String?,
        progress: Double?,
        isPrivate: Bool,
        isInteractive: Bool
    ) {
        if isPrivate {
            label = "Relo private activity"
            value = "Open Relo to view"
        } else {
            label = "\(source), \(headline)"
            var parts = [status]
            let progressPresentation = ActivityProgressPresentation(progress: progress)
            if let percentage = progressPresentation.percentage {
                parts.append("\(percentage) percent")
            }
            if let detail, !detail.isEmpty { parts.append(detail) }
            value = parts.joined(separator: ", ")
        }
        hint = isInteractive && !isPrivate
            ? "Contains response controls. Open Relo for full details."
            : "Open Relo for full details."
    }
}

public struct ActiveLiveActivityIdentityPage: Codable, Equatable, Sendable {
    public struct Item: Codable, Equatable, Sendable {
        public let id: String
        public let generation: Int
        public let eventId: String?
        public let createdAt: Date?
        public let command: LiveActivityCommand?
        public var identity: LiveActivityIdentity { .init(activityID: id, generation: generation) }

        public var recoveryEnvelope: LiveActivityCommandEnvelope? {
            guard
                let eventId,
                let createdAt,
                let command,
                command.identity == identity
            else { return nil }
            return .init(eventID: eventId, createdAt: createdAt, command: command)
        }
    }
    public let activities: [Item]
}
