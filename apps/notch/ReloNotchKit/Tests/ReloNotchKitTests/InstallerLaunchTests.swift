import Foundation
import Testing
@testable import ReloNotchKit

@Suite struct InstallerLaunchTests {
    let code = "relo_signin_" + String(repeating: "a", count: 43)
    let verifier = String(repeating: "v", count: 43)

    @Test func readsTheOriginCodeAndVerifierTheInstallerPassed() {
        let launch = InstallerLaunch(arguments: ["Relo Notch", "--relo-origin", "https://relo.example.com/",
                                                 "--relo-sign-in-code", code, "--relo-code-verifier", verifier])
        #expect(launch?.origin?.host == "relo.example.com")
        #expect(launch?.signInCode == code)
        #expect(launch?.codeVerifier == verifier)
    }

    @Test func anOrdinaryLaunchHasNoInstallerArguments() {
        #expect(InstallerLaunch(arguments: ["Relo Notch"]) == nil)
        #expect(InstallerLaunch(arguments: ["Relo Notch", "--relo-origin"]) == nil)
    }

    @Test func aMalformedCodeOrVerifierIsDropped() {
        let launch = InstallerLaunch(arguments: ["x", "--relo-origin", "https://relo.example.com",
                                                 "--relo-sign-in-code", "nope", "--relo-code-verifier", "short"])
        #expect(launch?.origin != nil)
        #expect(launch?.signInCode == nil)
        #expect(launch?.codeVerifier == nil)
    }
}
