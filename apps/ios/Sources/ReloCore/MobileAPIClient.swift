import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum MobileAPIError: Error, Equatable, Sendable {
    case invalidRequest
    case invalidCredentials
    case accountDisabled
    case reauthenticationRequired
    case forbidden
    case idempotencyConflict
    case rateLimited(retryAfterSeconds: Int?)
    case tailnetUnavailable
    case unavailable
    case invalidResponse
}

public struct DeliveryTransportStatus: Decodable, Equatable, Sendable {
    public struct APNs: Decodable, Equatable, Sendable {
        public enum Mode: String, Decodable, Sendable {
            case disabled
            case sandbox
            case production
        }

        public enum Semantics: String, Decodable, Sendable {
            case durableInboxRefreshOnly = "durable_inbox_refresh_only"
            case workerDirectAPNs = "worker_direct_apns"
        }

        public let mode: Mode
        public let remoteEnqueueEnabled: Bool
        public let providerCredentialActive: Bool?
        public let deliverySemantics: Semantics

        public var directDeliveryConfigured: Bool {
            deliverySemantics == .workerDirectAPNs
                && mode != .disabled
                && remoteEnqueueEnabled
                && providerCredentialActive != false
        }
    }

    public let apns: APNs
}

public enum AccountDeletionErrorGuidance {
    public static func message(for error: Error) -> String {
        switch error {
        case MobileAPIError.invalidCredentials:
            "The current password is incorrect. Check it and try again; nothing was removed from this iPhone."
        case MobileAPIError.invalidRequest, MobileAPIError.forbidden:
            "Relo server rejected the exact DELETE confirmation. Nothing was removed from this iPhone."
        case MobileAPIError.reauthenticationRequired:
            "Your Relo server session expired. Sign in again before deleting the account; nothing was removed."
        case MobileAPIError.rateLimited(let seconds):
            seconds.map { "Relo server is limiting deletion attempts. Try again in \($0) seconds; nothing was removed." }
                ?? "Relo server is limiting deletion attempts. Try again shortly; nothing was removed."
        default:
            "Relo server could not confirm account deletion. Protected local state was retained; retry when the private server is reachable."
        }
    }
}

public enum DeliveryTransportStatusErrorGuidance {
    public static func message(for error: Error) -> String {
        switch error {
        case MobileAPIError.reauthenticationRequired:
            "Your Relo server session expired. Sign in again to check the delivery path."
        case MobileAPIError.forbidden:
            "This Relo server account cannot read delivery-path status."
        case MobileAPIError.tailnetUnavailable:
            "The private Tailnet is unavailable."
        case MobileAPIError.invalidResponse:
            "Relo server returned an incompatible delivery-path status."
        case MobileAPIError.rateLimited(let seconds):
            seconds.map { "Relo server is limiting status checks. Try again in \($0) seconds." }
                ?? "Relo server is limiting status checks. Try again shortly."
        default:
            "Relo server's delivery-status service is unavailable."
        }
    }
}

public protocol MobileAPIClient: Sendable {
    func consumeConnectionGrant(
        document: ReloConnectionDocument,
        installationId: String
    ) async throws -> AccountSession
    func signIn(email: String, password: String) async throws -> AccountSession
    func validateAccountSession(token: String) async throws -> AccountSession
    func registerDevice(
        sessionToken: String,
        request: DeviceRegistrationRequest,
        idempotencyKey: String
    ) async throws -> DeviceRegistrationResponse
    func deviceSelf(credential: DeviceCredential) async throws -> DeviceSelfResponse
    func deliveryTransportStatus(sessionToken: String) async throws -> DeliveryTransportStatus
    func withdrawNotification(sessionToken: String, notificationID: String) async throws
    func heartbeat(credential: DeviceCredential, heartbeat: DeviceHeartbeat) async throws
    func registerLiveActivityToken(
        credential: DeviceCredential,
        activityId: String,
        registration: LiveActivityTokenRegistration
    ) async throws
    func reportLiveActivityDismissed(
        credential: DeviceCredential,
        activityId: String
    ) async throws
    func submitInteraction(
        credential: DeviceCredential,
        notificationId: String,
        action: NotificationInteractionAction,
        value: [String: String],
        idempotencyKey: String
    ) async throws
    func revokeDevice(credential: DeviceCredential) async throws
    func signOutAccount(sessionToken: String) async throws
    func deleteAccount(sessionToken: String, password: String, confirmation: String) async throws
}

