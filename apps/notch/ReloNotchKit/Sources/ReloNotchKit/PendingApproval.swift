import Foundation
import ReloCore
import ReloNotificationSupport
import Security

/// A browser sign-in that ended with "your account is waiting for approval": the server handed the app a one-time
/// ticket instead of a sign-in code. The app keeps it (so a quit does not lose it) and asks the server now and then
/// whether the owner approved; once approved the same answer is the account session a sign-in code would have given.
public struct PendingSignIn: Codable, Equatable, Sendable {
    public var origin: URL
    public var ticket: String
    /// The PKCE verifier of the sign-in that was started: the server checks it against the challenge it saw.
    public var codeVerifier: String
    public var installationId: String
    public var startedAt: Date

    public init(origin: URL, ticket: String, codeVerifier: String, installationId: String, startedAt: Date) {
        self.origin = origin; self.ticket = ticket; self.codeVerifier = codeVerifier
        self.installationId = installationId; self.startedAt = startedAt
    }

    /// The server as the owner reads it in a sentence.
    public var host: String { origin.host(percentEncoded: false) ?? ReloNotchStore.displayAddress(of: origin) }
}

/// Where the pending sign-in is kept. The ticket and verifier are secrets: Keychain, this Mac only.
public protocol PendingSignInStore: Sendable {
    func load() throws -> PendingSignIn?
    func save(_ pending: PendingSignIn) throws
    func delete() throws
}

public struct KeychainPendingSignInStore: PendingSignInStore {
    private let service: String
    private let account: String

    public init(service: String = "com.example.relo.notifications", account: String = "pending-sign-in") {
        self.service = service
        self.account = account
    }

    public func load() throws -> PendingSignIn? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw CredentialStoreError.keychain(status) }
        return try? ReloWireJSON.decoder().decode(PendingSignIn.self, from: data)
    }

    public func save(_ pending: PendingSignIn) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(pending)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insertion = baseQuery
            attributes.forEach { insertion[$0.key] = $0.value }
            let added = SecItemAdd(insertion as CFDictionary, nil)
            guard added == errSecSuccess else { throw CredentialStoreError.keychain(added) }
        } else if status != errSecSuccess {
            throw CredentialStoreError.keychain(status)
        }
    }

    public func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CredentialStoreError.keychain(status) }
    }

    private var baseQuery: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        #if os(macOS)
        // As the other credentials: the data-protection keychain when the app is signed for it.
        if ReloDataProtectionKeychain.available { query[kSecUseDataProtectionKeychain as String] = true }
        #endif
        return query
    }
}

/// A store in memory (tests, and a Mac whose Keychain refuses).
public final class MemoryPendingSignInStore: PendingSignInStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: PendingSignIn?
    public init(_ value: PendingSignIn? = nil) { self.value = value }
    public func load() throws -> PendingSignIn? { lock.withLock { value } }
    public func save(_ pending: PendingSignIn) throws { lock.withLock { value = pending } }
    public func delete() throws { lock.withLock { value = nil } }
}

/// The browser's callback for an account that waits: `relo://auth/callback?pending=<ticket>&state=<state>`.
public enum PendingSignInCallback {
    static let ticketPrefix = "relo_pending_"

    /// The ticket when the callback is a pending one for this attempt; nil when it carries no `pending` (a code, a
    /// cancel: `BrowserSignIn.parse` reads those). The state is checked as for a code.
    public static func ticket(in url: URL, flow: BrowserSignIn) throws -> String? {
        guard url.scheme == BrowserSignIn.callbackScheme,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.host == "auth", components.path == "/callback" else { return nil }
        let items = components.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard let ticket = value("pending") else { return nil }
        guard value("state") == flow.state else { throw BrowserSignIn.CallbackError.stateMismatch }
        guard value("code") == nil, value("error") == nil, isTicket(ticket) else { throw BrowserSignIn.CallbackError.malformed }
        return ticket
    }

    static func isTicket(_ text: String) -> Bool {
        guard text.hasPrefix(ticketPrefix) else { return false }
        let body = text.dropFirst(ticketPrefix.count)
        return body.count == 43 && body.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }
}

/// Asking the server whether a waiting account was approved: pure request and response functions, one injectable
/// sender, and the watch loop with its backoff.
public enum PendingApproval {
    public enum Outcome: Equatable, Sendable {
        case pending
        case approved(AccountSession)
        case declined
        case expired
        /// The server does not know the ticket (used, or the verifier is wrong): there is nothing left to wait for.
        case invalid
        /// Not answered now (offline, a busy server): ask again later.
        case retry
    }

