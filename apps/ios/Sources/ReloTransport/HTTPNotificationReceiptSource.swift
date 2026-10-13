import ReloCore
import CryptoKit
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct HTTPNotificationReceiptSource: NotificationReceiptRemoteSource {
    private let scope: ReceiptScope
    private let origin: URL
    private let token: String
    private let session: URLSession
    public init(scope: StorageScope, credential: DeviceCredential, session: URLSession = ReloAPISession.shared) throws {
        guard scope.accountID == credential.accountId, scope.deviceID == credential.deviceId
        else { throw NotificationReceiptRemoteError.scopeMismatch }
        self.scope = try ReceiptScope(serverOrigin: scope.serverOrigin, accountId: scope.accountID, deviceId: scope.deviceID)
        origin = scope.serverOrigin; token = credential.accessToken; self.session = session
    }
    public func submit(_ record: NotificationReceiptRecord) async throws -> NotificationReceiptOutcome {
        guard record.scope == scope else { throw NotificationReceiptRemoteError.scopeMismatch }
        struct Body: Encodable { let kind = "received"; let value: [String: String] = [:]; let idempotencyKey: String }
        let identity = [scope.serverOriginHash, scope.accountId, scope.deviceId, record.notificationID]
            .map { "\($0.utf8.count):\($0)" }.joined()
        let digest = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        var request = URLRequest(url: origin.appendingPathComponent("api/notifications/\(record.notificationID)/interactions"))
        request.httpMethod = "POST"; request.timeoutInterval = 8; request.cachePolicy = .reloadIgnoringLocalCacheData
        request.authorize(bearer: token)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Body(idempotencyKey: "ios:received:\(digest)"))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, data.count <= 65_536 else { throw NotificationReceiptRemoteError.incompatible }
        switch http.statusCode {
        case 200, 201:
            struct Accepted: Decodable { let interactionId: String }
            guard let accepted = try? JSONDecoder().decode(Accepted.self, from: data), accepted.interactionId.hasPrefix("int_")
            else { throw NotificationReceiptRemoteError.incompatible }
            return .acknowledged // Exact idempotent replays also return 200.
        case 401, 403: throw NotificationReceiptRemoteError.unauthorized
        case 404:
            struct Rejected: Decodable { let error: String }
            guard let rejected = try? JSONDecoder().decode(Rejected.self, from: data), rejected.error == "not_found"
            else { throw NotificationReceiptRemoteError.incompatible }
            return .notFound
        case 409: throw NotificationReceiptRemoteError.conflict
        default: throw NotificationReceiptRemoteError.offline
        }
    }
}