public extension MobileAPIClient {
    func consumeConnectionGrant(
        document: ReloConnectionDocument,
        installationId: String
    ) async throws -> AccountSession { throw MobileAPIError.unavailable }
    func deliveryTransportStatus(sessionToken: String) async throws -> DeliveryTransportStatus {
        throw MobileAPIError.unavailable
    }

    func withdrawNotification(sessionToken: String, notificationID: String) async throws {
        throw MobileAPIError.unavailable
    }

    func reportLiveActivityDismissed(
        credential: DeviceCredential,
        activityId: String
    ) async throws {
        throw MobileAPIError.unavailable
    }
}

public struct ReloConnectionDocument: Codable, Equatable, Sendable {
    public let type: String
    public let origin: URL
    public let grant: String
    public let expiresAt: Date

    public init(type: String, origin: URL, grant: String, expiresAt: Date) {
        self.type = type; self.origin = origin
        self.grant = grant; self.expiresAt = expiresAt
    }

    public static func decode(scannedValue: String, now: Date = Date()) throws -> Self {
        guard let data = scannedValue.data(using: .utf8) else { throw MobileAPIError.invalidRequest }
        let value = try JSONDecoder.reloConnection.decode(Self.self, from: data)
        guard value.type == "relo.connection",
              DashboardURLProvider(origin: value.origin) != nil,
              value.grant.hasPrefix("relo_pair_"), value.expiresAt > now
        else { throw MobileAPIError.invalidRequest }
        return value
    }
}

private extension JSONDecoder {
    static var reloConnection: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fractional.date(from: value) { return date }
            let standard = ISO8601DateFormatter()
            standard.formatOptions = [.withInternetDateTime]
            if let date = standard.date(from: value) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid ISO 8601 date")
        }
        return decoder
    }
}

public struct DashboardURLProvider: Sendable {
    public let origin: URL

    public init?(origin: URL) {
        guard ServerEndpointPolicy.accepts(origin) else { return nil }
        self.origin = origin
    }

    public var dashboardURL: URL {
        origin.appendingPathComponent("dashboard")
    }
}

public enum RuntimeServerOrigin {
    public static let defaultsKey = "relo.serverOrigin"

    public static func resolve(
        sharedOrigin: String?,
        localOrigin: String?,
        bundledOrigin: String?
    ) -> URL? {
        for value in [sharedOrigin, localOrigin, bundledOrigin] {
            guard
                let value,
                let candidate = URL(string: value),
                let origin = DashboardURLProvider(origin: candidate)?.origin
            else { continue }
            return origin
        }
        return nil
    }

    public static func current(bundle: Bundle = .main) -> URL? {
        let appGroup = bundle.object(forInfoDictionaryKey: "RELOAppGroup") as? String
        let shared = appGroup.flatMap(UserDefaults.init(suiteName:))
        return resolve(
            sharedOrigin: shared?.string(forKey: defaultsKey),
            localOrigin: UserDefaults.standard.string(forKey: defaultsKey),
            bundledOrigin: bundle.object(forInfoDictionaryKey: "RELOAPIOrigin") as? String
        )
    }

    public static func persist(_ origin: URL, bundle: Bundle = .main) {
        guard let normalized = DashboardURLProvider(origin: origin)?.origin else { return }
        UserDefaults.standard.set(normalized.absoluteString, forKey: defaultsKey)
        if
            let appGroup = bundle.object(forInfoDictionaryKey: "RELOAppGroup") as? String,
            let shared = UserDefaults(suiteName: appGroup)
        {
            shared.set(normalized.absoluteString, forKey: defaultsKey)
        }
    }
}