    public enum Finish: Equatable, Sendable {
        case approved(AccountSession)
        case declined, expired, invalid
        case cancelled
    }

    /// While the app runs: ask every 30 s, and every 5 min once the request is an hour old.
    public static let quickInterval: TimeInterval = 30
    public static let slowInterval: TimeInterval = 300
    public static let slowAfter: TimeInterval = 3600

    public static func interval(startedAt: Date, now: Date) -> TimeInterval {
        now.timeIntervalSince(startedAt) >= slowAfter ? slowInterval : quickInterval
    }

    public typealias Sender = @Sendable (URLRequest) async throws -> (Data, Int)

    public static func request(for pending: PendingSignIn) -> URLRequest {
        var request = URLRequest(url: pending.origin.appendingPathComponent("api/mobile/sign-in/pending"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        struct Body: Encodable { let ticket: String; let codeVerifier: String; let installationId: String }
        request.httpBody = try? JSONEncoder().encode(Body(ticket: pending.ticket, codeVerifier: pending.codeVerifier,
                                                          installationId: pending.installationId))
        return request
    }

    /// The server's answer: 202 pending, 410 declined or expired, 400 an unknown ticket, 200 the session (the body
    /// `POST /api/mobile/sign-in/token` returns). Anything else is tried again later.
    public static func outcome(status: Int, data: Data) -> Outcome {
        struct Status: Decodable { let status: String }
        struct Token: Decodable {
            struct Session: Decodable { let id: String; let expiresAt: Date }
            let sessionToken: String; let session: Session; let user: AccountUser
        }
        switch status {
        case 200:
            guard let token = try? ReloWireJSON.decoder().decode(Token.self, from: data) else { return .retry }
            return .approved(AccountSession(accessToken: token.sessionToken, sessionId: token.session.id,
                                            expiresAt: token.session.expiresAt, user: token.user))
        case 202: return .pending
        case 410: return (try? JSONDecoder().decode(Status.self, from: data))?.status == "declined" ? .declined : .expired
        case 400: return .invalid
        default: return .retry
        }
    }

    /// One poll. A failed request is "ask again later", never an end.
    public static func check(_ pending: PendingSignIn, send: Sender) async -> Outcome {
        guard let (data, status) = try? await send(request(for: pending)) else { return .retry }
        return outcome(status: status, data: data)
    }

    /// Asks now, then every interval until the answer is final. `sleep` is injected so tests do not wait.
    public static func watch(_ pending: PendingSignIn, now: @Sendable () -> Date = { Date() }, send: Sender,
                             sleep: @Sendable (TimeInterval) async throws -> Void) async -> Finish {
        while !Task.isCancelled {
            switch await check(pending, send: send) {
            case .approved(let session): return .approved(session)
            case .declined: return .declined
            case .expired: return .expired
            case .invalid: return .invalid
            case .pending, .retry: break
            }
            do { try await sleep(interval(startedAt: pending.startedAt, now: now())) } catch { return .cancelled }
        }
        return .cancelled
    }

    /// The real sender: Relo's own cookie-less session.
    public static func urlSessionSender(_ session: URLSession = .shared) -> Sender {
        { request in
            let (data, response) = try await session.data(for: request)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        }
    }

    // MARK: Words

    /// The one line every surface shows while the account waits. Without Relo on this Mac (this Mac cannot run it) the
    /// line only says what happens next.
    public static func waitingLine(host: String, localWorks: Bool = true) -> String {
        localWorks
            ? "Your account is waiting for approval on \(host). Relo works on this Mac meanwhile and signs in by itself once you're approved."
            : "Your account is waiting for approval on \(host). Relo signs in by itself once you're approved."
    }
    public static let cancelRequest = "Cancel request"
    public static func approved(host: String) -> String { "You're approved: Relo is now synced with \(host)." }
    public static func approvedNotFinished(host: String) -> String {
        "You're approved on \(host), but Relo could not finish signing in. Sign in from Settings."
    }
    public static func declined(host: String) -> String { "Your request to join \(host) was declined. Relo keeps working on this Mac." }
    public static func expired(host: String) -> String {
        "Your request on \(host) ran out before it was approved. Sign in again to ask once more."
    }
    /// What the owner reads when the wait ended without approval.
    public static func endedLine(_ finish: Finish, host: String) -> String? {
        switch finish {
        case .declined: declined(host: host)
        case .expired, .invalid: expired(host: host)
        case .approved, .cancelled: nil
        }
    }
    /// Signed out with a server chosen (setup closed or sign-in cancelled): Relo on this Mac is not blocked.
    public static let signInLater = "You can use Relo on this Mac now and sign in later."
}
