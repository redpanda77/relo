import Foundation
import ReloCore

/// What the install script hands Relo for Mac when it opens it (`relo auth join --mac-app`, docs/site/guides/servers.md):
/// the server's origin and, for a code made with Relo for Mac, a one-time sign-in code with the PKCE verifier only this
/// launch was given. Read once, at start.
public struct InstallerLaunch: Equatable, Sendable {
    public let origin: URL?
    public let signInCode: String?
    public let codeVerifier: String?

    public init?(arguments: [String]) {
        func value(_ flag: String) -> String? {
            guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else { return nil }
            return arguments[index + 1]
        }
        let origin = value("--relo-origin").flatMap(URL.init(string:)).flatMap { DashboardURLProvider(origin: $0)?.origin }
        let code = value("--relo-sign-in-code").flatMap { $0.range(of: #"^relo_signin_[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil ? $0 : nil }
        let verifier = value("--relo-code-verifier").flatMap { $0.range(of: #"^[A-Za-z0-9._~-]{43,128}$"#, options: .regularExpression) != nil ? $0 : nil }
        guard origin != nil else { return nil }
        self.origin = origin
        self.signInCode = code
        self.codeVerifier = verifier
    }
}
