import ReloTransport
import ReloPersistence
import ReloNotificationSupport
import Foundation
import ReloCore
#if os(iOS)
import ActivityKit
import AppIntents
#endif

enum LiveActivityResponsePresentationDismissal: Equatable, Sendable {
    case immediate
    case after(Date)
}

enum LiveActivityResponseSystemActivityState: Equatable, Sendable {
    case pending
    case active
    case stale
    case ended
    case dismissed
    case unknown
}

enum LiveActivityResponsePresentationOperation: Equatable, Sendable {
    case update
    case end(LiveActivityResponsePresentationDismissal)
    case none
    case unsupported
}

struct LiveActivityResponsePresentationCommand: Equatable, Sendable {
    let phase: LiveActivityResponsePhase
    let response: PendingNotificationResponse
    let canonicalState: String?
    let presentedAt: Date

    static func accepted(
        _ confirmation: LiveActivityResponseConfirmation,
        credential: String,
        presentedAt: Date
    ) -> Self {
        Self(
            phase: .accepted,
            response: confirmation.response(using: credential),
            canonicalState: confirmation.canonicalState,
            presentedAt: presentedAt
        )
    }

    func operation(for activityState: LiveActivityResponseSystemActivityState) -> LiveActivityResponsePresentationOperation {
        guard phase == .accepted else { return .update }
        switch activityState {
        case .pending, .active, .stale:
            return .end(
                .after(
                    LiveActivityResponsePolicy.terminalDismissalDate(
                        presentedAt: presentedAt
                    )
                )
            )
        case .ended, .dismissed:
            return .none
        case .unknown:
            return .unsupported
        }
    }
}

enum LiveActivityResponsePresentationExecutor {
    static func execute(
        _ command: LiveActivityResponsePresentationCommand,
        activityState: LiveActivityResponseSystemActivityState,
        update: () async -> Void,
        end: (LiveActivityResponsePresentationDismissal) async -> Void
    ) async -> Bool {
        switch command.operation(for: activityState) {
        case .update:
            await update()
        case .end(let dismissal):
            await end(dismissal)
        case .none:
            break
        case .unsupported:
            return false
        }
        return true
    }
}

enum LiveActivityResponseWidgetMode: Equatable, Sendable {
    case actions
    case openTextReply
    case sending
    case queued
    case rejected
    case accepted
    case terminal
    case placeholder
}

struct LiveActivityResponseWidgetPresentation: Equatable, Sendable {
    let mode: LiveActivityResponseWidgetMode
    let label: String?
    let symbol: String?
    let showsProgress: Bool

