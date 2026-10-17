import XCTest
@testable import ReloCore

final class BrowserLinkRequestTests: XCTestCase {
    private func b64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// 0x04 then 1...64: the cross-platform vector the Dashboard pins too.
    private var vectorKey: Data { Data([0x04] + (1...64).map { UInt8($0) }) }

    func testLinkCodeIsTheFirstThreeFingerprintGroups() {
        let groups = ReloE2EE.fingerprintGroups(vectorKey)
        let code = ReloBrowserLink.linkCode(identityKeyX963: vectorKey)
        XCTAssertEqual(code, groups.prefix(3).joined(separator: " "))
        XCTAssertEqual(code, ReloBrowserLink.linkCode(identityKey: b64url(vectorKey)))
        XCTAssertNotNil(code.range(of: #"^\d{5} \d{5} \d{5}$"#, options: .regularExpression))
        XCTAssertEqual(code, "76037 78271 31032")
    }

    func testLinkCodeRejectsMalformedKeys() {
        XCTAssertNil(ReloBrowserLink.linkCode(identityKey: "AAAA"))
        XCTAssertNil(ReloBrowserLink.linkCode(identityKey: ""))
    }

    func testListDecodesAndBuildsTheScannedCode() throws {
        let key = try XCTUnwrap(ReloBrowserLink.parse(sampleLink()).identityKey)
        let json = """
        {"browsers":[{"browserId":"\(Self.browserID)","name":"Chrome on Mac","keyId":"k1",
        "identityKey":"\(key)","requestedAt":"2026-10-17T10:00:00.000Z"}]}
        """
        struct Response: Decodable { let browsers: [ReloPendingBrowser] }
        let browser = try XCTUnwrap(JSONDecoder().decode(Response.self, from: Data(json.utf8)).browsers.first)
        XCTAssertEqual(browser.id, Self.browserID)
        XCTAssertNotNil(browser.requestedDate)
        XCTAssertEqual(browser.linkCode, ReloBrowserLink.linkCode(identityKey: key))
        let code = try browser.code()
        XCTAssertEqual(code.browserID, Self.browserID)
        XCTAssertEqual(code.identityKey, key)
    }

    func testMalformedKeyHasNoCodeAndCannotBeLinked() {
        let browser = ReloPendingBrowser(browserId: Self.browserID, name: "x", keyId: "k", identityKey: "nope", requestedAt: "")
        XCTAssertNil(browser.linkCode)
        XCTAssertThrowsError(try browser.code())
    }

    func testBrowserDeepLinks() throws {
        let url = try XCTUnwrap(ReloDeepLink.accessRequestURL(id: Self.browserID))
        XCTAssertEqual(ReloDeepLink.accessRequestID(from: url), Self.browserID)
        XCTAssertEqual(ReloDeepLink.accessRequestID(relo: ["deepLink": url.absoluteString]), Self.browserID)
        XCTAssertNil(ReloDeepLink.accessRequestID(from: try XCTUnwrap(URL(string: "relo://security/request/brw_x"))))
    }

    func testBrowserNotificationNeverApproves() {
        XCTAssertEqual(ReloBrowserLinkNotification.categoryIdentifier, "RELO_BROWSER_LINK")
        XCTAssertNotEqual(ReloBrowserLinkNotification.reviewAction, ReloAccessRequestNotification.approveAction)
    }

    private static let browserID = "brw_123e4567-e89b-12d3-a456-426614174000"

    /// A real P-256 key in the scanned format.
    private func sampleLink() -> String {
        let key = P256Sample.publicKeyX963()
        return "relo-link:1:\(Self.browserID):\(b64url(key))"
    }
}

import CryptoKit
private enum P256Sample {
    static func publicKeyX963() -> Data { P256.Signing.PrivateKey().publicKey.x963Representation }
}
