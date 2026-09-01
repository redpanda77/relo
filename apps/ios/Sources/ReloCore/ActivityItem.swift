import Darwin
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

public enum LiveActivityPresentationFormatting {
    public static let defaultAccentColor = "#5ED8B7"

    public static func normalizedAccentColor(_ value: String?) -> String {
        guard let value, value.utf8.count == 7, value.first == "#" else {
            return defaultAccentColor
        }
        let hex = value.dropFirst()
        guard hex.unicodeScalars.allSatisfy({ scalar in
            (48...57).contains(scalar.value)
                || (65...70).contains(scalar.value)
                || (97...102).contains(scalar.value)
        }) else {
            return defaultAccentColor
        }
        return value.uppercased()
    }

    public static func normalizedActionLabel(_ value: String?) -> String? {
        guard let value else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            (1...24).contains(normalized.utf16.count),
            normalized.unicodeScalars.allSatisfy({
                !CharacterSet.controlCharacters.contains($0)
            })
        else { return nil }
        return normalized
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
        guard kind != .text else { return nil }
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
        case .text:
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
        case .informational, .progress, .unsupportedTextReply:
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

public enum ActivityKitTokenCodec {
    public static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}

public enum ActivityKitTimestamp {
    public static func date(fromUnixSeconds seconds: Double) -> Date {
        Date(timeIntervalSince1970: seconds)
    }

    public static func date(fromISO8601 value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: value)
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

public enum LiveActivityResponsePhase: String, Codable, Equatable, Hashable, Sendable {
    case sending
    case queued
    case accepted
    case rejected
}

public struct LiveActivityContentInteraction: Codable, Equatable, Hashable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible {
    public static let maximumUnixSeconds: Int64 = 9_007_199_254_740_991

    public let id: String
    public let notificationID: String
    public let targetDeviceID: String
    public let accountID: String
    public let kind: String
    public var state: String
    public let credential: String
    public let expiresAtUnixSeconds: Int64
    public var responsePhase: LiveActivityResponsePhase?
    public var selectedAction: NotificationInteractionAction?

    public init(
        id: String,
        notificationID: String,
        targetDeviceID: String,
        accountID: String,
        kind: String,
        state: String,
        credential: String,
        expiresAtUnixSeconds: Int64,
        responsePhase: LiveActivityResponsePhase? = nil,
        selectedAction: NotificationInteractionAction? = nil
    ) {
        self.id = id
        self.notificationID = notificationID
        self.targetDeviceID = targetDeviceID
        self.accountID = accountID
        self.kind = kind
        self.state = state
        self.credential = credential
        self.expiresAtUnixSeconds = expiresAtUnixSeconds
        self.responsePhase = responsePhase
        self.selectedAction = selectedAction
    }

    private enum CodingKeys: String, CodingKey {
        case id, notificationID, targetDeviceID, accountID, kind, state, credential
        case expiresAtUnixSeconds, responsePhase, selectedAction
    }

    public var expiresAt: Date {
        Date(timeIntervalSince1970: TimeInterval(expiresAtUnixSeconds))
    }

    public var isValidForPresentation: Bool {
        let kinds = Set(["approval", "yes_no", "text"])
        let states = Set(["pending", "approved", "denied", "yes", "no", "replied", "expired", "canceled"])
        return ReloIdentifier.isValid(id)
            && ReloIdentifier.isValid(notificationID)
            && ReloIdentifier.isValid(targetDeviceID)
            && ReloIdentifier.isValid(accountID)
            && kinds.contains(kind)
            && states.contains(state)
            && (32...4_096).contains(credential.utf16.count)
            && (0...Self.maximumUnixSeconds).contains(expiresAtUnixSeconds)
            && LiveActivityResponsePolicy.isValid(
                phase: responsePhase,
                action: selectedAction,
                interactionKind: kind,
                interactionState: state
            )
    }

    public var description: String {
        let phaseDescription = responsePhase?.rawValue ?? "none"
        let actionDescription = selectedAction?.rawValue ?? "none"
        return "LiveActivityContentInteraction(id: \(id), notificationID: \(notificationID), "
            + "targetDeviceID: \(targetDeviceID), accountID: \(accountID), kind: \(kind), "
            + "state: \(state), responsePhase: \(phaseDescription), "
            + "selectedAction: \(actionDescription), credential: <redacted>, "
            + "expiresAtUnixSeconds: \(expiresAtUnixSeconds))"
    }

    public var debugDescription: String { description }
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
        case .text?: .informational
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
        case relevanceScore, presentationState, otherActiveCount
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let decodedPresentation = try LiveActivityPresentation(from: decoder)
        let rawInteraction = try values.decodeIfPresent(
            LiveActivityInteractionCommand.self, forKey: .interaction
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
            case .approval: "approval"
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
            case .informational, .progress, .unsupportedTextReply:
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

public enum LiveActivityStylePolicy {
    public static let supportedStyles: Set<String> = [
        "standard", "hero", "terminal", "steps",
        "approval", "shell", "verdict", "signal",
    ]

    public static func resolvedStyle(
        _ rawStyle: String?,
        hasValidatedInteraction: Bool
    ) -> String {
        if let rawStyle, supportedStyles.contains(rawStyle) { return rawStyle }
        return hasValidatedInteraction ? "approval" : "standard"
    }
}

public struct LiveActivityInteractionCommand: Codable, Equatable, Sendable {
    public let id: String
    public let notificationId: String
    public let kind: InboxInteraction.Kind
    public let state: InboxInteraction.State
    public let credential: String
    public let expiresAt: Date

    public init(
        id: String,
        notificationId: String,
        kind: InboxInteraction.Kind,
        state: InboxInteraction.State,
        credential: String,
        expiresAt: Date
    ) {
        self.id = id
        self.notificationId = notificationId
        self.kind = kind
        self.state = state
        self.credential = credential
        self.expiresAt = expiresAt
    }

    public var isValidForPresentation: Bool {
        ReloIdentifier.isValid(id)
            && ReloIdentifier.isValid(notificationId)
            && (32...4_096).contains(credential.utf16.count)
    }
}

public struct InboxInteraction: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case approval
        case yesNo = "yes_no"
        case text
    }

    public enum State: String, Codable, Sendable {
        case pending
        case approved
        case denied
        case yes
        case no
        case replied
        case expired
        case canceled
    }

    public let id: String
    public let kind: Kind
    public let prompt: String
    public let state: State
    public let expiresAt: Date
    public let respondedAt: Date?

    public init(
        id: String,
        kind: Kind,
        prompt: String,
        state: State,
        expiresAt: Date,
        respondedAt: Date? = nil
    ) {
        self.id = id
        self.kind = kind
        self.prompt = prompt
        self.state = state
        self.expiresAt = expiresAt
        self.respondedAt = respondedAt
    }
}

public enum NotificationInteractionAction: String, Codable, Equatable, Sendable {
    case approve
    case deny
    case yes
    case no
    case answer
    case opened
    case received
}

public enum NotificationResponsePhase: String, Codable, Equatable, Hashable, Sendable {
    case sending
    case queued
    case accepted
    case rejected
}

public struct NotificationResponseFeedback: Equatable, Sendable {
    public let phase: NotificationResponsePhase
    public let action: NotificationInteractionAction
    public let canonicalState: String?
    public let message: String?

    public init(
        phase: NotificationResponsePhase,
        action: NotificationInteractionAction,
        canonicalState: String? = nil,
        message: String? = nil
    ) {
        self.phase = phase
        self.action = action
        self.canonicalState = canonicalState
        self.message = message
    }

    public var status: String {
        if let message { return message }
        let label = NotificationResponsePolicy.actionLabel(action)
        switch phase {
        case .sending: return "Sending \(label)…"
        case .queued: return "\(label.capitalized) queued securely"
        case .accepted:
            return (canonicalState ?? NotificationResponsePolicy.canonicalState(for: action) ?? label)
                .replacingOccurrences(of: "_", with: " ")
                .capitalized
        case .rejected: return "Response not recorded — retry"
        }
    }
}

public enum NotificationResponsePolicy {
    public static func canonicalState(for action: NotificationInteractionAction) -> String? {
        switch action {
        case .approve: "approved"
        case .deny: "denied"
        case .yes: "yes"
        case .no: "no"
        case .answer: "replied"
        case .opened, .received: nil
        }
    }

    public static func supports(_ action: NotificationInteractionAction, kind: InboxInteraction.Kind) -> Bool {
        switch kind {
        case .approval: [.approve, .deny].contains(action)
        case .yesNo: [.yes, .no].contains(action)
        case .text: action == .answer
        }
    }

    public static func actionLabel(_ action: NotificationInteractionAction) -> String {
        switch action {
        case .approve: "approval"
        case .deny: "denial"
        case .yes: "yes"
        case .no: "no"
        case .answer: "reply"
        case .opened: "opened"
        case .received: "received"
        }
    }
}

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

    public static func status(
        phase: LiveActivityResponsePhase,
        action: NotificationInteractionAction,
        confirmedState: String? = nil
    ) -> String {
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
        case .opened: "opened"
        case .received: "received"
        }
    }
}

public struct InboxContext: Codable, Equatable, Sendable {
    public let providerName: String?
    public let producerKind: String?
    public let computer: String?
    public let project: String?
    public let providerThreadId: String?
    public let providerWorkItemId: String?
    public let threadName: String?
    public let taskTitle: String?
    public let threadNameSource: String?
    public let taskTitleSource: String?