    /// `options` are a choice's answers, so its states can name the picked one.
    static func make(
        interaction: LiveActivityContentInteraction?,
        primary: String,
        secondary: String,
        options: [InteractionOption] = [],
        fallbackStatus: String? = nil,
        now: Date
    ) -> Self {
        guard let interaction else {
            let status = fallbackStatus?.trimmingCharacters(in: .whitespacesAndNewlines)
            let label = status.flatMap { $0.isEmpty ? nil : $0 } ?? "Response unavailable"
            return Self(
                mode: .terminal,
                label: label,
                symbol: fallbackSymbol(label),
                showsProgress: false
            )
        }
        let picked = interaction.selectedOptionID.flatMap { id in options.first { $0.id == id }?.label }
        let chosenLabel = picked ?? fallbackStatus.flatMap { status in
            let trimmed = status.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        if interaction.responsePhase == .accepted {
            let visual = LiveActivitySurfaceProjection.ResponseStatus.make(
                interaction: interaction, now: now, chosenLabel: chosenLabel)
            return Self(
                mode: .accepted,
                label: visual.label,
                symbol: visual.symbol,
                showsProgress: false
            )
        }
        guard interaction.state == "pending", interaction.expiresAt > now else {
            let visual = LiveActivitySurfaceProjection.ResponseStatus.make(
                interaction: interaction, now: now, chosenLabel: chosenLabel)
            return Self(
                mode: .terminal,
                label: visual.label,
                symbol: visual.symbol,
                showsProgress: false
            )
        }
        switch interaction.responsePhase {
        case nil:
            if interaction.kind == "text" {
                return Self(
                    mode: .openTextReply,
                    label: "Open Relo to reply",
                    symbol: "arrow.up.right.square",
                    showsProgress: false
                )
            }
            return Self(mode: .actions, label: nil, symbol: nil, showsProgress: false)
        case .sending:
            return Self(
                mode: .sending,
                label: "Sending response…",
                symbol: nil,
                showsProgress: true
            )
        case .queued:
            return Self(
                mode: .queued,
                label: "\(picked ?? selectedLabel(interaction.selectedAction, primary: primary, secondary: secondary)) · Waiting to send",
                symbol: "clock.arrow.circlepath",
                showsProgress: false
            )
        case .rejected:
            return Self(
                mode: .rejected,
                label: "Response not recorded",
                symbol: "exclamationmark.triangle.fill",
                showsProgress: false
            )
        case .accepted:
            let visual = LiveActivitySurfaceProjection.ResponseStatus.make(
                interaction: interaction, now: now, chosenLabel: chosenLabel)
            return Self(
                mode: .accepted,
                label: visual.label,
                symbol: visual.symbol,
                showsProgress: false
            )
        }
    }

    private static func selectedLabel(
        _ action: NotificationInteractionAction?,
        primary: String,
        secondary: String
    ) -> String {
        switch action {
        case .approve, .yes: primary
        case .deny, .no: secondary
        case .answer: "Reply"
        case .choose: "Choice"
        case .opened, .received, nil: "Response"
        }
    }

    private static func terminalLabel(_ state: String) -> String {
        switch state {
        case "approved": "Approved"
        case "denied": "Denied"
        case "yes": "Answered Yes"
        case "no": "Answered No"
        case "replied": "Reply sent"
        case "expired": "Request expired"
        case "canceled": "Request canceled"
        default: "Response unavailable"
        }
    }

    private static func terminalSymbol(_ state: String) -> String {
        switch state {
        case "approved", "yes", "replied": "checkmark.circle.fill"
        case "denied", "no": "xmark.circle.fill"
        case "expired", "canceled": "clock.badge.xmark"
        default: "exclamationmark.triangle.fill"
        }
    }

    private static func fallbackSymbol(_ status: String) -> String {
        switch status.lowercased() {
        case "approved", "yes", "replied", "reply sent": "checkmark.circle.fill"
        case "denied", "no": "xmark.circle.fill"
        case "expired", "canceled": "clock.badge.xmark"
        default: "info.circle.fill"
        }
    }
}

enum LiveActivityResponseAttemptOutcome: Equatable, Sendable {
    case accepted
    case queued
    case rejected
    case duplicatePending
    case duplicateConfirmed
}

enum LiveActivityResponseIntentOrchestrator {
    static func perform(
        requested: PendingNotificationResponse,
        queue: CrossProcessResponseFile,
        clock: () -> Date = Date.init,
        submit: (PendingNotificationResponse) async throws -> LiveActivityResponseServerResult,
        present: (LiveActivityResponsePresentationCommand) async -> Bool
    ) async -> LiveActivityResponseAttemptOutcome {
        let response: PendingNotificationResponse
        do {
            switch try queue.enqueue(requested) {
            case .enqueued:
                response = requested
            case .alreadyPending(let existing):
                _ = await present(
                    LiveActivityResponsePresentationCommand(
                        phase: .queued,
                        response: existing,
                        canonicalState: nil,
                        presentedAt: clock()
                    )
                )
                return .duplicatePending
            case .alreadyConfirmed(let confirmation):
                guard let credential = requested.responseCredential else { return .rejected }
                _ = await present(.accepted(confirmation, credential: credential, presentedAt: clock()))
                return .duplicateConfirmed
            case .alreadyNotificationConfirmed:
                return .rejected
            }
        } catch {
            _ = await present(
                LiveActivityResponsePresentationCommand(
                    phase: .rejected,
                    response: requested,
                    canonicalState: nil,
                    presentedAt: clock()
                )
            )
            return .rejected
        }
        return await submitPending(
            response,
            queue: queue,
            clock: clock,
            submit: submit,
            present: present
        )
    }

