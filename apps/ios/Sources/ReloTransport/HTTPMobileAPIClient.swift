import ReloCore
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The one session for Relo's API: token-authenticated only, so it never stores or sends
/// cookies. A cookie left by an old email sign-in made Better Auth treat requests as
/// browser requests and refuse sign-out without an Origin header (403).
public enum ReloAPISession {
    public static let shared: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpCookieStorage = nil
        return URLSession(configuration: configuration)
    }()
}

public struct HTTPMobileAPIClient: MobileAPIClient, Sendable {
    private let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = ReloAPISession.shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func exchangeBrowserSignIn(
        code: String,
        codeVerifier: String,
        installationId: String
    ) async throws -> AccountSession {
        struct Input: Encodable {
            let code: String; let codeVerifier: String; let installationId: String
        }
        struct Output: Decodable {
            struct Session: Decodable { let id: String; let expiresAt: Date }
            let sessionToken: String; let session: Session; let user: AccountUser
        }
        var request = request(path: "api/mobile/sign-in/token", method: "POST")
        request.httpBody = try Self.makeEncoder().encode(Input(
            code: code, codeVerifier: codeVerifier, installationId: installationId
        ))
        let (data, response) = try await data(for: request)
        switch response.statusCode {
        case 200:
            let output = try Self.decode(Output.self, from: data)
            return AccountSession(accessToken: output.sessionToken, sessionId: output.session.id,
                                  expiresAt: output.session.expiresAt, user: output.user)
        case 400: throw MobileAPIError.invalidRequest
        case 403: throw MobileAPIError.accountDisabled
        default: throw MobileAPIError.unavailable
        }
    }

    public func validateAccountSession(token: String) async throws -> AccountSession {
        var request = request(path: "api/auth/get-session")
        request.authorize(bearer: token)
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
        request.authorize(bearer: sessionToken)
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
        request.authorize(bearer: credential.accessToken)
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
        request.authorize(bearer: sessionToken)
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
        request.authorize(bearer: sessionToken)
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
        request.authorize(bearer: credential.accessToken)
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
        request.authorize(bearer: credential.accessToken)
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
        request.authorize(bearer: credential.accessToken)
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

    /// Dismisses a missed question from Needs you (`POST api/devices/self/questions/{id}/dismiss`, device
    /// bearer). The server derives the change; 404 means the question is no longer dismissable.
    public func dismissMissedQuestion(credential: DeviceCredential, questionId: String) async throws {
        guard questionId.hasPrefix("int_"), questionId.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" })
        else { throw MobileAPIError.invalidRequest }
        var request = request(path: "api/devices/self/questions/\(questionId)/dismiss", method: "POST")
        request.authorize(bearer: credential.accessToken)
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
        request.authorize(bearer: credential.accessToken)
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

    public func submitDecision(
        credential: DeviceCredential, response: PendingNotificationResponse
    ) async throws -> NotificationDecisionAcknowledgement {
        guard response.endpoint == .notification, let interactionID = response.interactionID,
              response.serverOrigin == baseURL, response.hasValidOption,
              response.accountID == credential.accountId, response.deviceID == credential.deviceId
        else { throw MobileAPIError.invalidRequest }
        guard response.expiresAt > .now else { throw MobileAPIError.decisionRejected(.expired) }
        struct Submission: Encodable {
            let kind: NotificationInteractionAction
            let value: [String: String]
            let idempotencyKey: String
            let expectedInteractionId: String
        }
        struct Accepted: Decodable { let decision: NotificationDecisionAcknowledgement }
        struct Rejected: Decodable { let error: String; let state: String? }
        var request = request(path: "api/notifications/\(response.notificationID)/interactions", method: "POST")
        request.timeoutInterval = 5
        request.authorize(bearer: credential.accessToken)
        request.httpBody = try Self.makeEncoder().encode(Submission(kind: response.action, value: response.value,
            idempotencyKey: response.idempotencyKey, expectedInteractionId: interactionID))
        let (bytes, http) = try await data(for: request)
        switch http.statusCode {
        case 200, 201:
            guard let result = try? ReloWireJSON.decoder().decode(Accepted.self, from: bytes) else {
                throw MobileAPIError.invalidResponse
            }
            try result.decision.validate(response)
            return result.decision
        case 400: throw MobileAPIError.invalidRequest
        case 401: throw MobileAPIError.reauthenticationRequired
        case 403: throw MobileAPIError.forbidden
        case 404: throw MobileAPIError.decisionRejected(.unavailable)
        case 409:
            let result = try? JSONDecoder().decode(Rejected.self, from: bytes)
            switch result?.error {
            case "interaction_superseded": throw MobileAPIError.decisionRejected(.superseded)
            case "interaction_version_mismatch": throw MobileAPIError.decisionRejected(.versionMismatch)
            case "interaction_not_pending":
                throw MobileAPIError.decisionRejected(result?.state == "expired" ? .expired : .answered)
            default: throw MobileAPIError.idempotencyConflict
            }
        case 429: throw MobileAPIError.rateLimited(retryAfterSeconds: Self.retryAfter(http))
        default: throw MobileAPIError.unavailable
        }
    }

    public func revokeDevice(credential: DeviceCredential) async throws {
        var request = request(path: "api/devices/\(credential.deviceId)", method: "DELETE")
        request.authorize(bearer: credential.accessToken)
        let (_, response) = try await data(for: request)

        switch response.statusCode {
        case 200, 204, 401, 404:
            // 401/404: the credential or device is already gone, which is what revoking wants.
            return
        case 403:
            throw MobileAPIError.forbidden
        default:
            throw MobileAPIError.unavailable
        }
    }

    public func signOutAccount(sessionToken: String) async throws {
        var request = request(path: "api/auth/sign-out", method: "POST")
        request.authorize(bearer: sessionToken)
        // The auth endpoint rejects a JSON request without a body (400), which paused every sign-out.
        request.httpBody = Data("{}".utf8)
        let (_, response) = try await data(for: request)

        switch response.statusCode {
        case 200, 204, 401, 404:
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
        request.authorize(bearer: sessionToken)
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

    func request(path: String, method: String = "GET") -> URLRequest {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if method != "GET" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
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
            throw MobileAPIError.serverUnreachable
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
            return try ReloWireJSON.decoder().decode(type, from: data)
        } catch {
            throw MobileAPIError.invalidResponse
        }
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