    public init(
        providerName: String? = nil,
        producerKind: String? = nil,
        computer: String? = nil,
        project: String? = nil,
        providerThreadId: String? = nil,
        providerWorkItemId: String? = nil,
        threadName: String? = nil,
        taskTitle: String? = nil,
        threadNameSource: String? = nil,
        taskTitleSource: String? = nil
    ) {
        self.providerName = providerName
        self.producerKind = producerKind
        self.computer = computer
        self.project = project
        self.providerThreadId = providerThreadId
        self.providerWorkItemId = providerWorkItemId
        self.threadName = threadName
        self.taskTitle = taskTitle
        self.threadNameSource = threadNameSource
        self.taskTitleSource = taskTitleSource
    }
}

public struct InboxActivitySummary: Codable, Equatable, Sendable {
    public let id: String
    public let originThreadId: String?
    public let conversationId: String?
    public let workItemId: String?
    public let generation: Int
    public let sequence: Int
    public let state: String
    public let title: String
    public let status: String
    public let detail: String?
    public let progress: Double?
    public let terminalReason: String?
    public let context: InboxContext?
    public let createdAt: Date?
    public let updatedAt: Date?
    public let staleAt: Date?
    public let expiresAt: Date?
    public let endedAt: Date?

    public init(
        id: String,
        originThreadId: String? = nil,
        conversationId: String? = nil,
        workItemId: String? = nil,
        generation: Int,
        sequence: Int,
        state: String,
        title: String,
        status: String,
        detail: String? = nil,
        progress: Double? = nil,
        terminalReason: String? = nil,
        context: InboxContext? = nil,
        createdAt: Date? = nil,
        updatedAt: Date? = nil,
        staleAt: Date? = nil,
        expiresAt: Date? = nil,
        endedAt: Date? = nil
    ) {
        self.id = id
        self.originThreadId = originThreadId
        self.conversationId = conversationId
        self.workItemId = workItemId
        self.generation = generation
        self.sequence = sequence
        self.state = state
        self.title = title
        self.status = status
        self.detail = detail
        self.progress = progress
        self.terminalReason = terminalReason
        self.context = context
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.staleAt = staleAt
        self.expiresAt = expiresAt
        self.endedAt = endedAt
    }
}

public struct InboxResourceSource: Codable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let name: String

    public init(id: String, kind: String, name: String) {
        self.id = id
        self.kind = kind
        self.name = name
    }
}

public struct InboxResourceProject: Codable, Equatable, Sendable {
    public struct Palette: Codable, Equatable, Sendable {
        public let slot: Int
        public let generation: Int

        public init(slot: Int, generation: Int) {
            self.slot = slot
            self.generation = generation
        }
    }

    public let id: String
    public let name: String
    public let isDirect: Bool
    public let palette: Palette
    public let icon: String
    public let revision: Int

    public init(id: String, name: String, isDirect: Bool, palette: Palette, icon: String, revision: Int) {
        self.id = id
        self.name = name
        self.isDirect = isDirect
        self.palette = palette
        self.icon = icon
        self.revision = revision
    }
}

public struct InboxResourceLinks: Codable, Equatable, Sendable {
    public let source: InboxResourceSource
    public let project: InboxResourceProject
    public let conversationId: String?
    public let workItemId: String?

    public init(
        source: InboxResourceSource,
        project: InboxResourceProject,
        conversationId: String? = nil,
        workItemId: String? = nil
    ) {
        self.source = source
        self.project = project
        self.conversationId = conversationId
        self.workItemId = workItemId
    }
}

public struct InboxItem: Codable, Equatable, Identifiable, Sendable {
    public struct Content: Codable, Equatable, Sendable {
        public enum Format: String, Codable, Sendable { case text, markdown }
        public let summary: String
        public let body: String
        public let format: Format
        public let byteLength: Int

        public init(summary: String, body: String, format: Format, byteLength: Int) {
            self.summary = summary
            self.body = body
            self.format = format
            self.byteLength = byteLength
        }
    }

    public enum Kind: String, Codable, CaseIterable, Sendable {
        case notification
        case liveActivity = "live_activity"
        case response
    }

    public enum DeliveryState: String, Codable, CaseIterable, Sendable {
        case queued
        case sending
        case acceptedByAPNs = "accepted_by_apns"
        case retryable
        case reconciliationRequired = "reconciliation_required"
        case rejected
        case tokenInvalid = "token_invalid"
    }

    public let id: String
    public let kind: Kind
    public let sourceName: String
    public let sourceImageUrl: URL?
    public let title: String
    public let detail: String?
    public let content: Content?
    public let readAt: Date?
    public let withdrawnAt: Date?
    public let result: String?
    public let deliveryState: DeliveryState?
    public let apnsAcceptedAt: Date?
    public let receivedAt: Date?
    public let openedAt: Date?
    public let createdAt: Date
    public let destinationUrl: URL?
    public let privacy: NotificationPrivacy
    public let liveActivity: LiveActivityCommand?
    public let activitySummary: InboxActivitySummary?
    public let interaction: InboxInteraction?
    public let context: InboxContext?
    public let resources: InboxResourceLinks?