    static func retry(
        _ response: PendingNotificationResponse,
        queue: CrossProcessResponseFile,
        clock: () -> Date = Date.init,
        submit: (PendingNotificationResponse) async throws -> LiveActivityResponseServerResult,
        present: (LiveActivityResponsePresentationCommand) async -> Bool
    ) async -> LiveActivityResponseAttemptOutcome {
        await submitPending(
            response,
            queue: queue,
            clock: clock,
            submit: submit,
            present: present
        )
    }

    private static func submitPending(
        _ response: PendingNotificationResponse,
        queue: CrossProcessResponseFile,
        clock: () -> Date,
        submit: (PendingNotificationResponse) async throws -> LiveActivityResponseServerResult,
        present: (LiveActivityResponsePresentationCommand) async -> Bool
    ) async -> LiveActivityResponseAttemptOutcome {
        _ = await present(
            LiveActivityResponsePresentationCommand(
                phase: .sending,
                response: response,
                canonicalState: nil,
                presentedAt: clock()
            )
        )
        do {
            let result = try await submit(response)
            let confirmation = try queue.confirm(
                response,
                canonicalState: result.state,
                confirmedAt: clock()
            )
            guard let credential = response.responseCredential else {
                throw LiveActivityResponseConfirmationError.responseMismatch
            }
            _ = await present(.accepted(confirmation, credential: credential, presentedAt: clock()))
            return .accepted
        } catch LiveActivityResponseTransport.SubmissionError.invalidConfiguration,
                LiveActivityResponseTransport.SubmissionError.unavailable,
                LiveActivityResponseTransport.SubmissionError.unconfirmed,
                LiveActivityResponseConfirmationError.missingPendingResponse,
                LiveActivityResponseConfirmationError.responseMismatch,
                LiveActivityResponseConfirmationError.invalidConfirmation {
            _ = await present(
                LiveActivityResponsePresentationCommand(
                    phase: .queued,
                    response: response,
                    canonicalState: nil,
                    presentedAt: clock()
                )
            )
            return .queued
        } catch {
            try? queue.remove(id: response.id, accountID: response.accountID, deviceID: response.deviceID)
            _ = await present(
                LiveActivityResponsePresentationCommand(
                    phase: .rejected,
                    response: response,
                    canonicalState: nil,
                    presentedAt: clock()
                )
            )
            return .rejected
        }
    }
}

enum LiveActivityResponseReplayCoordinator {
    static func replay(
        _ confirmations: [LiveActivityResponseConfirmation],
        isolation: isolated (any Actor)? = #isolation,
        clock: () -> Date = Date.init,
        present: (LiveActivityResponseConfirmation, Date) async -> Void
    ) async {
        for confirmation in confirmations {
            await present(confirmation, clock())
        }
    }
}

enum LiveActivityResponseTransport {
    enum SubmissionError: Error { case invalidConfiguration, rejected, unconfirmed, unavailable }

    static func submit(_ response: PendingNotificationResponse) async throws -> LiveActivityResponseServerResult {
        guard let baseURL = RuntimeServerOrigin.current() else {
            throw SubmissionError.invalidConfiguration
        }

        return try await submit(response, apiOrigin: baseURL) { request in
            try await ReloAPISession.shared.data(for: request)
        }
    }

    static func submit(
        _ response: PendingNotificationResponse,
        apiOrigin: URL,
        load: (URLRequest) async throws -> (Data, URLResponse)
    ) async throws -> LiveActivityResponseServerResult {
        let request: URLRequest
        do {
            request = try LiveActivityResponseRequestFactory.make(
                response: response,
                apiOrigin: apiOrigin
            )
        } catch {
            throw SubmissionError.invalidConfiguration
        }

        let data: Data
        let urlResponse: URLResponse
        do {
            (data, urlResponse) = try await load(request)
        } catch {
            throw SubmissionError.unavailable
        }
        guard let http = urlResponse as? HTTPURLResponse else { throw SubmissionError.unavailable }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 409 { throw SubmissionError.unconfirmed }
            if [400, 401, 403, 404, 410].contains(http.statusCode) { throw SubmissionError.rejected }
            throw SubmissionError.unavailable
        }
        do {
            return try LiveActivityResponseServerResult.decode(data, expectedAction: response.action)
        } catch {
            throw SubmissionError.unconfirmed
        }
    }
}

