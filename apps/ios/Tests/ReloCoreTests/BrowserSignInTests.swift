import Foundation
import Testing
@testable import ReloCore

struct BrowserSignInTests {
    private let code = "relo_signin_" + String(repeating: "a", count: 43)

    // Vector cross-checked with `openssl dgst -sha256 -binary | base64url`.
    @Test func challengeIsBase64URLSHA256OfVerifier() {
        let flow = BrowserSignIn(verifier: "dBjftJeZ4CVP-mJ0kE7yLxD8x2wRMCJ8XTA47uXpT9Q", state: "s")
        #expect(flow.challenge == "-l2xUJvSb7OZvgylRQfbFgfHLuxlpow6-6Z4au0nriY")
    }

    @Test func generatedValuesAreUnpaddedBase64URL() {
        let flow = BrowserSignIn()
        #expect(flow.verifier.count == 43 && flow.challenge.count == 43 && flow.state.count == 43)
        #expect(BrowserSignIn().state != flow.state)
        for value in [flow.verifier, flow.challenge, flow.state] {
            #expect(value.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
        }
    }

    @Test func authorizationURLCarriesChallengeRedirectAndState() throws {
        let flow = BrowserSignIn(verifier: "v", state: "st")
        let url = try #require(flow.authorizationURL(origin: URL(string: "https://relo.example.test")!))
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(components.path == "/mobile/sign-in")
        let items = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(items["code_challenge"] == flow.challenge)
        #expect(items["code_challenge_method"] == "S256")
        #expect(items["redirect_uri"] == "relo://auth/callback")
        #expect(items["state"] == "st")
        #expect(items["code_verifier"] == nil)
    }

    @Test func callbackWithMatchingStateYieldsCode() throws {
        let flow = BrowserSignIn(verifier: "v", state: "st")
        let outcome = try flow.parse(callback: URL(string: "relo://auth/callback?code=\(code)&state=st")!)
        #expect(outcome == .code(code))
    }

    @Test func callbackWithWrongStateIsRejected() {
        let flow = BrowserSignIn(verifier: "v", state: "st")
        #expect(throws: BrowserSignIn.CallbackError.stateMismatch) {
            try flow.parse(callback: URL(string: "relo://auth/callback?code=\(code)&state=other")!)
        }
        #expect(throws: BrowserSignIn.CallbackError.stateMismatch) {
            try flow.parse(callback: URL(string: "relo://auth/callback?code=\(code)")!)
        }
    }

    @Test func accessDeniedMapsToCancelled() throws {
        let flow = BrowserSignIn(verifier: "v", state: "st")
        let outcome = try flow.parse(callback: URL(string: "relo://auth/callback?error=access_denied&state=st")!)
        #expect(outcome == .cancelled)
    }

    @Test func otherSchemesHostsPathsAndErrorsAreRejected() {
        let flow = BrowserSignIn(verifier: "v", state: "st")
        for raw in [
            "https://auth/callback?code=\(code)&state=st",
            "relo://evil/callback?code=\(code)&state=st",
            "relo://auth/other?code=\(code)&state=st",
            "relo://auth/callback?error=server_error&state=st",
            "relo://auth/callback?code=nope&state=st",
            "relo://auth/callback?state=st"
        ] {
            #expect(throws: BrowserSignIn.CallbackError.malformed) { try flow.parse(callback: URL(string: raw)!) }
        }
    }
}