    public init(
        id: String,
        kind: Kind,
        sourceName: String,
        sourceImageUrl: URL? = nil,
        title: String,
        detail: String? = nil,
        content: Content? = nil,
        readAt: Date? = nil,
        withdrawnAt: Date? = nil,
        result: String? = nil,
        deliveryState: DeliveryState? = nil,
        apnsAcceptedAt: Date? = nil,
        receivedAt: Date? = nil,
        openedAt: Date? = nil,
        createdAt: Date,
        destinationUrl: URL? = nil,
        privacy: NotificationPrivacy = .standard,
        liveActivity: LiveActivityCommand? = nil,
        activitySummary: InboxActivitySummary? = nil,
        interaction: InboxInteraction? = nil,
        context: InboxContext? = nil,
        resources: InboxResourceLinks? = nil
    ) {
        self.id = id
        self.kind = kind
        self.sourceName = sourceName
        self.sourceImageUrl = sourceImageUrl
        self.title = title
        self.detail = detail
        self.content = content
        self.readAt = readAt
        self.withdrawnAt = withdrawnAt
        self.result = result
        self.deliveryState = deliveryState
        self.apnsAcceptedAt = apnsAcceptedAt
        self.receivedAt = receivedAt
        self.openedAt = openedAt
        self.createdAt = createdAt
        self.destinationUrl = destinationUrl
        self.privacy = privacy
        self.liveActivity = liveActivity
        self.activitySummary = activitySummary
        self.interaction = interaction
        self.context = context
        self.resources = resources
    }

    public var validatedDestinationURL: URL? {
        destinationUrl.flatMap(NotificationDestinationPolicy.validatedURL)
    }

    public var validatedSourceImageURL: URL? {
        guard privacy == .standard else { return nil }
        return sourceImageUrl.flatMap(NotificationImagePolicy.validatedURL)
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, sourceName, sourceImageUrl, title, detail, content, readAt, withdrawnAt
        case result, deliveryState
        case apnsAcceptedAt, receivedAt, openedAt, createdAt, destinationUrl, privacy
        case liveActivity, activitySummary, interaction, context, resources
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        kind = try values.decode(Kind.self, forKey: .kind)
        sourceName = try values.decode(String.self, forKey: .sourceName)
        sourceImageUrl = try values.decodeIfPresent(URL.self, forKey: .sourceImageUrl)
        title = try values.decode(String.self, forKey: .title)
        detail = try values.decodeIfPresent(String.self, forKey: .detail)
        content = try values.decodeIfPresent(Content.self, forKey: .content)
        readAt = try values.decodeIfPresent(Date.self, forKey: .readAt)
        withdrawnAt = try values.decodeIfPresent(Date.self, forKey: .withdrawnAt)
        result = try values.decodeIfPresent(String.self, forKey: .result)
        deliveryState = try values.decodeIfPresent(DeliveryState.self, forKey: .deliveryState)
        apnsAcceptedAt = try values.decodeIfPresent(Date.self, forKey: .apnsAcceptedAt)
        receivedAt = try values.decodeIfPresent(Date.self, forKey: .receivedAt)
        openedAt = try values.decodeIfPresent(Date.self, forKey: .openedAt)
        createdAt = try values.decode(Date.self, forKey: .createdAt)
        destinationUrl = try values.decodeIfPresent(URL.self, forKey: .destinationUrl)
        privacy = try values.decodeIfPresent(NotificationPrivacy.self, forKey: .privacy) ?? .standard
        liveActivity = try values.decodeIfPresent(LiveActivityCommand.self, forKey: .liveActivity)
        activitySummary = try values.decodeIfPresent(InboxActivitySummary.self, forKey: .activitySummary)
        interaction = try values.decodeIfPresent(InboxInteraction.self, forKey: .interaction)
        context = try values.decodeIfPresent(InboxContext.self, forKey: .context)
        resources = try values.decodeIfPresent(InboxResourceLinks.self, forKey: .resources)
    }
}

public struct DeliveryEvidenceSerialization: Decodable, Equatable, Sendable {
    public let canonicalIntent: String?
    public let deviceProjection: String?
    public let providerBytes: String?
}

public struct DeliveryEvidenceItem: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let notificationId: String
    public let deliveryId: String?
    public let attemptId: String?
    public let deviceId: String?
    public let activityId: String?
    public let stage: String
    public let stageOrder: Int
    public let state: String
    public let detailCode: String?
    public let serialization: DeliveryEvidenceSerialization?
    public let occurredAt: Date
}

public struct DeliveryEvidenceResponse: Decodable, Equatable, Sendable {
    public let version: Int
    public let order: String
    public let items: [DeliveryEvidenceItem]
    public let cursor: String?
    public let hasMore: Bool
}

public struct InboxNotificationDetail: Decodable, Equatable, Sendable {
    public struct Evidence: Decodable, Equatable, Sendable {
        public struct Delivery: Decodable, Equatable, Sendable {
            public let id: String
            public let deviceId: String?
            public let transport: String
            public let state: String
            public let attemptCount: Int
            public let providerOutcome: String?
            public let errorCode: String?
            public let acceptedAt: Date?
            public let createdAt: Date
            public let updatedAt: Date
        }

        public struct Interaction: Decodable, Equatable, Sendable {
            public let kind: String
            public let createdAt: Date
        }

        public struct Withdrawal: Decodable, Equatable, Sendable {
            public let deviceId: String?
            public let outcome: String
            public let detailCode: String?
            public let createdAt: Date
        }

        public let version: Int
        public let timeline: [DeliveryEvidenceItem]
        public let deliveries: [Delivery]
        public let interactions: [Interaction]
        public let withdrawals: [Withdrawal]

        private enum CodingKeys: String, CodingKey {
            case version, timeline, deliveries, interactions, withdrawals
        }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            version = try values.decodeIfPresent(Int.self, forKey: .version) ?? 1
            timeline = try values.decodeIfPresent([DeliveryEvidenceItem].self, forKey: .timeline) ?? []
            deliveries = try values.decode([Delivery].self, forKey: .deliveries)
            interactions = try values.decode([Interaction].self, forKey: .interactions)
            withdrawals = try values.decode([Withdrawal].self, forKey: .withdrawals)
        }
    }

    public let item: InboxItem
    public let evidence: Evidence
}

public enum NotificationDestinationPolicy {
    public static func validatedURL(_ url: URL) -> URL? {
        guard
            url.scheme?.lowercased() == "https",
            url.user == nil,
            url.password == nil,
            let host = url.host,
            !host.isEmpty
        else { return nil }
        return url
    }

    public static func validatedURL(_ value: String) -> URL? {
        URL(string: value).flatMap(validatedURL)
    }
}

public enum NotificationImagePolicy {
    public static func validatedURL(_ url: URL) -> URL? {
        guard
            url.absoluteString.utf8.count <= 2_048,
            url.scheme?.lowercased() == "https",
            url.user == nil,
            url.password == nil,
            let host = url.host,
            isPublicHost(host)
        else { return nil }
        return url
    }

    public static func validatedURL(_ value: String) -> URL? {
        URL(string: value).flatMap(validatedURL)
    }

