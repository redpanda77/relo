import CryptoKit
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import ReloCore
@testable import ReloTransport

final class E2EEBrowserLinkTests: XCTestCase {
    private let browserID = "brw_0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b"
    private let browserKey = P256.Signing.PrivateKey()
    private var identityKey: String { ReloE2EE.base64URL(browserKey.publicKey.x963Representation) }
    private var code: String { "relo-link:1:\(browserID):\(identityKey)" }

    func testParsesAWellFormedCode() throws {
        XCTAssertEqual(identityKey.count, 87)
        let parsed = try ReloBrowserLink.parse(code + "\n")
        XCTAssertEqual(parsed.browserID, browserID)
        XCTAssertEqual(parsed.identityKey, identityKey)
        XCTAssertEqual(parsed.identityKeyX963, browserKey.publicKey.x963Representation)
    }

    func testRejectsAnythingElse() {
        let offCurve = ReloE2EE.base64URL(Data([0x04] + Array(repeating: 0x01, count: 64)))
        let cases: [(String, ReloBrowserLink.ParseError)] = [
            ("https://relo.example/link", .notALinkCode),
            ("relo-link", .notALinkCode),
            ("relo-link:2:\(browserID):\(identityKey)", .unsupportedVersion),
            ("relo-link:1:\(browserID)", .notALinkCode),
            ("relo-link:1:\(browserID):\(identityKey):extra", .notALinkCode),
            ("relo-link:1:brw_0F1E2D3C-4B5A-4978-8A6B-5C4D3E2F1A0B:\(identityKey)", .invalidBrowserID),
            ("relo-link:1:dev_0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b:\(identityKey)", .invalidBrowserID),
            ("relo-link:1:brw_0f1e2d3c:\(identityKey)", .invalidBrowserID),
            ("relo-link:1:\(browserID):\(identityKey.dropLast())", .invalidIdentityKey),
            ("relo-link:1:\(browserID):\(identityKey)=", .invalidIdentityKey),
            ("relo-link:1:\(browserID):\(identityKey.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/"))+", .invalidIdentityKey),
            ("relo-link:1:\(browserID):\(offCurve)", .invalidIdentityKey),
        ]
        for (text, expected) in cases {
            XCTAssertThrowsError(try ReloBrowserLink.parse(text), text) { error in
                XCTAssertEqual(error as? ReloBrowserLink.ParseError, expected, text)
                XCTAssertNotNil((error as? LocalizedError)?.errorDescription)
            }
        }
    }

    func testSharedVectorMatchesTheCLIByteForByte() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "e2ee-v1", withExtension: "json"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let link = try XCTUnwrap(fixture["link"] as? [String: String])
        let keys = try XCTUnwrap(fixture["keys"] as? [String: [String: String]])
        let input = ReloBrowserLink.signingInput(browserID: try XCTUnwrap(link["browserId"]), identityKey: try XCTUnwrap(link["identityKey"]),
                                                 phoneDeviceID: try XCTUnwrap(link["phoneDeviceId"]), signedAt: try XCTUnwrap(link["signedAt"]))
        XCTAssertEqual(ReloE2EE.base64URL(input), link["input"])
        let phone = try ReloE2EE.data(base64URL: try XCTUnwrap(keys["deviceIdentity"]?["publicKey"]), field: "phone")
        let signature = try ReloE2EE.data(base64URL: try XCTUnwrap(link["signature"]), field: "signature")
        XCTAssertTrue(ReloE2EE.verify(signature: signature, message: input, publicKeyX963: phone))
    }

    func testSigningInputMatchesTheSpec() {
        let input = ReloBrowserLink.signingInput(browserID: browserID, identityKey: "KEY", phoneDeviceID: "dev_1",
                                                 signedAt: "2026-10-13T12:00:00.000Z")
        XCTAssertEqual(String(decoding: input, as: UTF8.self),
                       "relo.e2e.v1 link\n\(browserID)\nKEY\ndev_1\n2026-10-13T12:00:00.000Z")
    }

    func testRequestIsSignedByThePhoneIdentity() throws {
        let phone = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        let parsed = try ReloBrowserLink.parse(code)
        let now = Date(timeIntervalSince1970: 1_791_892_800.25)
        let request = try ReloBrowserLink.request(for: parsed, phoneDeviceID: "dev_phone", signer: phone, now: now)
        XCTAssertEqual(request.browserId, browserID)
        XCTAssertEqual(request.identityKey, identityKey)
        XCTAssertEqual(request.signedAt, "2026-10-13T12:00:00.250Z")
        let signature = try ReloE2EE.data(base64URL: request.signature, length: 64, field: "signature")
        let message = ReloBrowserLink.signingInput(browserID: browserID, identityKey: identityKey,
                                                   phoneDeviceID: "dev_phone", signedAt: request.signedAt)
        XCTAssertTrue(ReloE2EE.verify(signature: signature, message: message, publicKeyX963: phone.publicKeyX963))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: String])
        XCTAssertEqual(Set(json.keys), ["browserId", "identityKey", "signedAt", "signature"])
    }

    // MARK: Transport

    private let credential = DeviceCredential(deviceId: "dev_phone", installationId: UUID(), accessToken: "device-token",
                                              issuedAt: .now, accountId: "account", credentialVersion: 1)
    private var client: HTTPMobileAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LinkStubURLProtocol.self]
        return HTTPMobileAPIClient(baseURL: URL(string: "http://192.168.1.10:8180")!, session: URLSession(configuration: configuration))
    }

    private func linkRequest() -> ReloBrowserLinkRequest {
        ReloBrowserLinkRequest(browserId: browserID, identityKey: identityKey, signedAt: "2026-10-13T00:00:00.000Z",
                               signature: String(repeating: "A", count: 86))
    }

    func testLinkPostsTheSignedBodyWithTheDeviceCredential() async throws {
        let browserID = browserID
        LinkStubURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/devices/self/links")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-token")
            let body = try XCTUnwrap(LinkStubURLProtocol.body(request))
            let sent = try JSONDecoder().decode(ReloBrowserLinkRequest.self, from: body)
            XCTAssertEqual(sent.browserId, browserID)
            return (200, #"{"browserId":"\#(browserID)","name":"Safari on Mac","linkedAt":"2026-10-13T00:00:01.000Z"}"#)
        }
        let linked = try await client.linkBrowser(credential: credential, request: linkRequest())
        XCTAssertEqual(linked, ReloLinkedBrowser(browserId: browserID, name: "Safari on Mac", linkedAt: "2026-10-13T00:00:01.000Z"))
        XCTAssertNotNil(linked.linkedDate)
    }

    func testLinkMapsServerRefusals() async {
        for (status, expected) in [(404, BrowserLinkError.unknownBrowser), (409, .identityMismatch)] {
            LinkStubURLProtocol.handler = { _ in (status, #"{"error":"x"}"#) }
            do { _ = try await client.linkBrowser(credential: credential, request: linkRequest()); XCTFail("expected \(status)") }
            catch { XCTAssertEqual(error as? BrowserLinkError, expected) }
        }
        LinkStubURLProtocol.handler = { _ in (401, "{}") }
        do { _ = try await client.linkBrowser(credential: credential, request: linkRequest()); XCTFail("expected 401") }
        catch { XCTAssertEqual(error as? MobileAPIError, .reauthenticationRequired) }
        LinkStubURLProtocol.handler = { _ in (200, #"{"browserId":"brw_other","name":"x","linkedAt":"x"}"#) }
        do { _ = try await client.linkBrowser(credential: credential, request: linkRequest()); XCTFail("expected mismatch") }
        catch { XCTAssertEqual(error as? MobileAPIError, .invalidResponse) }
    }

    func testListsAndUnlinksBrowsers() async throws {
        let browserID = browserID
        LinkStubURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/devices/self/links")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-token")
            return (200, #"{"browsers":[{"browserId":"\#(browserID)","name":"Chrome","linkedAt":"2026-10-13T00:00:01.000Z"}]}"#)
        }
        let browsers = try await client.linkedBrowsers(credential: credential)
        XCTAssertEqual(browsers.map(\.browserId), [browserID])

        LinkStubURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertEqual(request.url?.path, "/api/devices/self/links/\(browserID)")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-token")
            return (204, "")
        }
        try await client.unlinkBrowser(credential: credential, browserID: browserID)

        LinkStubURLProtocol.handler = { _ in (500, "") }
        do { try await client.unlinkBrowser(credential: credential, browserID: browserID); XCTFail("expected failure") }
        catch { XCTAssertEqual(error as? MobileAPIError, .unavailable) }
        do { try await client.unlinkBrowser(credential: credential, browserID: "../keys"); XCTFail("expected rejection") }
        catch { XCTAssertEqual(error as? MobileAPIError, .invalidRequest) }
    }
}

private final class LinkStubURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (Int, String)
    private static let lock = NSLock()
    nonisolated(unsafe) private static var stored: Handler?
    static var handler: Handler? {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }

    static func body(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(contentsOf: buffer[0..<count])
        }
        return data
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: MobileAPIError.unavailable)
            return
        }
        do {
            let (status, body) = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
