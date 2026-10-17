import Foundation
import XCTest
@testable import ReloCore

final class ComputerSignInTests: XCTestCase {
    private let server = URL(string: "https://relo.example")!

    func testReadsTheCodeFromTheCLIsLinkOnThisServer() throws {
        XCTAssertEqual(try ReloComputerSignIn.parse("https://relo.example/cli/authorize?code=AQND-M6L2", server: server), "AQND-M6L2")
        XCTAssertEqual(try ReloComputerSignIn.parse(" https://RELO.example:443/cli/authorize?code=aqnd m6l2\n", server: server), "AQND-M6L2")
        XCTAssertEqual(try ReloComputerSignIn.parse("aqndm6l2", server: server), "AQND-M6L2")
        let local = URL(string: "http://192.168.1.10:8180")!
        XCTAssertEqual(try ReloComputerSignIn.parse("http://192.168.1.10:8180/cli/authorize?code=ABCD-EFGH", server: local), "ABCD-EFGH")
    }

    func testRefusesAnotherServerOrAnythingElse() {
        XCTAssertThrowsError(try ReloComputerSignIn.parse("https://evil.example/cli/authorize?code=AQND-M6L2", server: server)) { error in
            XCTAssertEqual(error as? ReloComputerSignIn.ParseError, .otherServer("evil.example"))
        }
        XCTAssertThrowsError(try ReloComputerSignIn.parse("http://relo.example/cli/authorize?code=AQND-M6L2", server: server))
        for text in ["https://relo.example/other?code=AQND-M6L2", "https://relo.example/cli/authorize?code=AQND-M6L", "relo-link:1:x:y",
                     "ABCD-EFG0", "", "javascript:alert(1)"] {
            XCTAssertThrowsError(try ReloComputerSignIn.parse(text, server: server), text) { error in
                XCTAssertEqual(error as? ReloComputerSignIn.ParseError, .notASignInCode, text)
            }
        }
    }

    func testNormalizesOnlyTheUnambiguousAlphabet() {
        XCTAssertEqual(ReloComputerSignIn.normalize("abcd-efgh"), "ABCD-EFGH")
        XCTAssertNil(ReloComputerSignIn.normalize("ABCI-EFGH"))
        XCTAssertNil(ReloComputerSignIn.normalize("ABCD-EFG"))
    }
}

final class ComputerSignInNumberTests: XCTestCase {
    func testNumberMatchesTheSharedVectors() throws {
        struct Vector: Decodable { let userCode: String; let identityKey: String; let number: String }
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        let data = try Data(contentsOf: url.appendingPathComponent("packages/contracts/fixtures/signin-number-v1.json"))
        let vectors = try JSONDecoder().decode([Vector].self, from: data)
        XCTAssertFalse(vectors.isEmpty)
        for vector in vectors {
            XCTAssertEqual(ReloComputerSignIn.Number.compute(userCode: vector.userCode, identityKey: vector.identityKey), vector.number)
        }
    }

    func testChoicesHoldTheRealNumberAndTwoDistinctDecoys() {
        for real in ["00", "07", "46", "99"] {
            for _ in 0..<50 {
                let choices = ReloComputerSignIn.Number.choices(real: real)
                XCTAssertEqual(choices.count, 3)
                XCTAssertEqual(Set(choices).count, 3)
                XCTAssertTrue(choices.contains(real))
                XCTAssertTrue(choices.allSatisfy { $0.count == 2 })
            }
        }
    }

    func testRequestDecodesTheNewFieldsAndAnOlderRequestWithout() throws {
        let newer = Data(#"{"clientName":"build-box","scopes":["a"],"status":"pending","userCode":"ABCD-EFGH","expiresAt":"2026-10-17T10:00:00Z","identityKey":"BAEB","clientId":"key_1","keyPublished":true}"#.utf8)
        let request = try JSONDecoder().decode(ReloComputerSignIn.Request.self, from: newer)
        XCTAssertEqual(request.identityKey, "BAEB")
        XCTAssertEqual(request.clientId, "key_1")
        XCTAssertEqual(request.keyPublished, true)
        let older = Data(#"{"clientName":"build-box","scopes":[],"status":"pending","userCode":"ABCD-EFGH","expiresAt":"x","identityKey":null,"clientId":null,"keyPublished":false}"#.utf8)
        let decoded = try JSONDecoder().decode(ReloComputerSignIn.Request.self, from: older)
        XCTAssertNil(decoded.identityKey)
        XCTAssertNil(decoded.clientId)
        let bare = Data(#"{"clientName":"x","scopes":[],"status":"pending","userCode":"ABCD-EFGH","expiresAt":"x"}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(ReloComputerSignIn.Request.self, from: bare).identityKey)
    }

    func testApprovedKeyKeepsTheIdentityKeyItWasGiven() throws {
        let key = "BAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
        let approved = try XCTUnwrap(ReloComputerSignIn.approvedKey(clientId: "key_1", name: "build-box", identityKey: key))
        XCTAssertEqual(approved.publicKey, key)
        XCTAssertEqual(approved.clientId, "key_1")
        XCTAssertTrue(approved.keyId.hasPrefix("k_"))
        XCTAssertNil(ReloComputerSignIn.approvedKey(clientId: "key_1", name: "x", identityKey: "short"))
    }
}