    private static func isPublicHost(_ value: String) -> Bool {
        let host = value.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        guard
            !host.isEmpty,
            !host.hasSuffix("."),
            (host.contains(".") || host.contains(":")),
            host != "localhost",
            !host.hasSuffix(".localhost"),
            !host.hasSuffix(".local"),
            !host.hasSuffix(".internal"),
            !host.hasSuffix(".home"),
            !host.hasSuffix(".lan")
        else { return false }

        if let address = parsedIPv4(host) {
            let canonical = address.map(String.init).joined(separator: ".")
            guard host == canonical else { return false }
            return isPublicIPv4(address)
        }

        guard host.contains(":") else { return true }
        var address = in6_addr()
        guard inet_pton(AF_INET6, host, &address) == 1 else { return false }
        let bytes = withUnsafeBytes(of: &address) { Array($0) }
        let isIPv4Mapped = bytes.prefix(10).allSatisfy { $0 == 0 }
            && bytes[10] == 0xff && bytes[11] == 0xff
        let isIPv4Compatible = bytes.prefix(12).allSatisfy { $0 == 0 }
        return !(
            bytes.allSatisfy { $0 == 0 }
                || bytes == Array(repeating: 0, count: 15) + [1]
                || (bytes[0] & 0xfe) == 0xfc
                || (bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80)
                || bytes[0] == 0xff
                || Array(bytes.prefix(4)) == [0x20, 0x01, 0x0d, 0xb8]
                || isIPv4Mapped
                || isIPv4Compatible
        )
    }

    private static func parsedIPv4(_ host: String) -> [UInt8]? {
        let components = host.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...4).contains(components.count) else { return nil }
        var values: [UInt64] = []
        for component in components {
            let text = String(component).lowercased()
            let radix: Int
            let digits: Substring
            if text.hasPrefix("0x") {
                radix = 16
                digits = text.dropFirst(2)
            } else if text.count > 1 && text.hasPrefix("0") {
                radix = 8
                digits = text.dropFirst()
            } else {
                radix = 10
                digits = Substring(text)
            }
            guard !digits.isEmpty, let value = UInt64(digits, radix: radix) else { return nil }
            values.append(value)
        }

        let packed: UInt64
        switch values.count {
        case 1 where values[0] <= 0xffff_ffff:
            packed = values[0]
        case 2 where values[0] <= 0xff && values[1] <= 0xff_ffff:
            packed = (values[0] << 24) | values[1]
        case 3 where values[0] <= 0xff && values[1] <= 0xff && values[2] <= 0xffff:
            packed = (values[0] << 24) | (values[1] << 16) | values[2]
        case 4 where values.allSatisfy({ $0 <= 0xff }):
            packed = (values[0] << 24) | (values[1] << 16) | (values[2] << 8) | values[3]
        default:
            return nil
        }
        return [24, 16, 8, 0].map { UInt8((packed >> UInt64($0)) & 0xff) }
    }

    private static func isPublicIPv4(_ address: [UInt8]) -> Bool {
        let first = Int(address[0])
        let second = Int(address[1])
        let third = Int(address[2])
        return !(
            first == 0 || first == 10 || first == 127
                || (first == 169 && second == 254)
                || (first == 172 && (16...31).contains(second))
                || (first == 192 && second == 168)
                || (first == 100 && (64...127).contains(second))
                || (first == 192 && second == 0)
                || (first == 198 && (second == 18 || second == 19))
                || (first == 198 && second == 51 && third == 100)
                || (first == 203 && second == 0 && third == 113)
                || first >= 224
        )
    }
}

public enum DeviceRegistrationPhase: Equatable, Sendable {
    case idle
    case waitingForPermission
    case waitingForAPNSToken
    case registering
    case registered
    case failed(String)
}

public struct APNSTokenSessionState: Equatable, Sendable {
    public let cachedTokenAvailable: Bool
    public let currentSessionTokenAvailable: Bool

    public init(
        cachedTokenAvailable: Bool = false,
        currentSessionTokenAvailable: Bool = false
    ) {
        self.cachedTokenAvailable = cachedTokenAvailable
        self.currentSessionTokenAvailable = currentSessionTokenAvailable
    }

    public static func restored(cachedTokenAvailable: Bool) -> APNSTokenSessionState {
        APNSTokenSessionState(
            cachedTokenAvailable: cachedTokenAvailable,
            currentSessionTokenAvailable: false
        )
    }

    public func receivingCurrentToken(persistedTokenAvailable: Bool) -> APNSTokenSessionState {
        APNSTokenSessionState(
            cachedTokenAvailable: persistedTokenAvailable,
            currentSessionTokenAvailable: persistedTokenAvailable
        )
    }

    public func registrationFailed(cachedTokenAvailable: Bool) -> APNSTokenSessionState {
        APNSTokenSessionState(
            cachedTokenAvailable: cachedTokenAvailable,
            currentSessionTokenAvailable: false
        )
    }

    public func retryingRegistration() -> APNSTokenSessionState {
        APNSTokenSessionState(
            cachedTokenAvailable: cachedTokenAvailable,
            currentSessionTokenAvailable: false
        )
    }
}

public enum DeviceRegistrationPolicy {
    public static func prerequisitePhase(
        hasAuthenticatedAccount: Bool,
        permissionAllowed: Bool,
        apnsTokenAvailable: Bool,
        pushRegistrationFailed: Bool
    ) -> DeviceRegistrationPhase? {
        guard hasAuthenticatedAccount else { return .idle }
        guard permissionAllowed else { return .waitingForPermission }
        guard !pushRegistrationFailed else {
            return .failed("Apple Push registration failed. Retry to request a fresh device token.")
        }
        guard apnsTokenAvailable else { return .waitingForAPNSToken }
        return nil
    }
}

public enum InboxHistoryProjection {
    public static let pageSize = 50

    public static func collapsedActivities(_ items: [InboxItem]) -> [InboxItem] {
        var ordinary: [InboxItem] = []
        var activities: [String: InboxItem] = [:]
        for item in items {
            guard item.kind == .liveActivity else {
                ordinary.append(item)
                continue
            }
            guard let activityID = item.activitySummary?.id ?? item.liveActivity?.activityId else {
                ordinary.append(item)
                continue
            }
            guard let current = activities[activityID] else {
                activities[activityID] = item
                continue
            }
            let currentSequence = current.activitySummary?.sequence ?? current.liveActivity?.sequence ?? -1
            let candidateSequence = item.activitySummary?.sequence ?? item.liveActivity?.sequence ?? -1
            if candidateSequence > currentSequence
                || (candidateSequence == currentSequence && item.createdAt > current.createdAt) {
                activities[activityID] = item
            }
        }
        return (ordinary + activities.values).sorted { left, right in
            let leftDate = left.activitySummary?.updatedAt ?? left.createdAt
            let rightDate = right.activitySummary?.updatedAt ?? right.createdAt
            if leftDate != rightDate { return leftDate > rightDate }
            return left.id > right.id
        }
    }

    public static func activeActivities(
        _ items: [InboxItem],
        now: Date = .now
    ) -> [InboxItem] {
        collapsedActivities(items).filter { item in
            if let summary = item.activitySummary {
                guard summary.state == "active" else { return false }
                if let staleAt = summary.staleAt, staleAt <= now { return false }
                if let expiresAt = summary.expiresAt, expiresAt <= now { return false }
                return true
            }
            guard let command = item.liveActivity, command.operation != .end else { return false }
            if let staleAt = command.staleAt, staleAt <= now { return false }
            if let expiresAt = command.expiresAt, expiresAt <= now { return false }
            return true
        }
    }

    public static func nextVisibleLimit(current: Int, available: Int) -> Int {
        min(available, max(pageSize, current + pageSize))
    }

