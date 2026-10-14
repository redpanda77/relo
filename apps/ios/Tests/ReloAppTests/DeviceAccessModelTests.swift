import CryptoKit
import Foundation
import XCTest
@testable import ReloCore
@testable import Relo

/// The Devices screen's model: what waits for approval, approving and declining phones and computers,
/// and the one line about this iPhone.
@MainActor
final class DeviceAccessModelTests: XCTestCase {
    private let credential = DeviceCredential(deviceId: "dev_00000000-0000-4000-8000-00000000000a", installationId: UUID(),
                                              accessToken: "device-token", issuedAt: .now, accountId: "account", credentialVersion: 1)
    private let newPhone = ReloPendingDevice(deviceId: "dev_00000000-0000-4000-8000-0000000000bb", name: "iPhone", model: "iPhone18,4",
                                            registeredAt: "2026-10-14T00:00:00.000Z", keyId: "k_1",
                                            identityKey: ReloE2EE.base64URL(P256.Signing.PrivateKey().publicKey.x963Representation),
                                            isSimulator: true)

    private func makeModel() -> (EncryptionSecurityModel, FakeServer) {
        let ring = ReloKeyRing(store: MemoryKeyRing(), factory: ReloSoftwareKeyFactory())
        let model = EncryptionSecurityModel(ring: ring, trust: ReloTrustedClients(store: MemoryTrust()),
                                            linked: ReloLinkedBrowsers(store: MemoryBrowsers()))
        return (model, FakeServer())
    }

    private func signer() throws -> any ReloIdentitySigning {
        try ReloSoftwareKeyFactory().signer(for: ReloSoftwareKeyFactory().makeIdentity())
    }

    func testAWaitingPhoneIsListedWithAFriendlyName() async {
        let (model, server) = makeModel()
        server.pending = [newPhone]
        await model.refresh(credential: credential, client: server)

        XCTAssertTrue(model.pendingLoaded)
        let request = model.waitingRequests.first
        XCTAssertEqual(model.waitingRequests.map(\.id), [newPhone.deviceId])
        XCTAssertEqual(request?.name, "iPhone Air")
        XCTAssertEqual(request?.headline, "iPhone Air · Simulator")
        XCTAssertNil(request?.subline)
        XCTAssertEqual(request?.declineLine, "Sign it out. It won't be able to read anything.")
        XCTAssertEqual(model.request(id: newPhone.deviceId), request)
        XCTAssertNil(model.request(id: "dev_00000000-0000-4000-8000-0000000000ff"))
    }

    func testApprovingAPhoneSignsItsKeyAndClearsTheRequest() async throws {
        let (model, server) = makeModel()
        server.pending = [newPhone]
        await model.refresh(credential: credential, client: server)
        let request = try XCTUnwrap(model.request(id: newPhone.deviceId))

        let approved = await model.approve(request, credential: credential, approver: server, signer: try signer())

        XCTAssertTrue(approved)
        XCTAssertEqual(server.approvals.map(\.deviceId), [newPhone.deviceId])
        XCTAssertEqual(server.approvals.first?.identityKey, newPhone.identityKey)
        XCTAssertTrue(model.waitingRequests.isEmpty)
        XCTAssertNil(model.pendingProblem)
    }

    func testApprovingAPhoneThatSignedOutSaysSoAndReloads() async throws {
        let (model, server) = makeModel()
        server.pending = [newPhone]
        await model.refresh(credential: credential, client: server)
        let request = try XCTUnwrap(model.request(id: newPhone.deviceId))
        server.approveError = DeviceApprovalError.unknownDevice
        server.pending = []

        let approved = await model.approve(request, credential: credential, approver: server, signer: try signer())

        XCTAssertFalse(approved)
        XCTAssertEqual(model.pendingProblem, DeviceApprovalError.unknownDevice.errorDescription)
        XCTAssertTrue(model.waitingRequests.isEmpty)
    }