public struct HTTPMobileAPIClient: MobileAPIClient, @unchecked Sendable {
    private let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func consumeConnectionGrant(
        document: ReloConnectionDocument,
        installationId: String
    ) async throws -> AccountSession {
        struct Input: Encodable {
            let type: String; let grant: String; let installationId: String
        }
        struct Output: Decodable {
            struct Session: Decodable { let id: String; let expiresAt: Date }
            let sessionToken: String; let session: Session; let user: AccountUser
        }
        guard document.origin == baseURL else { throw MobileAPIError.invalidRequest }
        var request = request(path: "api/mobile/connection-grants/consume", method: "POST")
        request.httpBody = try Self.makeEncoder().encode(Input(
            type: document.type, grant: document.grant,
            installationId: installationId
        ))
        let (data, response) = try await data(for: request)
        switch response.statusCode {
        case 200:
            let output = try Self.decode(Output.self, from: data)
            return AccountSession(accessToken: output.sessionToken, sessionId: output.session.id,
                                  expiresAt: output.session.expiresAt, user: output.user)
        case 409: throw MobileAPIError.idempotencyConflict
        case 410: throw MobileAPIError.invalidRequest
        case 400: throw MobileAPIError.invalidRequest
        case 403: throw MobileAPIError.forbidden
        default: throw MobileAPIError.unavailable
        }
    }

    public func signIn(email: String, password: String) async throws -> AccountSession {
        var request = request(path: "api/auth/sign-in/email", method: "POST")
        request.httpBody = try Self.makeEncoder().encode(
            EmailSignInRequest(
                email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                password: password,
                rememberMe: true
            )
        )

        let (_, response) = try await data(for: request)
        switch response.statusCode {
        case 200:
            guard
                let token = response.value(forHTTPHeaderField: "set-auth-token")?.trimmingCharacters(in: .whitespacesAndNewlines),
                !token.isEmpty
            else { throw MobileAPIError.invalidResponse }
            return try await validateAccountSession(token: token)
        case 400:
            throw MobileAPIError.invalidRequest
        case 401:
            throw MobileAPIError.invalidCredentials
        case 403:
            throw MobileAPIError.accountDisabled
        case 429:
            throw MobileAPIError.rateLimited(retryAfterSeconds: Self.retryAfter(response))
        default:
            throw MobileAPIError.unavailable
        }
    }

    public func validateAccountSession(token: String) async throws -> AccountSession {
        var request = request(path: "api/auth/get-session")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await data(for: request)

        switch response.statusCode {
        case 200:
            let result = try Self.decode(SessionResponse.self, from: data)
            return AccountSession(
                accessToken: token,
                sessionId: result.session.id,
                expiresAt: result.session.expiresAt,
                user: result.user
            )
        case 401:
            throw MobileAPIError.reauthenticationRequired
        case 403:
            throw MobileAPIError.accountDisabled
        case 429:
            throw MobileAPIError.rateLimited(retryAfterSeconds: Self.retryAfter(response))
        default:
            throw MobileAPIError.unavailable
        }
    }

    public func registerDevice(
        sessionToken: String,
        request registration: DeviceRegistrationRequest,
        idempotencyKey: String
    ) async throws -> DeviceRegistrationResponse {
        var request = request(path: "api/devices/register", method: "POST")
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try Self.makeEncoder().encode(registration)
        let (data, response) = try await data(for: request)

        switch response.statusCode {
        case 200:
            return try Self.decode(DeviceRegistrationResponse.self, from: data)
        case 400:
            throw MobileAPIError.invalidRequest
        case 401:
            throw MobileAPIError.reauthenticationRequired
        case 403:
            throw MobileAPIError.accountDisabled
        case 409:
            throw MobileAPIError.idempotencyConflict
        case 429:
            throw MobileAPIError.rateLimited(retryAfterSeconds: Self.retryAfter(response))
        default:
            throw MobileAPIError.unavailable
        }
    }

