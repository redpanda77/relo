import CryptoKit
import Foundation

/// PKCE material and callback parsing for the browser sign-in flow. The verifier never leaves the
/// device until the token exchange; the browser only sees the challenge and the state.
public struct BrowserSignIn: Equatable, Sendable {
    public static let callbackScheme = "relo"
    public static let redirectURI = "relo://auth/callback"

    public enum CallbackOutcome: Equatable, Sendable {
        case code(String)
        case cancelled
    }

    public enum CallbackError: Error, Equatable, Sendable {
        case malformed
        case stateMismatch
    }

    public let verifier: String
    public let challenge: String
    public let state: String

    public init() {
        self.init(verifier: Self.randomToken(), state: Self.randomToken())
    }

    public init(verifier: String, state: String) {
        self.verifier = verifier
        self.state = state
        self.challenge = Self.challenge(forVerifier: verifier)
    }

    public static func challenge(forVerifier verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    /// `<origin>/mobile/sign-in` with the PKCE challenge, redirect and state.
    public func authorizationURL(origin: URL) -> URL? {
        guard var components = URLComponents(url: origin.appendingPathComponent("mobile/sign-in"), resolvingAgainstBaseURL: false) else { return nil }
        components.queryItems = [
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "redirect_uri", value: Self.redirectURI),
            URLQueryItem(name: "state", value: state)
        ]
        return components.url
    }

    /// Accepts only `relo://auth/callback` carrying the state this attempt sent.
    public func parse(callback url: URL) throws -> CallbackOutcome {
        guard url.scheme == Self.callbackScheme,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.host == "auth", components.path == "/callback"
        else { throw CallbackError.malformed }
        let items = components.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard value("state") == state else { throw CallbackError.stateMismatch }
        if let error = value("error") {
            if error == "access_denied" { return .cancelled }
            throw CallbackError.malformed
        }
        guard let code = value("code"), code.hasPrefix("relo_signin_") else { throw CallbackError.malformed }
        return .code(code)
    }

    private static func randomToken() -> String {
        var generator = SystemRandomNumberGenerator()
        return base64URL(Data((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) }))
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