    public static func matchesSearch(_ item: InboxItem, query: String) -> Bool {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return true }
        return [
            item.sourceName,
            item.title,
            item.detail,
            item.result,
            item.context?.providerName,
            item.context?.computer,
            item.context?.project,
            item.context?.threadName,
            item.context?.taskTitle,
            item.activitySummary?.title,
            item.activitySummary?.status,
            item.activitySummary?.detail,
            item.activitySummary?.context?.project,
            item.activitySummary?.context?.threadName,
            item.activitySummary?.context?.taskTitle,
        ]
        .compactMap { $0 }
        .contains { $0.localizedCaseInsensitiveContains(normalized) }
    }
}

public struct InboxHistoryPresentationState: Equatable, Sendable {
    public var searchQuery: String
    public var filterIdentifier: String
    public private(set) var visibleLimit: Int
    public private(set) var scopeIdentity: String?
    private let defaultFilterIdentifier: String

    public init(defaultFilterIdentifier: String) {
        self.searchQuery = ""
        self.filterIdentifier = defaultFilterIdentifier
        self.visibleLimit = InboxHistoryProjection.pageSize
        self.scopeIdentity = nil
        self.defaultFilterIdentifier = defaultFilterIdentifier
    }

    public mutating func transition(to scopeIdentity: String) {
        guard self.scopeIdentity != scopeIdentity else { return }
        self.scopeIdentity = scopeIdentity
        searchQuery = ""
        filterIdentifier = defaultFilterIdentifier
        visibleLimit = InboxHistoryProjection.pageSize
    }

    public mutating func resetPagination() {
        visibleLimit = InboxHistoryProjection.pageSize
    }

    public mutating func showMore(available: Int) {
        visibleLimit = InboxHistoryProjection.nextVisibleLimit(
            current: visibleLimit,
            available: available
        )
    }
}

public enum InboxHistoryRetention {
    /// Relo server remains authoritative. The iPhone keeps a bounded, protected
    /// offline projection so large accounts cannot grow local storage forever.
    public static let maximumStoredItems = 250

    public static func retainingNewest(_ items: [InboxItem]) -> [InboxItem] {
        var byID: [String: InboxItem] = [:]
        for item in items {
            byID[item.id] = item
        }
        return Array(byID.values.sorted {
            if $0.createdAt == $1.createdAt { return $0.id > $1.id }
            return $0.createdAt > $1.createdAt
        }.prefix(maximumStoredItems))
    }

    public static func retainingNewest(in snapshot: InboxSnapshot) -> InboxSnapshot {
        var retained = snapshot
        retained.items = retainingNewest(snapshot.items)
        return retained
    }
}

public enum InboxBadgeProjection {
    /// The icon badge represents unanswered, unexpired requests rather than total history.
    public static func pendingInteractionCount(
        in items: [InboxItem],
        now: Date = .now
    ) -> Int {
        items.reduce(into: 0) { count, item in
            guard
                let interaction = item.interaction,
                interaction.state == .pending,
                interaction.expiresAt > now
            else { return }
            count += 1
        }
    }
}

public enum DeviceReadinessPolicy {
    public static func isReady(
        permissionAllowed: Bool,
        deviceRegistered: Bool,
        apnsTokenAvailable: Bool,
        serverAcceptedCurrentAPNSToken: Bool,
        hasPushRegistrationError: Bool,
        liveActivitiesAuthorized: Bool,
        liveActivityPushToStartTokenAvailable: Bool,
        syncCurrent: Bool
    ) -> Bool {
        permissionAllowed
            && deviceRegistered
            && apnsTokenAvailable
            && serverAcceptedCurrentAPNSToken
            && !hasPushRegistrationError
            && liveActivitiesAuthorized
            && liveActivityPushToStartTokenAvailable
            && syncCurrent
    }
}

public enum DeviceHealthSeverity: Equatable, Sendable {
    case normal
    case checking
    case degraded
    case actionRequired
}

public struct DeviceHealthStatus: Equatable, Sendable {
    public let label: String
    public let detail: String?
    public let severity: DeviceHealthSeverity

    public init(label: String, detail: String? = nil, severity: DeviceHealthSeverity) {
        self.label = label
        self.detail = detail
        self.severity = severity
    }
}

public struct DeviceHealthSnapshot: Equatable, Sendable {
    public let readiness: DeviceHealthStatus
    public let notifications: DeviceHealthStatus
    public let registration: DeviceHealthStatus
    public let liveActivities: DeviceHealthStatus
    public let inboxSync: DeviceHealthStatus
    public let deliveryPath: DeviceHealthStatus
}

public enum DeviceNotificationPermissionHealth: Equatable, Sendable {
    case unknown
    case allowed
    case denied
}

public enum DeviceInboxHealth: Equatable, Sendable {
    case idle
    case syncing
    case current
    case offline(String)
}

public enum DeviceHealthProjection {
    public static func project(
        accountNeedsAttention: Bool,
        notificationPermission: DeviceNotificationPermissionHealth,
        registration: DeviceRegistrationPhase,
        deviceCredentialPresent: Bool,
        apnsTokenAvailable: Bool,
        serverAcceptedCurrentAPNSToken: Bool,
        hasPushRegistrationError: Bool,
        liveActivitiesAuthorized: Bool,
        liveActivityPushToStartTokenAvailable: Bool,
        activeLiveActivityCount: Int,
        inbox: DeviceInboxHealth,
        hasCachedActivity: Bool,
        deliveryTransportStatus: DeliveryTransportStatus?,
        deliveryTransportError: String?
    ) -> DeviceHealthSnapshot {
        let notifications = switch notificationPermission {
        case .allowed:
            DeviceHealthStatus(label: "Allowed", severity: .normal)
        case .denied:
            DeviceHealthStatus(label: "Off", severity: .actionRequired)
        case .unknown:
            DeviceHealthStatus(label: "Permission needed", severity: .actionRequired)
        }
        let registrationStatus = registrationStatus(
            phase: registration,
            apnsTokenAvailable: apnsTokenAvailable,
            serverAcceptedCurrentAPNSToken: serverAcceptedCurrentAPNSToken,
            hasPushRegistrationError: hasPushRegistrationError
        )
        let liveActivityStatus = liveActivityStatus(
            authorized: liveActivitiesAuthorized,
            pushToStartTokenAvailable: liveActivityPushToStartTokenAvailable,
            activeCount: activeLiveActivityCount
        )
        let inboxStatus = inboxStatus(inbox)
        let deliveryStatus = deliveryStatus(
            deliveryTransportStatus,
            error: deliveryTransportError
        )
        let ready = DeviceReadinessPolicy.isReady(
            permissionAllowed: notificationPermission == .allowed,
            deviceRegistered: deviceCredentialPresent && registration == .registered,
            apnsTokenAvailable: apnsTokenAvailable,
            serverAcceptedCurrentAPNSToken: serverAcceptedCurrentAPNSToken,
            hasPushRegistrationError: hasPushRegistrationError,
            liveActivitiesAuthorized: liveActivitiesAuthorized,
            liveActivityPushToStartTokenAvailable: liveActivityPushToStartTokenAvailable,
            syncCurrent: inbox == .current
        )
        let readiness: DeviceHealthStatus
        if accountNeedsAttention
            || notificationPermission != .allowed
            || registrationStatus.severity == .actionRequired
            || liveActivityStatus.severity == .actionRequired {
            readiness = DeviceHealthStatus(label: "Needs attention", severity: .actionRequired)
        } else if case .offline = inbox, hasCachedActivity {
            readiness = DeviceHealthStatus(
                label: "Offline",
                detail: "Recent activity remains available on this iPhone.",
                severity: .degraded
            )
        } else if ready || (inbox == .syncing && hasCachedActivity && DeviceReadinessPolicy.isReady(
            permissionAllowed: notificationPermission == .allowed,
            deviceRegistered: deviceCredentialPresent && registration == .registered,
            apnsTokenAvailable: apnsTokenAvailable,
            serverAcceptedCurrentAPNSToken: serverAcceptedCurrentAPNSToken,
            hasPushRegistrationError: hasPushRegistrationError,
            liveActivitiesAuthorized: liveActivitiesAuthorized,
            liveActivityPushToStartTokenAvailable: liveActivityPushToStartTokenAvailable,
            syncCurrent: true
        )) {
            readiness = DeviceHealthStatus(label: "Ready", severity: .normal)
        } else if registration == .registering || inbox == .syncing {
            readiness = DeviceHealthStatus(label: "Checking", severity: .checking)
        } else {
            readiness = DeviceHealthStatus(label: "Setting up", severity: .checking)
        }
        return DeviceHealthSnapshot(
            readiness: readiness,
            notifications: notifications,
            registration: registrationStatus,
            liveActivities: liveActivityStatus,
            inboxSync: inboxStatus,
            deliveryPath: deliveryStatus
        )
    }

