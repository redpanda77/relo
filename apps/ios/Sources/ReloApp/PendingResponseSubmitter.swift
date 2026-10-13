import Foundation
import ReloCore
import ReloRuntime
import ReloTransport

/// What submitting queued responses needs from the app session, and the state it reports back.
/// AppModel is the only host; the protocol keeps that dependency explicit and replaceable in tests.
@MainActor
protocol PendingResponseHost: AnyObject {
    var credential: DeviceCredential? { get }
    var currentSyncScopeIdentity: String? { get }
    var selectionScopeRevision: UInt64 { get }
    var serverURL: URL { get }
    var apiClient: any MobileAPIClient { get }
    var inboxRemote: (any InboxDataSource)? { get }
    var pendingResponseStore: any AccountScopedPendingResponseStoring { get }
    var interactionError: String? { get set }
    func isCurrentSelection(_ revision: UInt64) -> Bool
    func setResponseFeedback(for notificationID: String, _ feedback: NotificationResponseFeedback)
    func setQueuedResponseNotificationIDs(_ ids: Set<String>)
    func removeQueuedResponse(_ notificationID: String)
    func responseConfirmed(at date: Date?)
    func recordDiagnostic(_ event: OperationDiagnostic)
    func handleRevokedDeviceCredential() async
    func reconcileCurrentState()
}

/// Replays and submits the protected queue of decision answers (notification and Live Activity),
/// one immediate submission per decision, and reports each outcome to the host.
@MainActor
final class PendingResponseSubmitter {
    private unowned let host: any PendingResponseHost
    private let immediateDecisions = ImmediateDecisionCoordinator()

    init(host: any PendingResponseHost) {
        self.host = host
    }

    func flushPending() async {
        let host = self.host // keep the session alive for this call, as an AppModel method would
        guard let credential = host.credential, !Task.isCancelled else { return }
        let expectedAccessToken = credential.accessToken, revision = host.selectionScopeRevision
        func ownsReplay() -> Bool { host.isCurrentSelection(revision) && host.credential?.accessToken == expectedAccessToken }
        let accountID = credential.accountId
        let liveActivityResponseFile = try? LiveActivityResponseStorage.responseQueue()
        if
            let confirmations = try? liveActivityResponseFile?.confirmations(
                accountID: accountID,
                deviceID: credential.deviceId,
                now: .now
            )
        {
            await LiveActivityResponseReplayCoordinator.replay(confirmations) { confirmation, presentedAt in
                _ = await LiveActivityResponseActivityPresenter.present(
                    confirmation,
                    presentedAt: presentedAt
                )
            }
        }
        let pending: [PendingNotificationResponse]
        do {
            let confirmations = try await host.pendingResponseStore.notificationConfirmations(now: .now)
            guard ownsReplay() else { return }
            for confirmation in confirmations where confirmation.deviceID == credential.deviceId
                && confirmation.accountID == credential.accountId {
                host.setResponseFeedback(for: confirmation.notificationID, NotificationResponseFeedback(
                    phase: .accepted,
                    action: confirmation.action,
                    canonicalState: confirmation.canonicalState
                ))
            }
            pending = try await host.pendingResponseStore.pending(now: .now)
            guard ownsReplay() else { return }
            let failures = try await host.pendingResponseStore.notificationFailures(now: .now)
            guard ownsReplay() else { return }
            for failure in failures where failure.response.accountID == credential.accountId
                && failure.response.deviceID == credential.deviceId {
                host.setResponseFeedback(for: failure.response.notificationID, NotificationResponseFeedback(
                    phase: .rejected, action: failure.response.action, message: failure.reason.message))
            }
            host.setQueuedResponseNotificationIDs(Set(
                pending.compactMap { response in
                    response.deviceID == credential.deviceId && response.accountID == credential.accountId
                        ? response.notificationID
                        : nil
                }
            ))
            for response in pending where response.deviceID == credential.deviceId
                && response.accountID == credential.accountId {
                host.setResponseFeedback(for: response.notificationID, NotificationResponseFeedback(
                    phase: .queued,
                    action: response.action
                ))
            }
        } catch {
            guard ownsReplay() else { return }
            host.interactionError = "Protected queued responses could not be opened."
            return
        }
        let candidates = Array(pending.filter {
            $0.deviceID == credential.deviceId && $0.accountID == credential.accountId
        }.prefix(25))
        await withTaskGroup(of: Void.self) { group in
            var next = 0
            func enqueue() {
                let response = candidates[next]; next += 1
                group.addTask { [weak self] in
                    guard !Task.isCancelled else { return }
                    _ = await self?.submit(response, credential: credential)
                }
            }
            for _ in 0..<min(4, candidates.count) { enqueue() }
            while await group.next() != nil {
                guard ownsReplay() else { group.cancelAll(); return }
                if next < candidates.count { enqueue() }
            }
        }
    }

