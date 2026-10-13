import CryptoKit
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import ReloCore
@testable import ReloTransport

final class E2EEDeviceApprovalTests: XCTestCase {
    private let deviceID = "dev_00000000-0000-4000-8000-0000000000bb"
    private let phoneID = "dev_00000000-0000-4000-8000-00000000000a"

    func testSigningInputMatchesTheContractByteForByte() {
        let input = ReloDeviceApproval.signingInput(deviceID: deviceID, identityKey: "BAAA", phoneDeviceID: phoneID,
                                                    signedAt: "2026-10-14T00:00:00.000Z")
        XCTAssertEqual(input, Data(("relo.e2e.v1 approve-device\ndev_00000000-0000-4000-8000-0000000000bb\nBAAA\n"
            + "dev_00000000-0000-4000-8000-00000000000a\n2026-10-14T00:00:00.000Z").utf8))
    }

    func testRequestIsSignedByThePhoneIdentity() throws {
        let phone = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        let newKey = ReloE2EE.base64URL(P256.Signing.PrivateKey().publicKey.x963Representation)
        let device = ReloPendingDevice(deviceId: deviceID, name: "iPad", model: "iPad Pro", registeredAt: "2026-10-14T00:00:00.000Z",
                                       keyId: "k_abcdefghijklmnopqrstuv", identityKey: newKey)
        let now = Date(timeIntervalSince1970: 1_791_936_000.5)
        let request = try ReloDeviceApproval.request(for: device, phoneDeviceID: phoneID, signer: phone, now: now)
        XCTAssertEqual(request.deviceId, deviceID)
        XCTAssertEqual(request.identityKey, newKey)
        XCTAssertEqual(request.signedAt, "2026-10-14T00:00:00.500Z")
        let signature = try ReloE2EE.data(base64URL: request.signature, length: 64, field: "signature")
        let message = ReloDeviceApproval.signingInput(deviceID: deviceID, identityKey: newKey, phoneDeviceID: phoneID,
                                                      signedAt: request.signedAt)
        XCTAssertTrue(ReloE2EE.verify(signature: signature, message: message, publicKeyX963: phone.publicKeyX963))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: String])
        XCTAssertEqual(Set(json.keys), ["deviceId", "identityKey", "signedAt", "signature"])
    }

    func testPendingDeviceDisplay() {
        let device = ReloPendingDevice(deviceId: deviceID, name: " ", model: "iPad", registeredAt: "2026-10-14T00:00:00.000Z",
                                       keyId: "k_abcdefghijklmnopqrstuv", identityKey: "BAAA")
        XCTAssertEqual(device.displayName, "iPad")
        XCTAssertEqual(device.shortKeyID, "k_abcdefgh…")
        XCTAssertNotNil(device.registeredDate)
        XCTAssertNotNil(ReloPendingDevice(deviceId: deviceID, name: "iPad", registeredAt: "2026-10-14T00:00:00Z",
                                          keyId: "k_1", identityKey: "BAAA").registeredDate)
        XCTAssertTrue(ReloDeviceApproval.isDeviceID(deviceID))
        XCTAssertFalse(ReloDeviceApproval.isDeviceID("dev_../keys"))
        XCTAssertFalse(ReloDeviceApproval.isDeviceID("brw_00000000-0000-4000-8000-0000000000bb"))
    }

    func testSecuritySettingsDeepLink() throws {
        XCTAssertTrue(ReloDeepLink.isSecuritySettings(ReloDeepLink.securitySettingsURL))
        XCTAssertTrue(ReloDeepLink.isSecuritySettings(try XCTUnwrap(URL(string: "relo://settings/security/"))))
        XCTAssertFalse(ReloDeepLink.isSecuritySettings(try XCTUnwrap(URL(string: "relo://settings"))))
        XCTAssertFalse(ReloDeepLink.isSecuritySettings(try XCTUnwrap(URL(string: "https://settings/security"))))
        XCTAssertFalse(ReloDeepLink.isSecuritySettings(try XCTUnwrap(URL(string: "relo://settings/security?x=1"))))
        XCTAssertTrue(ReloDeepLink.opensSecuritySettings(relo: ["destination": "relo://settings/security"]))
        XCTAssertTrue(ReloDeepLink.opensSecuritySettings(relo: ["deepLink": "relo://settings/security"]))
        XCTAssertFalse(ReloDeepLink.opensSecuritySettings(relo: ["deepLink": "https://example.test/result"]))
        XCTAssertFalse(ReloDeepLink.opensSecuritySettings(relo: [:]))
    }

    // MARK: Transport

    private let credential = DeviceCredential(deviceId: "dev_00000000-0000-4000-8000-00000000000a", installationId: UUID(),
                                              accessToken: "device-token", issuedAt: .now, accountId: "account", credentialVersion: 1)
    private var client: HTTPMobileAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ApprovalStubURLProtocol.self]
        return HTTPMobileAPIClient(baseURL: URL(string: "http://192.168.1.10:8180")!, session: URLSession(configuration: configuration))
    }

    func testListsPendingDevicesWithTheDeviceCredential() async throws {
        let deviceID = deviceID, phoneID = phoneID
        ApprovalStubURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/devices/self/pending-devices")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-token")
            return (200, #"{"devices":[{"deviceId":"\#(deviceID)","name":"iPad","model":"iPad Pro","registeredAt":"2026-10-14T00:00:00.000Z","keyId":"k_1","identityKey":"BAAA"},{"deviceId":"\#(phoneID)","name":"Self","registeredAt":"2026-10-14T00:00:00.000Z","keyId":"k_2","identityKey":"BAAB"}]}"#)
        }
        let devices = try await client.pendingDevices(credential: credential)
        XCTAssertEqual(devices, [ReloPendingDevice(deviceId: deviceID, name: "iPad", model: "iPad Pro",
                                                   registeredAt: "2026-10-14T00:00:00.000Z", keyId: "k_1", identityKey: "BAAA")])

        ApprovalStubURLProtocol.handler = { _ in (404, "{}") }
        let none = try await client.pendingDevices(credential: credential)
        XCTAssertEqual(none, [])
        ApprovalStubURLProtocol.handler = { _ in (401, "{}") }
        do { _ = try await client.pendingDevices(credential: credential); XCTFail("expected 401") }
        catch { XCTAssertEqual(error as? MobileAPIError, .reauthenticationRequired) }
    }

    func testApprovePostsTheSignedBody() async throws {
        let deviceID = deviceID
        let approval = ReloDeviceApprovalRequest(deviceId: deviceID, identityKey: "BAAA", signedAt: "2026-10-14T00:00:00.000Z",
                                                 signature: String(repeating: "A", count: 86))
        ApprovalStubURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/devices/self/approvals")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-token")
            let body = try XCTUnwrap(ApprovalStubURLProtocol.body(request))
            XCTAssertEqual(try JSONDecoder().decode(ReloDeviceApprovalRequest.self, from: body), approval)
            return (200, "{}")
        }
        try await client.approveDevice(credential: credential, request: approval)
        for (status, expected) in [(404, DeviceApprovalError.unknownDevice), (409, .identityMismatch)] {
            ApprovalStubURLProtocol.handler = { _ in (status, "{}") }
            do { try await client.approveDevice(credential: credential, request: approval); XCTFail("expected \(status)") }
            catch { XCTAssertEqual(error as? DeviceApprovalError, expected) }
        }
    }

    func testDeclinePostsToTheDevicePath() async throws {
        let deviceID = deviceID
        ApprovalStubURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/devices/self/approvals/\(deviceID)/decline")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-token")
            return (204, "")
        }
        try await client.declineDevice(credential: credential, deviceID: deviceID)
        ApprovalStubURLProtocol.handler = { _ in (500, "") }
        do { try await client.declineDevice(credential: credential, deviceID: deviceID); XCTFail("expected failure") }
        catch { XCTAssertEqual(error as? MobileAPIError, .unavailable) }
        do { try await client.declineDevice(credential: credential, deviceID: "../keys"); XCTFail("expected rejection") }
        catch { XCTAssertEqual(error as? MobileAPIError, .invalidRequest) }
    }
}

private final class ApprovalStubURLProtocol: URLProtocol, @unchecked Sendable {
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