    private static func liveActivityStatus(
        authorized: Bool,
        pushToStartTokenAvailable: Bool,
        activeCount: Int
    ) -> DeviceHealthStatus {
        guard authorized else {
            return DeviceHealthStatus(
                label: "Unavailable",
                detail: "Enable Live Activities in iPhone settings.",
                severity: .actionRequired
            )
        }
        guard pushToStartTokenAvailable else {
            return DeviceHealthStatus(
                label: "Awaiting start token",
                detail: "Apple has not issued the remote Live Activity start token yet.",
                severity: .checking
            )
        }
        let countLabel = activeCount == 1 ? "1 active" : "\(activeCount) active"
        return DeviceHealthStatus(
            label: "Ready",
            detail: countLabel,
            severity: .normal
        )
    }

    private static func registrationStatus(
        phase: DeviceRegistrationPhase,
        apnsTokenAvailable: Bool,
        serverAcceptedCurrentAPNSToken: Bool,
        hasPushRegistrationError: Bool
    ) -> DeviceHealthStatus {
        switch phase {
        case .registered where apnsTokenAvailable
            && serverAcceptedCurrentAPNSToken
            && !hasPushRegistrationError:
            DeviceHealthStatus(label: "Registered", severity: .normal)
        case .registered:
            DeviceHealthStatus(label: "Confirming Apple Push", severity: .checking)
        case .registering:
            DeviceHealthStatus(label: "Registering", severity: .checking)
        case .waitingForPermission:
            DeviceHealthStatus(label: "Notification permission needed", severity: .actionRequired)
        case .waitingForAPNSToken:
            DeviceHealthStatus(label: "Waiting for Apple Push", severity: .checking)
        case .failed(let message):
            DeviceHealthStatus(label: "Needs attention", detail: message, severity: .actionRequired)
        case .idle:
            DeviceHealthStatus(label: "Waiting", severity: .checking)
        }
    }

    private static func inboxStatus(_ inbox: DeviceInboxHealth) -> DeviceHealthStatus {
        switch inbox {
        case .idle:
            DeviceHealthStatus(label: "Waiting", severity: .checking)
        case .syncing:
            DeviceHealthStatus(label: "Syncing", severity: .checking)
        case .current:
            DeviceHealthStatus(label: "Current", severity: .normal)
        case .offline(let detail):
            DeviceHealthStatus(label: "Offline", detail: detail, severity: .degraded)
        }
    }

    private static func deliveryStatus(
        _ status: DeliveryTransportStatus?,
        error: String?
    ) -> DeviceHealthStatus {
        guard let apns = status?.apns else {
            return error.map {
                DeviceHealthStatus(label: "Unavailable", detail: $0, severity: .degraded)
            } ?? DeviceHealthStatus(label: "Checking", severity: .checking)
        }
        let label: String
        let detail: String
        let severity: DeviceHealthSeverity
        if apns.deliverySemantics == .durableInboxRefreshOnly {
            label = "Inbox sync only"
            detail = "Live Activities synchronize while Relo is open. Background arrival requires direct ActivityKit APNs."
            severity = .degraded
        } else if apns.providerCredentialActive == false {
            label = "APNs credentials inactive"
            detail = "Relo server cannot authenticate with Apple Push. Inbox synchronization remains available while Relo is open."
            severity = .degraded
        } else {
            label = apns.directDeliveryConfigured ? "Direct Apple Push" : "Direct APNs unavailable"
            detail = "Relo server can enqueue direct Apple Push. Apple acceptance does not confirm that this iPhone applied the event."
            severity = apns.directDeliveryConfigured ? .normal : .degraded
        }
        return DeviceHealthStatus(
            label: label,
            detail: error.map { "\($0) Showing the last known delivery path. \(detail)" } ?? detail,
            severity: error == nil ? severity : .degraded
        )
    }
}

public enum NotificationReplyPolicy {
    public static let maximumUTF16CodeUnits = 4_000
    public static let validationMessage = "Enter a response between 1 and 4,000 characters."