    func submit(_ response: PendingNotificationResponse, credential: DeviceCredential) async -> Bool {
        let host = self.host // keep the session alive for this call, as an AppModel method would
        guard let sessionIdentity = host.currentSyncScopeIdentity, !Task.isCancelled,
              host.credential?.accessToken == credential.accessToken,
              response.accountID == credential.accountId, response.deviceID == credential.deviceId else { return false }
        let revision = host.selectionScopeRevision
        guard response.expiresAt > .now else {
            host.recordDiagnostic(.init(operation: .responseSubmission, phase: .completed, outcome: .expired, priority: .immediate))
            if response.endpoint == .notification {
                try? await host.pendingResponseStore.rejectNotification(response, reason: .expired, at: .now)
                guard host.selectionScopeRevision == revision, host.credential?.accessToken == credential.accessToken else { return false }
                host.setResponseFeedback(for: response.notificationID, NotificationResponseFeedback(
                    phase: .rejected, action: response.action, message: NotificationDecisionRejection.expired.message))
            }
            return false
        }
        let key = ImmediateDecisionCoordinator.Key(
            scope: sessionIdentity,
            decision: response.decisionKey)
        return await immediateDecisions.submit(key: key) { [weak self] in
            guard let self, host.selectionScopeRevision == revision,
                  host.credential?.accessToken == credential.accessToken else { return false }
            return await self.perform(response, credential: credential, scopeRevision: revision)
        }
    }

