import CryptoKit
import Foundation

/// The material for one native Sign in with Apple attempt. Apple sees only the nonce's SHA-256; the server gets
/// the raw nonce with the identity token and checks that they match. The PKCE pair lets an account that waits
/// for approval be picked up later, as after the browser sign-in.
public struct AppleSignIn: Equatable, Sendable {
    public let nonce: String
    public let verifier: String

    public init() {
        self.init(nonce: BrowserSignIn.randomToken(), verifier: BrowserSignIn.randomToken())
    }

    public init(nonce: String, verifier: String) {
        self.nonce = nonce
        self.verifier = verifier
    }

    /// What `ASAuthorizationAppleIDRequest.nonce` carries: the raw nonce's SHA-256, lowercase hex.
    public var hashedNonce: String {
        SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public var challenge: String { BrowserSignIn.challenge(forVerifier: verifier) }
}

/// Which sign-ins a server offers this app (`GET api/mobile/sign-in/methods`).
public struct SignInMethods: Decodable, Equatable, Sendable {
    public let apple: Bool

    public init(apple: Bool) { self.apple = apple }
}

/// Why the server did not sign this person in with Apple.
public enum AppleSignInRefusal: Error, Equatable, Sendable {
    /// The account exists and waits for the server admin's approval.
    case approvalPending
    case registrationClosed
    /// The email already has a password account; that person signs in with the password.
    case accountExists
    /// Apple's token did not check out (expired, or for another app).
    case invalidToken
    /// The server has no owner account to claim yet.
    case serverNotReady

    public init?(serverError: String) {
        switch serverError {
        case "approval_pending": self = .approvalPending
        case "registration_closed": self = .registrationClosed
        case "account_exists": self = .accountExists
        case "invalid_token": self = .invalidToken
        case "owner_not_bootstrapped": self = .serverNotReady
        default: return nil
        }
    }
}