    func testApprovingWithoutKeysDoesNothing() async throws {
        let (model, server) = makeModel()
        server.pending = [newPhone]
        await model.refresh(credential: credential, client: server)
        let request = try XCTUnwrap(model.request(id: newPhone.deviceId))

        let approved = await model.approve(request, credential: credential, approver: server, signer: nil)

        XCTAssertFalse(approved)
        XCTAssertTrue(server.approvals.isEmpty)
        XCTAssertEqual(model.waitingRequests.count, 1)
        XCTAssertNotNil(model.pendingProblem)
    }

    func testDecliningAPhoneSignsItOut() async throws {
        let (model, server) = makeModel()
        server.pending = [newPhone]
        await model.refresh(credential: credential, client: server)
        let request = try XCTUnwrap(model.request(id: newPhone.deviceId))

        let declined = await model.decline(request, credential: credential, approver: server)

        XCTAssertTrue(declined)
        XCTAssertEqual(server.declines, [newPhone.deviceId])
        XCTAssertTrue(model.waitingRequests.isEmpty)
    }

    func testALaterComputerWaitsAndCanBeApprovedOrDeclined() async throws {
        let (model, server) = makeModel()
        server.clients = [Self.client(id: "key_00000000-0000-4000-8000-000000000001", name: "Studio Mac")]
        await model.refresh(credential: credential, client: server)
        XCTAssertTrue(model.waitingRequests.isEmpty, "the first computer is trusted on first contact")
        XCTAssertEqual(model.trustedComputerCount, 1)

        let laptop = Self.client(id: "key_00000000-0000-4000-8000-000000000002", name: "MacBook")
        let tablet = Self.client(id: "key_00000000-0000-4000-8000-000000000003", name: "Build box")
        server.clients += [laptop, tablet]
        await model.refresh(credential: credential, client: server)
        XCTAssertEqual(model.waitingRequests.map(\.id), [laptop.clientId, tablet.clientId])
        let request = try XCTUnwrap(model.request(id: laptop.clientId))
        XCTAssertFalse(request.isPhone)
        XCTAssertEqual(request.ask, "wants to send you encrypted cards")

        let approved = await model.approve(request, credential: credential, approver: server, signer: nil)
        XCTAssertTrue(approved)
        XCTAssertEqual(model.trustedComputerCount, 2)

        let declined = await model.decline(try XCTUnwrap(model.request(id: tablet.clientId)), credential: credential, approver: server)
        XCTAssertTrue(declined)
        XCTAssertTrue(model.waitingRequests.isEmpty)
        XCTAssertEqual(model.computers.first { $0.id == tablet.clientId }?.trust, .declined)
        XCTAssertTrue(server.approvals.isEmpty, "computers are trusted on this iPhone only")
    }

    func testThisPhoneStatusFollowsTheServer() async {
        let (model, server) = makeModel()
        XCTAssertEqual(model.status(signedIn: false, keysProblem: nil), .signedOut)
        XCTAssertEqual(model.status(signedIn: true, keysProblem: nil), .settingUp)

        server.clients = [Self.client(id: "key_00000000-0000-4000-8000-000000000001", name: "Studio Mac")]
        server.phones = [ReloAccountPhone(deviceId: credential.deviceId, name: "iPhone Air", registeredAt: "2026-10-14T00:00:00.000Z",
                                          isCurrent: true, trusted: false),
                         ReloAccountPhone(deviceId: "dev_00000000-0000-4000-8000-0000000000cc", name: "iPhone 17 Pro",
                                          model: "iPhone18,1", registeredAt: "2026-10-01T00:00:00.000Z", isCurrent: false, trusted: true)]
        await model.refresh(credential: credential, client: server)
        XCTAssertEqual(model.status(signedIn: true, keysProblem: nil), .waitingForApproval)
        XCTAssertEqual(model.otherPhones.map(\.name), ["iPhone 17 Pro"])

        server.phones = server.phones.map {
            ReloAccountPhone(deviceId: $0.deviceId, name: $0.name, model: $0.model, registeredAt: $0.registeredAt,
                             isCurrent: $0.isCurrent, trusted: true)
        }
        await model.refresh(credential: credential, client: server)
        XCTAssertEqual(model.status(signedIn: true, keysProblem: nil).line, "Your computers can send encrypted cards to this iPhone.")
        XCTAssertEqual(model.status(signedIn: true, keysProblem: "No keys").line, "No keys")
    }

