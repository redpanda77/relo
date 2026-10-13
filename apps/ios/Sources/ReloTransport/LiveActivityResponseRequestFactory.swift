import ReloCore
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum LiveActivityResponseRequestFactory {
    public static func make(
        response: PendingNotificationResponse,
        apiOrigin: URL
    ) throws -> URLRequest {
        guard
            ServerEndpointPolicy.accepts(apiOrigin),
            response.endpoint == .liveActivity,
            let interactionID = response.interactionID,
            let credential = response.responseCredential,
            ReloIdentifier.isValid(interactionID),
            ReloIdentifier.isValid(response.notificationID),
            ReloIdentifier.isValid(response.deviceID),
            (32...4_096).contains(credential.utf16.count),
            [.approve, .deny, .yes, .no].contains(response.action)
        else { throw LiveActivityResponseRequestError.invalidConfiguration }

        let url = apiOrigin
            .appendingPathComponent("api", isDirectory: true)
            .appendingPathComponent("live-activity-responses", isDirectory: true)
            .appendingPathComponent(interactionID)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = 15
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "notificationId": response.notificationID,
            "deviceId": response.deviceID,
            "action": response.action.rawValue,
            "credential": credential,
            "idempotencyKey": response.idempotencyKey,
        ])
        return request
    }
}
