import Foundation

public enum InboxRefreshErrorGuidance {
    public static func message(for error: any Error) -> String {
        switch error as? InboxRemoteError {
        case .tailnetUnavailable:
            "Server unreachable"
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
