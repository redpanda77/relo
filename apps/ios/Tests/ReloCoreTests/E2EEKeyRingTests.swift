import CryptoKit
import Foundation
import XCTest
@testable import ReloCore
@testable import ReloRuntime

final class E2EEKeyRingTests: XCTestCase {
    private final class MemoryStore: ReloKeyRingStore, @unchecked Sendable {
        private let lock = NSLock()
        private var state: ReloKeyRingState?
        private(set) var saves = 0
        func load() throws -> ReloKeyRingState? { lock.withLock { state } }
        func save(_ state: ReloKeyRingState) throws { lock.withLock { self.state = state; saves += 1 } }
        func delete() throws { lock.withLock { state = nil } }
    }

    private actor Publisher: DeviceKeyPublishing {
        private(set) var published: [ReloPublishedDeviceKeys] = []
        func publishDeviceKeys(credential: DeviceCredential, keys: ReloPublishedDeviceKeys) async throws { published.append(keys) }
    }

    private let start = Date(timeIntervalSince1970: 1_800_000_000)
    private let hour: TimeInterval = 3600

    private func credential(version: Int = 1) -> DeviceCredential {
        DeviceCredential(deviceId: "dev_00000000-0000-4000-8000-000000000001", installationId: UUID(), accessToken: String(repeating: "a", count: 43),
                         issuedAt: start, expiresAt: nil, accountId: "acc_test", credentialVersion: version)
    }

    func testRotatesEveryTenHoursAndDeletesPrivatePrekeysAfterRetentionAndGrace() throws {
        let store = MemoryStore()
        let ring = ReloKeyRing(store: store, factory: ReloSoftwareKeyFactory())
        let first = try ring.maintain(now: start)
        XCTAssertEqual(first.prekeys.count, 1)
        XCTAssertEqual(try ring.maintain(now: start.addingTimeInterval(9 * hour)), first, "not due yet")

        let rotated = try ring.maintain(now: start.addingTimeInterval(10 * hour))
        XCTAssertEqual(rotated.prekeys.count, 2)
        XCTAssertNil(rotated.prekeys[0].retiredAt)
        XCTAssertEqual(rotated.prekeys[1].id, first.prekeys[0].id)
        XCTAssertEqual(rotated.prekeys[1].retiredAt, start.addingTimeInterval(10 * hour))
        XCTAssertEqual(rotated.identity, first.identity, "the identity never rotates by itself")

        // The retired prekey still opens late envelopes until retention (10 h) + grace (2 h) after retirement.
        XCTAssertNotNil(ring.prekeyOpener(state: try ring.maintain(now: start.addingTimeInterval(21 * hour)))(first.prekeys[0].id))
        let later = try ring.maintain(now: start.addingTimeInterval(22 * hour))
        XCTAssertNil(ring.prekeyOpener(state: later)(first.prekeys[0].id), "deleted for good")
        XCTAssertFalse(later.prekeys.contains { $0.id == first.prekeys[0].id })
    }

    func testDeletedPrekeyMakesEarlierEnvelopesUnreadable() throws {
        let store = MemoryStore()
        let ring = ReloKeyRing(store: store, factory: ReloSoftwareKeyFactory())
        let state = try ring.maintain(now: start)
        let sender = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        let envelope = try ReloE2EE.seal(
            kind: "notice", context: "acct:a/idem:1", sender: sender,
            recipients: [("dev_1", state.prekeys[0].id, state.prekeys[0].key.publicKey)], content: Data(#"{"t":"secret"}"#.utf8)
        )
        let trusted = [ReloE2EE.keyID(publicKeyX963: sender.publicKeyX963): sender.publicKeyX963]
        XCTAssertEqual(try ReloE2EE.open(envelope, deviceID: "dev_1", prekey: ring.prekeyOpener(state: state), trustedSenders: trusted),
                       Data(#"{"t":"secret"}"#.utf8))
        _ = try ring.maintain(now: start.addingTimeInterval(10 * hour))
        let expired = try ring.maintain(now: start.addingTimeInterval(23 * hour))
        XCTAssertThrowsError(try ReloE2EE.open(envelope, deviceID: "dev_1", prekey: ring.prekeyOpener(state: expired), trustedSenders: trusted)) {
            XCTAssertEqual($0 as? ReloE2EEError, .prekeyUnavailable)
        }
    }

    func testPublicationIsSignedForThisDeviceAndPublishedOncePerPrekey() async throws {
        let store = MemoryStore()
        let ring = ReloKeyRing(store: store, factory: ReloSoftwareKeyFactory())
        let publisher = Publisher()
        let maintenance = E2EEKeyMaintenance(ring: ring, publisher: publisher)
        let didPublish = try await maintenance.run(credential: credential(), now: start)
        let didRepeat = try await maintenance.run(credential: credential(), now: start.addingTimeInterval(hour))
        XCTAssertTrue(didPublish)
        XCTAssertFalse(didRepeat)
        _ = try await maintenance.run(credential: credential(version: 2), now: start.addingTimeInterval(2 * hour))
        _ = try await maintenance.run(credential: credential(version: 2), now: start.addingTimeInterval(10 * hour))
        let published = await publisher.published
        XCTAssertEqual(published.count, 3, "first prekey, a new credential, then the rotated prekey")
        XCTAssertNotEqual(published[1].prekey.prekeyId, published[2].prekey.prekeyId)

        let keys = try XCTUnwrap(published.last)
        let identity = try ReloE2EE.data(base64URL: keys.identityKey, length: 65, field: "identity")
        let input = ReloE2EE.prekeySigningInput(deviceID: credential().deviceId, prekeyID: keys.prekey.prekeyId,
                                                publicKeyX963: try ReloE2EE.data(base64URL: keys.prekey.publicKey, field: "prekey"),
                                                createdAt: keys.prekey.createdAt)
        XCTAssertTrue(ReloE2EE.verify(signature: try ReloE2EE.data(base64URL: keys.prekey.signature, field: "sig"), message: input, publicKeyX963: identity))
        let otherDevice = ReloE2EE.prekeySigningInput(deviceID: "dev_other", prekeyID: keys.prekey.prekeyId,
                                                      publicKeyX963: try ReloE2EE.data(base64URL: keys.prekey.publicKey, field: "prekey"),
                                                      createdAt: keys.prekey.createdAt)
        XCTAssertFalse(ReloE2EE.verify(signature: try ReloE2EE.data(base64URL: keys.prekey.signature, field: "sig"), message: otherDevice, publicKeyX963: identity))
        XCTAssertNotNil(ReloKeyRing.date(keys.prekey.createdAt))
    }

    func testAPrekeyThatOnlyWorksWhileUnlockedIsReplacedAtOnce() throws {
        let store = MemoryStore()
        let ring = ReloKeyRing(store: store, factory: ReloSoftwareKeyFactory())
        var legacy = try ring.maintain(now: start)
        XCTAssertEqual(legacy.prekeys[0].key.usableWhileLocked, true)
        legacy.prekeys[0].key.usableWhileLocked = nil
        try store.save(legacy)
        let fixed = try ring.maintain(now: start.addingTimeInterval(hour))
        XCTAssertEqual(fixed.prekeys.count, 2)
        XCTAssertEqual(fixed.prekeys[0].key.usableWhileLocked, true)
        XCTAssertEqual(fixed.prekeys[1].retiredAt, start.addingTimeInterval(hour), "the old prekey still opens late envelopes")
        XCTAssertEqual(try ring.maintain(now: start.addingTimeInterval(2 * hour)), fixed)
    }
}
