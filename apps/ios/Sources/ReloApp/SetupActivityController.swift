import ActivityKit
import Foundation
import ReloCore

/// The Live Activity of the Connect a computer wizard: started when the command is shown, updated by the server's push
/// (and by the wizard while it is on screen), ended when the wizard finishes, the code expires or the owner taps Done.
/// Only value inputs cross from the UI: each SDK object is acquired and used inside `SetupActivityKit`.
@MainActor
final class SetupActivityController {
    private var activityID: String?
    private var inviteId: String?
    private var tokenTask: Task<Void, Never>?

    /// Follows (or starts) the activity of `inviteId`. `onToken` receives its push token, now and whenever it changes.
    func start(inviteId: String, state: ReloSetupActivityAttributes.ContentState, staleDate: Date?,
               onToken: @escaping @MainActor (String) -> Void) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        if self.inviteId == inviteId, activityID != nil { return }
        tokenTask?.cancel()
        guard let id = SetupActivityKit.startOrAdopt(inviteId: inviteId, state: state, staleDate: staleDate) else {
            // Live Activities are a convenience; the wizard works without one.
            activityID = nil
            self.inviteId = nil
            return
        }
        activityID = id
        self.inviteId = inviteId
        tokenTask = Task { @MainActor in
            for await token in SetupActivityKit.pushTokens(id: id) { onToken(ActivityKitTokenCodec.hex(token)) }
        }
    }

    func update(_ state: ReloSetupActivityAttributes.ContentState, staleDate: Date?) {
        guard let id = activityID else { return }
        Task { await SetupActivityKit.update(id: id, state: state, staleDate: staleDate) }
    }

    /// Ends the activity: at once on Done, after a moment when it shows a result worth reading.
    func end(final state: ReloSetupActivityAttributes.ContentState? = nil, lingering seconds: TimeInterval = 0) {
        tokenTask?.cancel()
        tokenTask = nil
        let id = activityID
        activityID = nil
        inviteId = nil
        guard let id else { return }
        Task { await SetupActivityKit.end(id: id, state: state, lingering: seconds) }
    }
}

private enum SetupActivityKit {
    /// The activity already held for this code (after a relaunch), else a new one; any other is stale and ends.
    static func startOrAdopt(inviteId: String, state: ReloSetupActivityAttributes.ContentState, staleDate: Date?) -> String? {
        let held = Activity<ReloSetupActivityAttributes>.activities
        let current = held.first { $0.attributes.inviteId == inviteId }
        for stale in held where stale.id != current?.id {
            let id = stale.id
            Task { await end(id: id, state: nil, lingering: 0) }
        }
        if let current { return current.id }
        return try? Activity.request(
            attributes: ReloSetupActivityAttributes(inviteId: inviteId),
            content: ActivityContent(state: state, staleDate: staleDate),
            pushType: .token).id
    }

    static func pushTokens(id: String) -> AsyncStream<Data> {
        AsyncStream { continuation in
            let task = Task {
                if let activity = Activity<ReloSetupActivityAttributes>.activities.first(where: { $0.id == id }) {
                    for await token in activity.pushTokenUpdates { continuation.yield(token) }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static func update(id: String, state: ReloSetupActivityAttributes.ContentState, staleDate: Date?) async {
        guard let activity = Activity<ReloSetupActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
        await activity.update(ActivityContent(state: state, staleDate: staleDate))
    }

    static func end(id: String, state: ReloSetupActivityAttributes.ContentState?, lingering seconds: TimeInterval) async {
        guard let activity = Activity<ReloSetupActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
        await activity.end(state.map { ActivityContent(state: $0, staleDate: nil) },
                           dismissalPolicy: seconds > 0 ? .after(.now.addingTimeInterval(seconds)) : .immediate)
    }
}
