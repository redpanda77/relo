import CryptoKit
import Foundation
import XCTest
@testable import ReloCore

final class AppleSignInTests: XCTestCase {
    func testAppleSeesOnlyTheNoncesHash() {
        let attempt = AppleSignIn(nonce: "raw-nonce-abcdefghijklmnop", verifier: String(repeating: "v", count: 43))
        let expected = SHA256.hash(data: Data("raw-nonce-abcdefghijklmnop".utf8)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(attempt.hashedNonce, expected)
        XCTAssertNotEqual(attempt.hashedNonce, attempt.nonce)
        XCTAssertEqual(attempt.challenge, BrowserSignIn.challenge(forVerifier: attempt.verifier))
    }

    func testEachAttemptHasItsOwnNonce() {
        XCTAssertNotEqual(AppleSignIn().nonce, AppleSignIn().nonce)
    }

    func testServerRefusalsReadAsReasons() {
        XCTAssertEqual(AppleSignInRefusal(serverError: "account_exists"), .accountExists)
        XCTAssertEqual(AppleSignInRefusal(serverError: "registration_closed"), .registrationClosed)
        XCTAssertEqual(AppleSignInRefusal(serverError: "owner_not_bootstrapped"), .serverNotReady)
        XCTAssertNil(AppleSignInRefusal(serverError: "something_else"))
    }
}