    public static func normalized(_ text: String?) -> String? {
        text?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func isValid(_ text: String?) -> Bool {
        (1...maximumUTF16CodeUnits).contains(utf16Count(text))
    }

    public static func utf16Count(_ text: String?) -> Int {
        normalized(text)?.utf16.count ?? 0
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

public enum NotificationRouteResolver {
    public static func contains(notificationID: String, in items: [InboxItem]) -> Bool {
        items.contains { $0.id == notificationID }
    }
}

public enum NotificationReceiptScopePolicy {
    public static func eligible(
        pendingNotificationIDs: [String],
        authoritativeNotificationIDs: Set<String>
    ) -> [String] {
        var seen = Set<String>()
        return pendingNotificationIDs.filter {
            authoritativeNotificationIDs.contains($0) && seen.insert($0).inserted
        }
    }
}

public enum InboxRefreshPolicy {
    /// Pushes and scene activation are the primary triggers. While the app is active, this
    /// bounded cadence closes disabled/unavailable APNs gaps without one-second battery polling.
    public static let foregroundFallbackSeconds: Int64 = 15

    public static func foregroundDelaySeconds(
        afterAttempt attempt: Int,
        directPushAvailable: Bool? = nil
    ) -> Int64 {
        let delays: [Int64] = switch directPushAvailable {
        case false: [2, 3, 5, 8, 10]
        case true: [30, 60]
        case nil: [2, 3, 5, 8, 13, foregroundFallbackSeconds]
        }
        return delays[min(max(0, attempt), delays.count - 1)]
    }
}

public enum LiveActivityCommandOrderingDecision: Equatable, Sendable {
    case apply
    case stale
    case conflict
}

public enum LiveActivityCommandOrderingPolicy {
    public static let maximumFutureSkew: TimeInterval = 300

    public static func evaluate(
        operation: LiveActivityCommand.Operation,
        incomingSequence: Int,
        incomingTimestamp: Date,
        expiresAt: Date?,
        observedSequence: Int,
        observedTimestamp: Date,
        now: Date
    ) -> LiveActivityCommandOrderingDecision {
        guard incomingSequence >= 0,
              incomingTimestamp.timeIntervalSince1970 >= 0,
              incomingTimestamp <= now.addingTimeInterval(maximumFutureSkew)
        else { return .conflict }
        if operation != .end, let expiresAt, expiresAt <= now { return .stale }
        if incomingSequence < observedSequence { return .stale }
        if incomingSequence == observedSequence { return .conflict }
        if incomingTimestamp < observedTimestamp { return .stale }
        return .apply
    }

    public static func permitsInitialStart(
        sequence: Int,
        timestamp: Date,
        expiresAt: Date?,
        now: Date
    ) -> Bool {
        guard sequence >= 0,
              timestamp.timeIntervalSince1970 >= 0,
              timestamp <= now.addingTimeInterval(maximumFutureSkew)
        else { return false }
        return expiresAt.map { $0 > now } ?? true
    }
}

public enum ReloIdentifier {
    public static func isValid(_ value: String) -> Bool {
        guard (1...200).contains(value.count) else { return false }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
        return value.unicodeScalars.allSatisfy(allowed.contains)
    }
}

public protocol PendingNotificationReceiptStoring: Sendable {
    func pending(limit: Int) -> [String]
    func remove(notificationIDs: Set<String>)
}

public struct UserDefaultsPendingNotificationReceiptStore: PendingNotificationReceiptStoring, @unchecked Sendable {
    private let defaults: UserDefaults?
    private let key: String
    private let maximumStored: Int

    public init(
        suiteName: String,
        key: String = "pending-receipts",
        maximumStored: Int = 200
    ) {
        self.defaults = UserDefaults(suiteName: suiteName)
        self.key = key
        self.maximumStored = maximumStored
    }

    public func pending(limit: Int) -> [String] {
        guard limit > 0 else { return [] }
        var seen = Set<String>()
        let identifiers = (defaults?.stringArray(forKey: key) ?? []).filter {
            ReloIdentifier.isValid($0) && seen.insert($0).inserted
        }
        return Array(identifiers.prefix(limit))
    }

    public func remove(notificationIDs: Set<String>) {
        guard !notificationIDs.isEmpty, let defaults else { return }
        let current = defaults.stringArray(forKey: key) ?? []
        let remaining = current.filter { !notificationIDs.contains($0) }
        defaults.set(Array(remaining.suffix(maximumStored)), forKey: key)
    }
}

public struct FilePendingNotificationReceiptStore: PendingNotificationReceiptStoring, @unchecked Sendable {
    private let fileURL: URL
    private let lockURL: URL
    private let maximumStored: Int

    public init(
        baseDirectory: URL,
        filename: String = "pending-notification-receipts.json",
        maximumStored: Int = 200
    ) {
        fileURL = baseDirectory.appendingPathComponent(filename)
        lockURL = baseDirectory.appendingPathComponent("\(filename).lock")
        self.maximumStored = maximumStored
        try? FileManager.default.createDirectory(
            at: baseDirectory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
    }

    public func add(notificationID: String) {
        guard ReloIdentifier.isValid(notificationID) else { return }
        withExclusiveLock {
            var identifiers = readUnlocked()
            identifiers.removeAll { $0 == notificationID }
            identifiers.append(notificationID)
            writeUnlocked(Array(identifiers.suffix(maximumStored)))
        }
    }

    public func pending(limit: Int) -> [String] {
        guard limit > 0 else { return [] }
        return withExclusiveLock(fallback: []) {
            var seen = Set<String>()
            let identifiers = readUnlocked().filter {
                ReloIdentifier.isValid($0) && seen.insert($0).inserted
            }
            return Array(identifiers.prefix(limit))
        }
    }

    public func remove(notificationIDs: Set<String>) {
        guard !notificationIDs.isEmpty else { return }
        withExclusiveLock {
            let remaining = readUnlocked().filter { !notificationIDs.contains($0) }
            writeUnlocked(Array(remaining.suffix(maximumStored)))
        }
    }

    private func readUnlocked() -> [String] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        return (try? VersionedStorageCodec.decode(
            [String].self,
            from: data,
            schemaVersion: LocalStoreSchema.pendingNotificationReceipts
        ).payload) ?? []
    }

    private func writeUnlocked(_ identifiers: [String]) {
        guard let data = try? VersionedStorageCodec.encode(
            identifiers,
            schemaVersion: LocalStoreSchema.pendingNotificationReceipts
        ) else { return }
        try? data.write(to: fileURL, options: ReloProtectedFileWritingOptions.afterFirstUnlock)
    }

    private func withExclusiveLock<T>(fallback: T, _ body: () -> T) -> T {
        let descriptor = Darwin.open(lockURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { return fallback }
        defer { Darwin.close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else { return fallback }
        defer { flock(descriptor, LOCK_UN) }
        return body()
    }

    private func withExclusiveLock(_ body: () -> Void) {
        withExclusiveLock(fallback: (), body)
    }
}

public enum ReloDeepLink {
    public static func activityURL(identity: LiveActivityIdentity) -> URL? {
        guard identity.isValid else { return nil }
        var components = URLComponents()
        components.scheme = "relo"
        components.host = "activity"
        components.path = "/\(identity.activityID)"
        components.queryItems = [URLQueryItem(name: "generation", value: String(identity.generation))]
        return components.url
    }

    public static func activityIdentity(from url: URL) -> LiveActivityIdentity? {
        guard
            url.scheme?.lowercased() == "relo",
            url.host?.lowercased() == "activity",
            url.user == nil,
            url.password == nil,
            url.fragment == nil,
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let queryItems = components.queryItems,
            queryItems.count == 1,
            queryItems[0].name == "generation",
            let generationValue = queryItems[0].value,
            let generation = Int(generationValue),
            generation > 0
        else { return nil }
        let pathComponents = url.pathComponents.filter { $0 != "/" }
        guard
            pathComponents.count == 1,
            let activityID = pathComponents.first
        else { return nil }
        let identity = LiveActivityIdentity(activityID: activityID, generation: generation)
        return identity.isValid ? identity : nil
    }

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

public struct InboxSnapshot: Codable, Equatable, Sendable {
    public var items: [InboxItem]
    public var cursor: String?
    public var lastSuccessfulSyncAt: Date?
    public var readWatermark: String?
    public var unread: InboxUnreadSummary?

    public init(
        items: [InboxItem] = [],
        cursor: String? = nil,
        lastSuccessfulSyncAt: Date? = nil,
        readWatermark: String? = nil,
        unread: InboxUnreadSummary? = nil
    ) {
        self.items = items
        self.cursor = cursor
        self.lastSuccessfulSyncAt = lastSuccessfulSyncAt
        self.readWatermark = readWatermark
        self.unread = unread
    }
}

public struct InboxPage: Codable, Equatable, Sendable {
    public let items: [InboxItem]
    public let cursor: String?
    public let hasMore: Bool
    public let serverTime: Date
    public let readWatermark: String?
    public let unread: InboxUnreadSummary?

    public init(
        items: [InboxItem],
        cursor: String?,
        hasMore: Bool,
        serverTime: Date,
        readWatermark: String? = nil,
        unread: InboxUnreadSummary? = nil
    ) {
        self.items = items
        self.cursor = cursor
        self.hasMore = hasMore
        self.serverTime = serverTime
        self.readWatermark = readWatermark
        self.unread = unread
    }
}

public struct InboxHistoryPage: Codable, Equatable, Sendable {
    public static let maximumItems = 100
    public let items: [InboxItem]
    public let cursor: String?
    public let hasMore: Bool
    public let total: Int
    public let serverTime: Date
    public let readWatermark: String?
    public let unread: InboxUnreadSummary?

    public init(
        items: [InboxItem],
        cursor: String?,
        hasMore: Bool,
        total: Int,
        serverTime: Date,
        readWatermark: String? = nil,
        unread: InboxUnreadSummary? = nil
    ) {
        self.items = items
        self.cursor = cursor
        self.hasMore = hasMore
        self.total = total
        self.serverTime = serverTime
        self.readWatermark = readWatermark
        self.unread = unread
    }
}

public struct InboxUnreadSummary: Codable, Equatable, Sendable {
    public let account: Int
    public let projects: [String: Int]

    public init(account: Int, projects: [String: Int]) {
        self.account = account
        self.projects = projects
    }
}

public enum InboxHistoryPagePolicy {
    public static func isValid(
        _ page: InboxHistoryPage,
        requestedCursor: String?
    ) -> Bool {
        guard
            page.items.count <= InboxHistoryPage.maximumItems,
            Set(page.items.map(\.id)).count == page.items.count,
            page.total >= page.items.count,
            page.hasMore == (page.cursor != nil),
            isNewestFirst(page.items)
        else { return false }

        if page.hasMore {
            guard
                page.items.count == InboxHistoryPage.maximumItems,
                page.total > page.items.count,
                page.cursor?.isEmpty == false,
                page.cursor != requestedCursor
            else { return false }
        }

        if requestedCursor == nil {
            return page.hasMore || page.total == page.items.count
        }
        return page.total > 0
    }

    public static func isValidContinuation(
        _ page: InboxHistoryPage,
        after snapshot: InboxHistorySnapshot,
        requestedCursor: String
    ) -> Bool {
        guard
            isValid(page, requestedCursor: requestedCursor),
            snapshot.source == .server,
            snapshot.cursor == requestedCursor,
            let expectedTotal = snapshot.total,
            expectedTotal >= snapshot.items.count,
            page.total >= expectedTotal
        else { return false }

        let existingIDs = Set(snapshot.items.map(\.id))
        guard page.items.allSatisfy({ !existingIDs.contains($0.id) }) else { return false }

        if let oldestLoaded = snapshot.items.last, let nextItem = page.items.first {
            guard sortsBefore(oldestLoaded, nextItem) else { return false }
        }

        let accumulatedCount = snapshot.items.count + page.items.count
        return page.hasMore
            ? accumulatedCount < expectedTotal
            : accumulatedCount == expectedTotal
    }

    private static func isNewestFirst(_ items: [InboxItem]) -> Bool {
        zip(items, items.dropFirst()).allSatisfy(sortsBefore)
    }

    private static func sortsBefore(_ newer: InboxItem, _ older: InboxItem) -> Bool {
        if newer.createdAt == older.createdAt { return newer.id > older.id }
        return newer.createdAt > older.createdAt
    }
}

public struct InboxHistorySnapshot: Equatable, Sendable {
    public enum Source: Equatable, Sendable {
        case offlineCache
        case server
    }

    public let items: [InboxItem]
    public let cursor: String?
    public let hasMore: Bool
    public let total: Int?
    public let source: Source

    public init(
        items: [InboxItem],
        cursor: String?,
        hasMore: Bool,
        total: Int?,
        source: Source
    ) {
        self.items = items
        self.cursor = cursor
        self.hasMore = hasMore
        self.total = total
        self.source = source
    }

    public static func offlineCache(items: [InboxItem]) -> InboxHistorySnapshot {
        InboxHistorySnapshot(
            items: InboxHistoryRetention.retainingNewest(items),
            cursor: nil,
            hasMore: false,
            total: nil,
            source: .offlineCache
        )
    }
}

public enum InboxHistoryRefreshPolicy {
    public static func visibleSnapshot(
        current: InboxHistorySnapshot,
        refreshedCacheItems: [InboxItem]
    ) -> InboxHistorySnapshot {
        current.source == .server
            ? current
            : .offlineCache(items: refreshedCacheItems)
    }
}

public struct InboxSelectedItemSnapshot: Equatable, Sendable {
    public private(set) var item: InboxItem?
    public private(set) var scopeIdentity: String?

    public init(item: InboxItem? = nil, scopeIdentity: String? = nil) {
        self.item = item
        self.scopeIdentity = scopeIdentity
    }

    public mutating func select(_ item: InboxItem, scopeIdentity: String) {
        self.item = item
        self.scopeIdentity = scopeIdentity
    }

    public mutating func reconcile(scopeIdentity: String, availableItems: [InboxItem]) {
        guard self.scopeIdentity == scopeIdentity else {
            dismiss()
            return
        }
        guard let selectedID = item?.id else { return }
        if let refreshed = availableItems.first(where: { $0.id == selectedID }) {
            item = refreshed
        }
        // A selected arbitrary-age item may not be present in page one or the
        // bounded offline projection. Retain it until explicit dismissal.
    }

    public mutating func dismiss() {
        item = nil
        scopeIdentity = nil
    }
}

public enum InboxRemoteError: Error, Equatable, Sendable {
    case cursorExpired
    case unauthorized
    case tailnetUnavailable
    case incompatibleResponse
    case unavailable
}

public enum InboxRefreshErrorGuidance {
    public static func message(for error: any Error) -> String {
        switch error as? InboxRemoteError {
        case .tailnetUnavailable:
            "Tailnet unavailable"
        case .incompatibleResponse:
            "Relo server returned incompatible activity data"
        case .unavailable, .cursorExpired:
            "Relo server Inbox service unavailable"
        case .unauthorized:
            "This iPhone must be registered again"
        case nil:
            "Local Inbox cache could not be read or saved"
        }
    }
}

public protocol InboxRemoteDataSource: Sendable {
    func fetchPage(after cursor: String?) async throws -> InboxPage
}

public struct InboxReadMutationResponse: Codable, Equatable, Sendable {
    public let changed: Int
    public let readAt: Date?
    public let readWatermark: String?
    public let unread: InboxUnreadSummary

    private enum CodingKeys: String, CodingKey { case changed, readAt, readWatermark, unread }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        if let count = try? values.decode(Int.self, forKey: .changed) {
            changed = count
        } else {
            changed = (try values.decode(Bool.self, forKey: .changed)) ? 1 : 0
        }
        readAt = try values.decodeIfPresent(Date.self, forKey: .readAt)
        readWatermark = try values.decodeIfPresent(String.self, forKey: .readWatermark)
        unread = try values.decode(InboxUnreadSummary.self, forKey: .unread)
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

public protocol InboxHistoryRemoteDataSource: Sendable {
    func fetchHistoryPage(before cursor: String?) async throws -> InboxHistoryPage
}

public protocol InboxCache: Sendable {
    func load() async throws -> InboxSnapshot
    func save(_ snapshot: InboxSnapshot) async throws
}