enum LiveActivityResponseStorage {
    static func responseQueue() throws -> CrossProcessResponseFile {
        guard
            let group = Bundle.main.object(forInfoDictionaryKey: "RELOAppGroup") as? String,
            let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
        else { throw LiveActivityResponseTransport.SubmissionError.invalidConfiguration }
        return CrossProcessResponseFile(
            baseDirectory: root.appendingPathComponent("protected-actions", isDirectory: true)
        )
    }
}

#if os(iOS)
enum LiveActivityResponseActivityPresenter {
    static func hasExactActivity(for response: PendingNotificationResponse) -> Bool {
        matchingActivity(for: response) != nil
    }

    /// The sealed question's context when this card shows a prompt opened on this phone.
    static func openedQuestionContext(for response: PendingNotificationResponse) -> String? {
        guard let state = matchingActivity(for: response)?.content.state, let sealed = state.sealed, sealed.kind == "question",
              state.presentation.subtitle != ReloSealedCards.promptPlaceholder else { return nil }
        return sealed.context
    }

    @discardableResult
    static func present(
        _ confirmation: LiveActivityResponseConfirmation,
        presentedAt: Date = .now
    ) async -> Bool {
        guard
            let activity = Activity<ReloActivityAttributes>.activities.first(where: {
                $0.attributes.identity == LiveActivityIdentity(
                    activityID: confirmation.activityID,
                    generation: confirmation.activityGeneration
                )
            }),
            let credential = activity.content.state.interaction?.credential
        else { return false }
        return await present(
            .accepted(
                confirmation,
                credential: credential,
                presentedAt: presentedAt
            )
        )
    }

    @discardableResult
    static func present(_ command: LiveActivityResponsePresentationCommand) async -> Bool {
        guard let activity = matchingActivity(for: command.response) else { return false }
        var state = activity.content.state
        guard var interaction = state.interaction else { return false }
        interaction.responsePhase = command.phase
        interaction.selectedAction = command.response.action
        interaction.selectedOptionID = command.response.optionID
        if command.phase == .accepted {
            guard
                let canonicalState = command.canonicalState,
                LiveActivityResponsePolicy.isCanonicalResponse(
                    canonicalState,
                    for: command.response.action
                )
            else { return false }
            interaction.state = canonicalState
        }
        state.interaction = interaction
        let presentation = state.presentation
        state.presentation = LiveActivityPresentation(
            header: presentation.header,
            title: presentation.title,
            subtitle: presentation.subtitle,
            status: LiveActivityResponsePolicy.status(
                phase: command.phase,
                action: command.response.action,
                confirmedState: command.canonicalState,
                optionLabel: presentation.behavior.choiceOptions?
                    .first { $0.id == command.response.optionID }?.label
            ),
            components: presentation.components,
            surfaces: presentation.surfaces,
            identity: presentation.identity,
            state: presentation.state,
            behavior: presentation.behavior,
            appearance: presentation.appearance,
            privacy: presentation.privacy
        )
        state.updatedAt = command.presentedAt
        let content = ActivityContent(state: state,
            staleDate: command.phase == .accepted ? nil
                : LiveActivitySurfaceProjection.invalidationDate(staleAt: state.staleAt, interaction: interaction))
        return await LiveActivityResponsePresentationExecutor.execute(
            command,
            activityState: systemState(activity.activityState),
            update: {
                await activity.update(content)
            },
            end: { dismissal in
                switch dismissal {
                case .immediate:
                    await activity.end(content, dismissalPolicy: .immediate)
                case .after(let date):
                    await activity.end(content, dismissalPolicy: .after(date))
                }
            }
        )
    }

    private static func systemState(_ state: ActivityState) -> LiveActivityResponseSystemActivityState {
        switch state {
        case .pending: .pending
        case .active: .active
        case .stale: .stale
        case .ended: .ended
        case .dismissed: .dismissed
        @unknown default: .unknown
        }
    }