    private static func client(id: String, name: String) -> ReloClientKey {
        let key = P256.Signing.PrivateKey().publicKey.x963Representation
        return ReloClientKey(clientId: id, name: name, keyId: ReloE2EE.keyID(publicKeyX963: key),
                             publicKey: ReloE2EE.base64URL(key), changedAt: "2026-10-14T00:00:00.000Z")
    }
}

private final class FakeServer: DeviceApproving, ClientKeyDirectory, AccountDeviceListing, @unchecked Sendable {
    private let lock = NSLock()
    private var _pending: [ReloPendingDevice] = []
    private var _clients: [ReloClientKey] = []
    private var _phones: [ReloAccountPhone]?
    private var _approvals: [ReloDeviceApprovalRequest] = []
    private var _declines: [String] = []
    private var _approveError: Error?

    var pending: [ReloPendingDevice] { get { lock.withLock { _pending } } set { lock.withLock { _pending = newValue } } }
    var clients: [ReloClientKey] { get { lock.withLock { _clients } } set { lock.withLock { _clients = newValue } } }
    var phones: [ReloAccountPhone] { get { lock.withLock { _phones ?? [] } } set { lock.withLock { _phones = newValue } } }
    var approvals: [ReloDeviceApprovalRequest] { lock.withLock { _approvals } }
    var declines: [String] { lock.withLock { _declines } }
    var approveError: Error? { get { lock.withLock { _approveError } } set { lock.withLock { _approveError = newValue } } }

    func pendingDevices(credential: DeviceCredential) async throws -> [ReloPendingDevice] { pending }
    func approveDevice(credential: DeviceCredential, request: ReloDeviceApprovalRequest) async throws {
        if let error = approveError { throw error }
        lock.withLock {
            _approvals.append(request)
            _pending.removeAll { $0.deviceId == request.deviceId }
        }
    }
    func declineDevice(credential: DeviceCredential, deviceID: String) async throws {
        lock.withLock {
            _declines.append(deviceID)
            _pending.removeAll { $0.deviceId == deviceID }
        }
    }
    func clientKeys(credential: DeviceCredential) async throws -> [ReloClientKey] { clients }
    func accountPhones(credential: DeviceCredential) async throws -> [ReloAccountPhone]? { lock.withLock { _phones } }
}

private final class MemoryKeyRing: ReloKeyRingStore, @unchecked Sendable {
    private let lock = NSLock()
    private var state: ReloKeyRingState?
    func load() throws -> ReloKeyRingState? { lock.withLock { state } }
    func save(_ state: ReloKeyRingState) throws { lock.withLock { self.state = state } }
    func delete() throws { lock.withLock { state = nil } }
}

private final class MemoryTrust: ReloTrustedClientStore, @unchecked Sendable {
    private let lock = NSLock()
    private var clients: [ReloTrustedClient] = []
    func load() throws -> [ReloTrustedClient] { lock.withLock { clients } }
    func save(_ clients: [ReloTrustedClient]) throws { lock.withLock { self.clients = clients } }
}

private final class MemoryBrowsers: ReloLinkedBrowserStore, @unchecked Sendable {
    private let lock = NSLock()
    private var browsers: [ReloLocalLinkedBrowser] = []
    func load() throws -> [ReloLocalLinkedBrowser] { lock.withLock { browsers } }
    func save(_ browsers: [ReloLocalLinkedBrowser]) throws { lock.withLock { self.browsers = browsers } }
}
