import SwiftUI

/// One reading of the phone's connection, shared by the Now toolbar and the Settings header.
struct ReloConnectionStatus: Equatable {
    let label: String
    let symbol: String
    let updating: Bool
    let healthy: Bool

    var color: Color {
        if updating { return .reloSignalIndigo }
        return healthy ? .reloDone : .reloSignalCoral
    }
}

extension AppModel {
    var connectionStatus: ReloConnectionStatus {
        // A failed registration must expose its recovery icon rather than spin forever.
        let updating = syncState == .syncing || accountState == .restoring || registrationState == .registering
        let permissionsIncomplete = permission != .allowed || pushRegistrationError != nil || !liveActivitiesAuthorized
        let symbol: String
        if requiresReauthentication || accountState == .disabled { symbol = "person.crop.circle.badge.exclamationmark" }
        else if case .offline = syncState { symbol = "wifi.slash" }
        else if case .failed = registrationState { symbol = "exclamationmark.circle" }
        else if !isRegistered { symbol = "iphone.badge.exclamationmark" }
        else if permissionsIncomplete { symbol = "bell.badge" }
        else { symbol = "checkmark.icloud" }
        let label: String
        if updating { label = "Updating notifications" }
        else if requiresReauthentication { label = "Sign in again" }
        else if accountState == .disabled { label = "Account needs attention" }
        else if case .offline = syncState { label = "You're offline" }
        else if !isRegistered { label = "Connection needs attention" }
        else if permissionsIncomplete { label = "Review notification settings" }
        else { label = "Connected" }
        return .init(label: label, symbol: symbol, updating: updating, healthy: symbol == "checkmark.icloud")
    }
}
