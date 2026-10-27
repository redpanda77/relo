import CryptoKit
import Foundation
import XCTest
@testable import ReloCore
@testable import ReloNotificationSupport

/// Opening many envelopes costs one read of the stores and one decrypt each: the owner's sealed cards
/// must not linger on placeholders because every open repeated the Keychain and key work.
final class E2EESealedSessionTests: XCTestCase {
    private final class Counts: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String: Int] = [:]
        func bump(_ name: String) { lock.withLock { values[name, default: 0] += 1 } }
        subscript(_ name: String) -> Int { lock.withLock { values[name, default: 0] } }
    }

    private final class RingStore: ReloKeyRingStore, @unchecked Sendable {
        let counts: Counts
        private let lock = NSLock()
        private var state: ReloKeyRingState?
        init(_ counts: Counts) { self.counts = counts }
        func load() throws -> ReloKeyRingState? { counts.bump("ring"); return lock.withLock { state } }
        func save(_ state: ReloKeyRingState) throws { lock.withLock { self.state = state } }
        func delete() throws { lock.withLock { state = nil } }
    }

    private final class TrustStore: ReloTrustedClientStore, @unchecked Sendable {
        let counts: Counts
        private let lock = NSLock()
        private var clients: [ReloTrustedClient] = []
        init(_ counts: Counts) { self.counts = counts }
        func load() throws -> [ReloTrustedClient] { counts.bump("trust"); return lock.withLock { clients } }
        func save(_ clients: [ReloTrustedClient]) throws { lock.withLock { self.clients = clients } }
    }

    private struct CountingFactory: ReloKeyFactory {
        let counts: Counts
        func makeIdentity() throws -> ReloStoredKey { try ReloSoftwareKeyFactory().makeIdentity() }
        func makePrekey() throws -> ReloStoredKey { try ReloSoftwareKeyFactory().makePrekey() }
        func signer(for identity: ReloStoredKey) throws -> any ReloIdentitySigning { try ReloSoftwareKeyFactory().signer(for: identity) }
        func opener(for prekey: ReloStoredKey) throws -> any ReloPrekeyOpening {
            counts.bump("opener")
            return CountingPrekey(inner: try ReloSoftwareKeyFactory().opener(for: prekey), counts: counts)
        }
    }

    private struct CountingPrekey: ReloPrekeyOpening {
        let inner: any ReloPrekeyOpening
        let counts: Counts
        func openContentKey(encapsulatedKey: Data, ciphertext: Data, info: Data, aad: Data) throws -> Data {
            counts.bump("decrypt")
            return try inner.openContentKey(encapsulatedKey: encapsulatedKey, ciphertext: ciphertext, info: info, aad: aad)
        }
    }

    private final class MemoryLedger: ReloReplayLedger, @unchecked Sendable {
        private let lock = NSLock()
        private var entries: [String: ReloReplayEntry] = [:]
        func admit(context: String, itemID: String, now: Date) -> Bool {
            lock.withLock { ReloReplayRules.admit(&entries, context: context, itemID: itemID, now: now) }
        }
    }

    private let deviceID = "dev_00000000-0000-4000-8000-000000000001"

    private struct Phone {
        var sealed: ReloSealedContent
        var trust: ReloTrustedClients
        var ring: ReloKeyRing
        var prekey: ReloStoredPrekey
        var counts: Counts
    }

    private func phone() throws -> Phone {
        let counts = Counts()
        let ring = ReloKeyRing(store: RingStore(counts), factory: CountingFactory(counts: counts))
        let state = try ring.maintain()
        let trust = ReloTrustedClients(store: TrustStore(counts))
        return Phone(sealed: ReloSealedContent(ring: ring, trust: trust, ledger: MemoryLedger()), trust: trust, ring: ring,
                     prekey: state.prekeys[0], counts: counts)
    }

    private func computer(_ trust: ReloTrustedClients, trusted: Bool) throws -> ReloSoftwareIdentity {
        let identity = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        let key = ReloClientKey(clientId: "key_1", name: "Mac", keyId: ReloE2EE.keyID(publicKeyX963: identity.publicKeyX963),
                                publicKey: ReloE2EE.base64URL(identity.publicKeyX963), changedAt: "")
        if trusted { try trust.markVerified(key) }
        return identity
    }

    private func seal(_ kind: String, context: String, sender: ReloSoftwareIdentity, prekey: ReloStoredPrekey) throws -> ReloEnvelope {
        try ReloE2EE.seal(kind: kind, context: context, sender: sender, recipients: [(deviceID, prekey.id, prekey.key.publicKey)],
                          content: try JSONSerialization.data(withJSONObject: ["title": "Deploy finished"]))
    }

    func testManyOpensOfTheSameEnvelopeReadTheStoresAndDecryptOnce() throws {
        let phone = try phone()
        let envelope = try seal("notice", context: "ntf:a", sender: try computer(phone.trust, trusted: true), prekey: phone.prekey)
        let baseTrust = phone.counts["trust"], baseRing = phone.counts["ring"]
        for _ in 0..<50 {
            guard case .opened = phone.sealed.open(envelope, deviceID: deviceID, itemID: "ntf_1") else { return XCTFail("did not open") }
        }
        XCTAssertEqual(phone.counts["trust"] - baseTrust, 1)
        XCTAssertEqual(phone.counts["ring"] - baseRing, 1)
        XCTAssertEqual(phone.counts["decrypt"], 1)
        XCTAssertEqual(phone.counts["opener"], 1)
    }

    func testAReplayStaysBlockedWhenThePlaintextIsCached() throws {
        let phone = try phone()
        let envelope = try seal("notice", context: "ntf:a", sender: try computer(phone.trust, trusted: true), prekey: phone.prekey)
        guard case .opened = phone.sealed.open(envelope, deviceID: deviceID, itemID: "ntf_1") else { return XCTFail("first open") }
        XCTAssertEqual(phone.sealed.open(envelope, deviceID: deviceID, itemID: "ntf_replayed"), .replayed)
        guard case .opened = phone.sealed.open(envelope, deviceID: deviceID, itemID: "ntf_1") else { return XCTFail("same item reopens") }
        XCTAssertEqual(phone.counts["decrypt"], 1)
    }

    func testAFailureIsCachedButATrustChangeClearsIt() throws {
        let phone = try phone()
        let mac = try computer(phone.trust, trusted: false)
        let envelope = try seal("card", context: "ntf:c", sender: mac, prekey: phone.prekey)
        let before = phone.counts["trust"]
        for _ in 0..<40 { XCTAssertEqual(phone.sealed.open(envelope, deviceID: deviceID), .unverifiedSender) }
        XCTAssertEqual(phone.counts["trust"] - before, 1, "a burst of failures reads the stores once")
        let key = ReloClientKey(clientId: "key_1", name: "Mac", keyId: ReloE2EE.keyID(publicKeyX963: mac.publicKeyX963),
                                publicKey: ReloE2EE.base64URL(mac.publicKeyX963), changedAt: "")
        try phone.trust.markVerified(key)
        guard case .opened = phone.sealed.open(envelope, deviceID: deviceID) else { return XCTFail("trust change must clear the failure") }
    }

    func testForgettingAComputerStopsServingWhatItSealed() throws {
        let phone = try phone()
        let envelope = try seal("card", context: "ntf:c", sender: try computer(phone.trust, trusted: true), prekey: phone.prekey)
        guard case .opened = phone.sealed.open(envelope, deviceID: deviceID) else { return XCTFail("opens while trusted") }
        try phone.trust.forget(clientId: "key_1")
        XCTAssertEqual(phone.sealed.open(envelope, deviceID: deviceID), .unverifiedSender)
    }

    func testARingChangeDropsTheCachedPlaintext() throws {
        let phone = try phone()
        let envelope = try seal("card", context: "ntf:c", sender: try computer(phone.trust, trusted: true), prekey: phone.prekey)
        guard case .opened = phone.sealed.open(envelope, deviceID: deviceID) else { return XCTFail("opens") }
        try phone.ring.store.delete()
        ReloE2EEGeneration.bump()
        XCTAssertEqual(phone.sealed.open(envelope, deviceID: deviceID), .unavailable, "no keys, nothing served from memory")
    }

    func testCardOpenFailureExplainsItselfFromTheSnapshotWithoutReloading() throws {
        let phone = try phone()
        let envelope = try seal("card", context: "ntf:c", sender: try computer(phone.trust, trusted: false), prekey: phone.prekey)
        let first = phone.sealed.openCard(envelope)
        XCTAssertEqual(first.outcome, .computerUnknown)
        let loads = phone.counts["ring"] + phone.counts["trust"]
        _ = phone.sealed.openCard(envelope)
        _ = phone.sealed.diagnoser(envelope)
        XCTAssertEqual(phone.counts["ring"] + phone.counts["trust"], loads)
    }

    func testEachDistinctFailureIsLoggedOncePerProcess() {
        let context = "ctx-\(UUID().uuidString)"
        XCTAssertTrue(ReloSealedFailureLog.firstTime(context: context, outcome: .computerUnknown))
        XCTAssertFalse(ReloSealedFailureLog.firstTime(context: context, outcome: .computerUnknown))
        XCTAssertTrue(ReloSealedFailureLog.firstTime(context: context, outcome: .failed))
    }
}