    public func deviceSelf(credential: DeviceCredential) async throws -> DeviceSelfResponse {
        var request = request(path: "api/devices/self")
        request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await data(for: request)

        switch response.statusCode {
        case 200:
            return try Self.decode(DeviceSelfResponse.self, from: data)
        case 401:
            throw MobileAPIError.reauthenticationRequired
        case 403:
            throw MobileAPIError.forbidden
        default:
            throw MobileAPIError.unavailable
        }
    }

    public func deliveryTransportStatus(sessionToken: String) async throws -> DeliveryTransportStatus {
        var request = request(path: "api/account/deliveries/status")
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await data(for: request)

        switch response.statusCode {
        case 200:
            return try Self.decode(DeliveryTransportStatus.self, from: data)
        case 401:
            throw MobileAPIError.reauthenticationRequired
        case 403:
            throw MobileAPIError.forbidden
        case 429:
            throw MobileAPIError.rateLimited(retryAfterSeconds: Self.retryAfter(response))
        case 404:
            throw MobileAPIError.unavailable
        default:
            throw MobileAPIError.unavailable
        }
    }

    public func withdrawNotification(
        sessionToken: String,
        notificationID: String
    ) async throws {
        var request = request(
            path: "api/account/notifications/\(notificationID)/withdraw",
            method: "POST"
        )
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        let (_, response) = try await data(for: request)
        switch response.statusCode {
        case 200:
            return
        case 401:
            throw MobileAPIError.reauthenticationRequired
        case 403:
            throw MobileAPIError.forbidden
        case 404:
            throw MobileAPIError.invalidRequest
        case 429:
            throw MobileAPIError.rateLimited(retryAfterSeconds: Self.retryAfter(response))
        default:
            throw MobileAPIError.unavailable
        }
    }

    public func heartbeat(credential: DeviceCredential, heartbeat: DeviceHeartbeat) async throws {
        var request = request(path: "api/devices/\(credential.deviceId)", method: "PUT")
        request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try Self.makeEncoder().encode(heartbeat)
        let (_, response) = try await data(for: request)

        switch response.statusCode {
        case 200, 204:
            return
        case 401:
            throw MobileAPIError.reauthenticationRequired
        case 403:
            throw MobileAPIError.forbidden
        default:
            throw MobileAPIError.unavailable
        }
    }

    public func registerLiveActivityToken(
        credential: DeviceCredential,
        activityId: String,
        registration: LiveActivityTokenRegistration
    ) async throws {
        var request = request(
            path: "api/devices/self/live-activities/\(activityId)/token",
            method: "PUT"
        )
        request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try Self.makeEncoder().encode(registration)
        let (_, response) = try await data(for: request)

        switch response.statusCode {
        case 200, 204:
            return
        case 400, 404, 409:
            throw MobileAPIError.invalidRequest
        case 401:
            throw MobileAPIError.reauthenticationRequired
        case 403:
            throw MobileAPIError.forbidden
        case 429:
            throw MobileAPIError.rateLimited(retryAfterSeconds: Self.retryAfter(response))
        default:
            throw MobileAPIError.unavailable
        }
    }

    public func reportLiveActivityDismissed(
        credential: DeviceCredential,
        activityId: String
    ) async throws {
        var request = request(
            path: "api/devices/self/live-activities/\(activityId)/dismissed",
            method: "POST"
        )
        request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        let (_, response) = try await data(for: request)

        switch response.statusCode {
        case 200, 204:
            return
        case 400, 404:
            throw MobileAPIError.invalidRequest
        case 401:
            throw MobileAPIError.reauthenticationRequired
        case 403:
            throw MobileAPIError.forbidden
        case 429:
            throw MobileAPIError.rateLimited(retryAfterSeconds: Self.retryAfter(response))
        default:
            throw MobileAPIError.unavailable
        }
    }