    private func perform(
        _ response: PendingNotificationResponse, credential: DeviceCredential, scopeRevision: UInt64
    ) async -> Bool {
        let host = self.host // keep the session alive for this call, as an AppModel method would
        let diagnosticID = UUID(), diagnosticStart = ContinuousClock.now
        var diagnosticOutcome: OperationDiagnostic.Outcome = .cancelled
        var recordsDiagnosticCompletion = true
        var remoteAcknowledged = false
        defer {
            if recordsDiagnosticCompletion, host.selectionScopeRevision == scopeRevision, host.credential?.accessToken == credential.accessToken {
                host.recordDiagnostic(.init(operation: .responseSubmission, phase: .completed, correlationID: diagnosticID,
                    durationMilliseconds: AppModel.diagnosticMilliseconds(since: diagnosticStart),
                    outcome: diagnosticOutcome, priority: .immediate))
            }
        }
        host.recordDiagnostic(.init(operation: .responseSubmission, phase: .requested, correlationID: diagnosticID,
                               outcome: .pending, priority: .immediate))
        let expectedAccessToken = credential.accessToken
        let ownsScope = { host.isCurrentSelection(scopeRevision)
            && host.credential?.accessToken == expectedAccessToken }
        do {
            switch response.endpoint {
            case .notification:
                guard response.serverOrigin == host.serverURL, response.interactionID != nil else {
                    if response.serverOrigin == nil, response.interactionID == nil,
                       let detail = try? await host.inboxRemote?.fetchDetail(notificationID: response.notificationID),
                       ownsScope(), detail.item.id == response.notificationID, let interaction = detail.item.interaction {
                        guard interaction.state == .pending, interaction.expiresAt > .now else {
                            throw MobileAPIError.decisionRejected(interaction.expiresAt <= .now ? .expired : .superseded)
                        }
                        let metadata = PendingNotificationResponse(accountID: response.accountID, deviceID: response.deviceID,
                            notificationID: response.notificationID, action: response.action, value: response.value,
                            idempotencyKey: response.idempotencyKey, expiresAt: interaction.expiresAt,
                            interactionID: interaction.id, serverOrigin: host.serverURL)
                        let rebound = response.bindingMetadata(from: metadata)
                        _ = try await host.pendingResponseStore.enqueue(rebound)
                        guard ownsScope() else { return false }
                        recordsDiagnosticCompletion = false
                        return await perform(rebound, credential: credential, scopeRevision: scopeRevision)
                    }
                    guard ownsScope() else { return false }
                    diagnosticOutcome = .failed
                    host.setResponseFeedback(for: response.notificationID, NotificationResponseFeedback(
                        phase: .rejected, action: response.action,
                        message: "Saved response needs original request details — open Relo to review"))
                    return false
                }
                let acknowledged = try await host.apiClient.submitDecision(credential: credential, response: response)
                try acknowledged.validate(response)
                guard ownsScope() else { return false }
                remoteAcknowledged = true
                host.responseConfirmed(at: acknowledged.respondedAt)
                let confirmation = try await host.pendingResponseStore.confirmNotification(
                    response,
                    confirmedAt: .now
                )
                guard ownsScope() else { return false }
                host.setResponseFeedback(for: response.notificationID, NotificationResponseFeedback(
                    phase: .accepted,
                    action: confirmation.action,
                    canonicalState: confirmation.canonicalState
                ))
                host.interactionError = nil
                diagnosticOutcome = .confirmed
            case .liveActivity:
                guard let liveActivityResponseFile = try? LiveActivityResponseStorage.responseQueue() else {
                    throw LiveActivityResponseTransport.SubmissionError.invalidConfiguration
                }
                let outcome = await LiveActivityResponseIntentOrchestrator.retry(
                    response,
                    queue: liveActivityResponseFile,
                    submit: LiveActivityResponseTransport.submit,
                    present: LiveActivityResponseActivityPresenter.present
                )
                guard ownsScope() else { return false }
                switch outcome {
                case .accepted, .duplicateConfirmed:
                    diagnosticOutcome = .confirmed
                case .queued, .duplicatePending:
                    diagnosticOutcome = .offline
                    host.interactionError = "Response queued securely. Relo will retry when Relo server is reachable."
                    return false
                case .rejected:
                    diagnosticOutcome = .failed
                    host.removeQueuedResponse(response.notificationID)
                    host.interactionError = "A queued Live Activity response expired or was rejected."
                }
            }
            host.removeQueuedResponse(response.notificationID)
        } catch LiveActivityResponseTransport.SubmissionError.rejected {
            diagnosticOutcome = .failed
            guard ownsScope() else { return false }
            try? await host.pendingResponseStore.remove(id: response.id)
            guard ownsScope() else { return false }
            host.removeQueuedResponse(response.notificationID)
            if response.endpoint == .liveActivity {
                await LiveActivityResponseActivityPresenter.present(
                    LiveActivityResponsePresentationCommand(
                        phase: .rejected,
                        response: response,
                        canonicalState: nil,
                        presentedAt: .now
                    )
                )
            }
            host.interactionError = "A queued Live Activity response expired or was rejected."
        } catch MobileAPIError.decisionRejected(let reason) {
            diagnosticOutcome = reason == .expired ? .expired : reason == .superseded || reason == .versionMismatch ? .superseded : .failed
            guard ownsScope() else { return false }
            do { try await host.pendingResponseStore.rejectNotification(response, reason: reason, at: .now) }
            catch { return false }
            guard ownsScope() else { return false }
            host.removeQueuedResponse(response.notificationID)
            host.setResponseFeedback(for: response.notificationID, NotificationResponseFeedback(
                phase: .rejected, action: response.action, message: reason.message))
            host.interactionError = reason.message
        } catch MobileAPIError.idempotencyConflict {
            diagnosticOutcome = .failed
            guard ownsScope() else { return false }
            do { try await host.pendingResponseStore.rejectNotification(response, reason: .versionMismatch, at: .now) }
            catch { return false }
            guard ownsScope() else { return false }
            host.removeQueuedResponse(response.notificationID)
            host.setResponseFeedback(for: response.notificationID, NotificationResponseFeedback(
                phase: .rejected,
                action: response.action,
                message: "Already answered or expired — refresh before retrying"
            ))
            host.interactionError = "This request was already answered or has expired."
        } catch MobileAPIError.invalidRequest {
            diagnosticOutcome = .failed
            guard ownsScope() else { return false }
            let resolution = await PendingResponseQueueFailureHandler.handle(
                .invalidRequest,
                response: response,
                store: host.pendingResponseStore
            )
            guard ownsScope() else { return false }
            if resolution == .discardedInvalidResponse {
                host.removeQueuedResponse(response.notificationID)
                host.setResponseFeedback(for: response.notificationID, NotificationResponseFeedback(
                    phase: .rejected,
                    action: response.action,
                    message: "Invalid response — retry in Relo"
                ))
                host.interactionError = "This queued response was rejected as invalid and will not be retried."
            } else {
                host.interactionError = "The rejected response could not be removed from the protected queue. Relo will try again."
                return false
            }
        } catch MobileAPIError.reauthenticationRequired, MobileAPIError.forbidden {
            diagnosticOutcome = .unauthorized
            guard ownsScope() else { return false }
            try? await host.pendingResponseStore.remove(id: response.id)
            guard ownsScope() else { return false }
            host.recordDiagnostic(.init(operation: .responseSubmission, phase: .completed, correlationID: diagnosticID,
                outcome: .unauthorized, priority: .immediate))
            await host.handleRevokedDeviceCredential()
            host.interactionError = "This iPhone must be registered again before responding."
            return false
        } catch {
            diagnosticOutcome = remoteAcknowledged ? .storageUnavailable : OperationDiagnostic.outcome(for: error)
            guard ownsScope() else { return false }
            if response.endpoint == .liveActivity {
                await LiveActivityResponseActivityPresenter.present(
                    LiveActivityResponsePresentationCommand(
                        phase: .queued,
                        response: response,
                        canonicalState: nil,
                        presentedAt: .now
                    )
                )
            }
            guard ownsScope() else { return false }
            host.setResponseFeedback(for: response.notificationID, NotificationResponseFeedback(
                phase: .queued,
                action: response.action
            ))
            host.interactionError = "Response queued securely. Relo will retry when Relo server is reachable."
            return false
        }
        host.reconcileCurrentState()
        return true
    }
}