    private static func matchingActivity(
        for response: PendingNotificationResponse
    ) -> Activity<ReloActivityAttributes>? {
        guard
            response.endpoint == .liveActivity,
            let activityID = response.activityID,
            let activityGeneration = response.activityGeneration,
            let interactionID = response.interactionID,
            let responseCredential = response.responseCredential,
            let activity = Activity<ReloActivityAttributes>.activities.first(where: {
                $0.attributes.identity == LiveActivityIdentity(
                    activityID: activityID,
                    generation: activityGeneration
                )
            }),
            let interaction = activity.content.state.interaction,
            interaction.id == interactionID,
            interaction.notificationID == response.notificationID,
            interaction.targetDeviceID == response.deviceID,
            interaction.accountID == response.accountID,
            interaction.credential == responseCredential,
            LiveActivityResponsePolicy.supports(response.action, kind: interaction.kind),
            response.optionID.map({ id in
                activity.content.state.presentation.behavior.choiceOptions?.contains { $0.id == id } == true
            }) ?? true
        else { return nil }
        return activity
    }
}

struct ReloLiveActivityResponseIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Respond to Relo"
    static let description = IntentDescription("Records one response for a Relo Live Activity.")
    static let openAppWhenRun = false

    @Parameter(title: "Activity ID") var activityID: String
    @Parameter(title: "Activity Generation") var activityGeneration: Int
    @Parameter(title: "Notification ID") var notificationID: String
    @Parameter(title: "Interaction ID") var interactionID: String
    @Parameter(title: "Account ID") var accountID: String
    @Parameter(title: "Device ID") var deviceID: String
    @Parameter(title: "Action") var action: String
    /// The picked option when `action` is `choose`; empty otherwise.
    @Parameter(title: "Option ID") var optionID: String
    @Parameter(title: "Credential") var credential: String
    @Parameter(title: "Expires At") var expiresAt: Date

    init() {
        activityID = ""
        activityGeneration = 0
        notificationID = ""
        interactionID = ""
        accountID = ""
        deviceID = ""
        action = ""
        optionID = ""
        credential = ""
        expiresAt = .distantPast
    }

    init(
        activityID: String,
        activityGeneration: Int,
        notificationID: String,
        interactionID: String,
        accountID: String,
        deviceID: String,
        action: String,
        optionID: String = "",
        credential: String,
        expiresAt: Date
    ) {
        self.activityID = activityID
        self.activityGeneration = activityGeneration
        self.notificationID = notificationID
        self.interactionID = interactionID
        self.accountID = accountID
        self.deviceID = deviceID
        self.action = action
        self.optionID = optionID
        self.credential = credential
        self.expiresAt = expiresAt
    }

    func perform() async throws -> some IntentResult {
        guard let responseAction = NotificationInteractionAction(rawValue: action),
              responseAction == .choose ? InteractionOption.isValidID(optionID) : optionID.isEmpty
        else {
            return .result()
        }
        // Signed with this phone's identity key so the CLI can trust the button (E4.2), bound to the
        // sealed question this card showed when its prompt was opened on this phone.
        let unsignedRequest = PendingNotificationResponse.liveActivity(
            accountID: accountID,
            deviceID: deviceID,
            notificationID: notificationID,
            activityID: activityID,
            activityGeneration: activityGeneration,
            interactionID: interactionID,
            action: responseAction,
            optionID: responseAction == .choose ? optionID : nil,
            credential: credential,
            expiresAt: expiresAt
        )
        let requested = ReloAnswerSigning.sign(unsignedRequest, signer: ReloKeyRing.live().existingIdentitySigner(),
            question: LiveActivityResponseActivityPresenter.openedQuestionContext(for: unsignedRequest))
        guard LiveActivityResponseActivityPresenter.hasExactActivity(for: requested) else {
            return .result()
        }
        guard expiresAt > .now else {
            await LiveActivityResponseActivityPresenter.present(
                LiveActivityResponsePresentationCommand(
                    phase: .rejected,
                    response: requested,
                    canonicalState: nil,
                    presentedAt: .now
                )
            )
            return .result()
        }
        let queue: CrossProcessResponseFile
        do {
            queue = try LiveActivityResponseStorage.responseQueue()
        } catch {
            await LiveActivityResponseActivityPresenter.present(
                LiveActivityResponsePresentationCommand(
                    phase: .rejected,
                    response: requested,
                    canonicalState: nil,
                    presentedAt: .now
                )
            )
            return .result()
        }
        _ = await LiveActivityResponseIntentOrchestrator.perform(
            requested: requested,
            queue: queue,
            submit: LiveActivityResponseTransport.submit,
            present: LiveActivityResponseActivityPresenter.present
        )
        return .result()
    }
}
#endif