    public func submitInteraction(
        credential: DeviceCredential,
        notificationId: String,
        action: NotificationInteractionAction,
        value: [String: String] = [:],
        idempotencyKey: String
    ) async throws {
        struct Submission: Encodable {
            let kind: NotificationInteractionAction
            let value: [String: String]
            let idempotencyKey: String
        }

        var request = request(path: "api/notifications/\(notificationId)/interactions", method: "POST")
        request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try Self.makeEncoder().encode(
            Submission(kind: action, value: value, idempotencyKey: idempotencyKey)
        )
        let (_, response) = try await data(for: request)

        switch response.statusCode {
        case 200, 201:
            return
        case 400:
            throw MobileAPIError.invalidRequest
        case 401:
            throw MobileAPIError.reauthenticationRequired
        case 403:
            throw MobileAPIError.forbidden
        case 409:
            throw MobileAPIError.idempotencyConflict
        default:
            throw MobileAPIError.unavailable
        }
    }

    public func revokeDevice(credential: DeviceCredential) async throws {
        var request = request(path: "api/devices/\(credential.deviceId)", method: "DELETE")
        request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        let (_, response) = try await data(for: request)

        switch response.statusCode {
        case 200, 204, 401:
            return
        case 403:
            throw MobileAPIError.forbidden
        default:
            throw MobileAPIError.unavailable
        }
    }

    public func signOutAccount(sessionToken: String) async throws {
        var request = request(path: "api/auth/sign-out", method: "POST")
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        let (_, response) = try await data(for: request)

        switch response.statusCode {
        case 200, 204, 401:
            return
        default:
            throw MobileAPIError.unavailable
        }
    }

    public func deleteAccount(
        sessionToken: String,
        password: String,
        confirmation: String
    ) async throws {
        struct Deletion: Encodable {
            let password: String
            let confirmation: String
        }
        struct Commit: Decodable {
            let ok: Bool
        }

        var request = request(path: "api/account/delete", method: "POST")
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try Self.makeEncoder().encode(
            Deletion(password: password, confirmation: confirmation)
        )
        let (data, response) = try await data(for: request)

        switch response.statusCode {
        case 200:
            let commit = try Self.decode(Commit.self, from: data)
            guard commit.ok else { throw MobileAPIError.invalidResponse }
            return
        case 400:
            throw MobileAPIError.invalidRequest
        case 401:
            if Self.errorCode(from: data) == "invalid_password" {
                throw MobileAPIError.invalidCredentials
            }
            throw MobileAPIError.reauthenticationRequired
        case 403:
            throw MobileAPIError.forbidden
        case 429:
            throw MobileAPIError.rateLimited(retryAfterSeconds: Self.retryAfter(response))
        default:
            throw MobileAPIError.unavailable
        }
    }

    private func request(path: String, method: String = "GET") -> URLRequest {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if method != "GET" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw MobileAPIError.invalidResponse
            }
            return (data, http)
        } catch let error as MobileAPIError {
            throw error
        } catch let error as URLError where [
            URLError.cannotFindHost,
            .dnsLookupFailed,
            .notConnectedToInternet,
            .networkConnectionLost,
        ].contains(error.code) {
            throw MobileAPIError.tailnetUnavailable
        } catch {
            throw MobileAPIError.unavailable
        }
    }

    private static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private static func decode<Value: Decodable>(_ type: Value.Type, from data: Data) throws -> Value {
        do {
            return try makeDecoder().decode(type, from: data)
        } catch {
            throw MobileAPIError.invalidResponse
        }
    }

    private static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fractional.date(from: value) { return date }
            let standard = ISO8601DateFormatter()
            standard.formatOptions = [.withInternetDateTime]
            if let date = standard.date(from: value) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid ISO 8601 date")
        }
        return decoder
    }

    private static func retryAfter(_ response: HTTPURLResponse) -> Int? {
        guard let value = response.value(forHTTPHeaderField: "Retry-After") else { return nil }
        return Int(value.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private static func errorCode(from data: Data) -> String? {
        struct ErrorEnvelope: Decodable { let error: String }
        return try? JSONDecoder().decode(ErrorEnvelope.self, from: data).error
    }
}

private struct EmailSignInRequest: Encodable {
    let email: String
    let password: String
    let rememberMe: Bool
}

private struct SessionResponse: Decodable {
    struct Session: Decodable {
        let id: String
        let expiresAt: Date
    }

    let session: Session
    let user: AccountUser
}
