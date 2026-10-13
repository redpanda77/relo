import ActivityKit
import ReloRuntime

/// Only value inputs cross from UI orchestration. Each SDK object is acquired and
/// used within this nonisolated operation, never sent from UI-owned state.
enum ActivityKitMutationAdapter {
    static func update(nativeID: String, content: ActivityContent<ReloActivityAttributes.ContentState>) async throws {
        guard let activity = Activity<ReloActivityAttributes>.activities.first(where: { $0.id == nativeID }) else {
            throw LiveActivityCommandCoordinatorError.missingActivity
        }
        await activity.update(content)
    }

    static func end(nativeID: String, content: ActivityContent<ReloActivityAttributes.ContentState>,
                    dismissal: ActivityUIDismissalPolicy) async throws {
        guard let activity = Activity<ReloActivityAttributes>.activities.first(where: { $0.id == nativeID }) else {
            throw LiveActivityCommandCoordinatorError.missingActivity
        }
        await activity.end(content, dismissalPolicy: dismissal)
    }
}
