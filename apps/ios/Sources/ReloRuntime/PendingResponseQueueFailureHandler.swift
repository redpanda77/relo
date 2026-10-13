import ReloCore
import Foundation

public enum PendingResponseQueueFailureHandler {
    public static func handle(
        _ error: MobileAPIError,
        response: PendingNotificationResponse,
        store: any AccountScopedPendingResponseStoring
    ) async -> PendingResponseFailureResolution {
        guard error == .invalidRequest else { return .retry }
        do {
            try await store.remove(id: response.id)
            return .discardedInvalidResponse
        } catch {
            return .retry
        }
    }
}
