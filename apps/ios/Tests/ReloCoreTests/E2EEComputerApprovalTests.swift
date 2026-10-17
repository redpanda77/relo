import CryptoKit
import Foundation
import XCTest
@testable import ReloCore

/// Computers are approved once, on any trusted device (docs/ENCRYPTION-PROTOCOL.md): an approver's signature over a
/// computer's current key opens it on every device that pinned that approver; nothing the server says alone does.
final class E2EEComputerApprovalTests: XCTestCase {
    private final class ClientStore: ReloTrustedClientStore, @unchecked Sendable {
        private let lock = NSLock()
        private var clients: [ReloTrustedClient] = []
        func load() throws -> [ReloTrustedClient] { lock.withLock { clients } }
        func save(_ clients: [ReloTrustedClient]) throws { lock.withLock { self.clients = clients } }
    }

    private final class ApproverStore: ReloTrustedApproverStore, @unchecked Sendable {
        private let lock = NSLock()
        private var approvers: [ReloPinnedApprover] = []
        func load() throws -> [ReloPinnedApprover] { lock.withLock { approvers } }
        func save(_ approvers: [ReloPinnedApprover]) throws { lock.withLock { self.approvers = approvers } }
    }

    private struct Signer: ReloIdentitySigning {
        let key = P256.Signing.PrivateKey()
        var publicKeyX963: Data { key.publicKey.x963Representation }
        var encoded: String { ReloE2EE.base64URL(publicKeyX963) }
        func sign(_ message: Data) throws -> Data { try key.signature(for: message).rawRepresentation }
    }

    private let now = Date(timeIntervalSince1970: 1_792_000_000)

    private func computer(_ id: String, approvals: [ReloComputerApprovalSignature]? = nil, key: P256.Signing.PrivateKey = .init()) -> ReloClientKey {
        let publicKey = key.publicKey.x963Representation
        return ReloClientKey(clientId: id, name: id == "key_old" ? "Studio" : "Build box", keyId: ReloE2EE.keyID(publicKeyX963: publicKey),
                             publicKey: ReloE2EE.base64URL(publicKey), changedAt: "2026-10-16T16:00:00.000Z", approvals: approvals)
    }

    private func approval(of client: ReloClientKey, by signer: Signer, id: String) throws -> ReloComputerApprovalSignature {
        let request = try ReloComputerApproval.request(for: client, approverID: id, signer: signer, now: now)
        return ReloComputerApprovalSignature(approverId: id, signedAt: request.signedAt, signature: request.signature)
    }

    func testAComputerApprovedOnThePhoneOpensOnTheMacAppThatPinnedThePhone() throws {
        let phone = Signer(), mac = Signer()
        let approvers = ReloTrustedApprovers(store: ApproverStore())
        let listed = [ReloApprover(id: "dev_phone", kind: "phone", name: "iPhone", identityKey: phone.encoded, vouchedBy: nil),
                      ReloApprover(id: "dev_mac", kind: "mac", name: "MacBook Pro", identityKey: mac.encoded, vouchedBy: nil)]
        let pinned = try approvers.update(listed, selfID: "dev_mac", selfKey: mac.publicKeyX963, now: now)
        XCTAssertEqual(Set(pinned.keys), ["dev_phone", "dev_mac"], "first contact pins the approvers then listed")

        let trust = ReloTrustedClients(store: ClientStore())
        let old = computer("key_old")
        try trust.autoTrust([old], approvers: pinned, now: now)
        XCTAssertEqual(try trust.trust(of: old), .auto, "first contact still trusts the computers then listed")

        // A computer signed in later: pending on the Mac until the phone's approval arrives with its key.
        let key = P256.Signing.PrivateKey()
        let unapproved = computer("key_new", key: key)
        try trust.autoTrust([old, unapproved], approvers: pinned, now: now)
        XCTAssertEqual(try trust.trust(of: unapproved), .pending)
        let approved = computer("key_new", approvals: [try approval(of: unapproved, by: phone, id: "dev_phone")], key: key)
        XCTAssertTrue(try trust.autoTrust([old, approved], approvers: pinned, approverNames: ["dev_phone": "iPhone"], now: now))
        XCTAssertEqual(try trust.trust(of: approved), .auto)
        XCTAssertEqual(try trust.notice(for: approved)?.kind, "approved_elsewhere")
        XCTAssertEqual(try trust.notice(for: approved)?.approver, "iPhone")
        XCTAssertNotNil(try trust.trustedSenders()[approved.keyId])
    }

    func testNothingTheServerSaysAloneTrustsAComputerOrAnApprover() throws {
        let phone = Signer(), mac = Signer(), server = Signer()
        let approvers = ReloTrustedApprovers(store: ApproverStore())
        try approvers.update([ReloApprover(id: "dev_phone", kind: "phone", name: "iPhone", identityKey: phone.encoded, vouchedBy: nil)],
                             selfID: "dev_mac", selfKey: mac.publicKeyX963, now: now)
        // After first contact, an approver the server adds with no voucher (or a forged one) is not pinned.
        let forgedVoucher = ReloApprover.Voucher(approverId: "dev_phone", signedAt: "2026-10-16T16:00:00.000Z",
                                                 signature: ReloE2EE.base64URL(Data(repeating: 1, count: 64)), statement: "approve-device")
        let pinned = try approvers.update([
            ReloApprover(id: "dev_phone", kind: "phone", name: "iPhone", identityKey: phone.encoded, vouchedBy: nil),
            ReloApprover(id: "dev_rogue", kind: "phone", name: "Rogue", identityKey: server.encoded, vouchedBy: nil),
            ReloApprover(id: "dev_forged", kind: "phone", name: "Forged", identityKey: Signer().encoded, vouchedBy: forgedVoucher),
        ], selfID: "dev_mac", selfKey: mac.publicKeyX963, now: now)
        XCTAssertEqual(Set(pinned.keys), ["dev_phone", "dev_mac"])

        let trust = ReloTrustedClients(store: ClientStore())
        try trust.autoTrust([computer("key_old")], approvers: pinned, now: now)
        let key = P256.Signing.PrivateKey()
        let target = computer("key_new", key: key)
        // Signed by an approver this Mac never pinned, or a valid phone signature over another key: still pending.
        let byRogue = computer("key_new", approvals: [try approval(of: target, by: server, id: "dev_rogue")], key: key)
        try trust.autoTrust([byRogue], approvers: pinned, now: now)
        XCTAssertEqual(try trust.trust(of: byRogue), .pending)
        let otherKey = computer("key_new")
        let wrongKey = computer("key_new", approvals: [try approval(of: otherKey, by: phone, id: "dev_phone")], key: key)
        try trust.autoTrust([wrongKey], approvers: pinned, now: now)
        XCTAssertEqual(try trust.trust(of: wrongKey), .pending)
        // A computer declined here stays declined, whoever approved it elsewhere.
        try trust.decline(clientId: target.clientId, keyId: target.keyId)
        let approved = computer("key_new", approvals: [try approval(of: target, by: phone, id: "dev_phone")], key: key)
        try trust.autoTrust([approved], approvers: pinned, now: now)
        XCTAssertEqual(try trust.trust(of: approved), .declined)
    }

    func testANewApproverIsPinnedOnlyWhenAPinnedOneVouchedForItsKey() throws {
        let phone = Signer(), mac = Signer(), ipad = Signer(), browser = Signer()
        let approvers = ReloTrustedApprovers(store: ApproverStore())
        try approvers.update([ReloApprover(id: "dev_phone", kind: "phone", name: "iPhone", identityKey: phone.encoded, vouchedBy: nil)],
                             selfID: "dev_mac", selfKey: mac.publicKeyX963, now: now)
        let signedAt = ReloKeyRing.timestamp(now)
        let ipadVoucher = ReloApprover.Voucher(approverId: "dev_phone", signedAt: signedAt, signature: ReloE2EE.base64URL(try phone.sign(
            ReloDeviceApproval.signingInput(deviceID: "dev_ipad", identityKey: ipad.encoded, phoneDeviceID: "dev_phone", signedAt: signedAt))),
            statement: "approve-device")
        // The browser's link by the iPad, which is itself vouched for by the phone: a chain.
        let linkVoucher = ReloApprover.Voucher(approverId: "dev_ipad", signedAt: signedAt, signature: ReloE2EE.base64URL(try ipad.sign(
            ReloBrowserLink.signingInput(browserID: "brw_web", identityKey: browser.encoded, phoneDeviceID: "dev_ipad", signedAt: signedAt))),
            statement: "link")
        let listed = [
            ReloApprover(id: "brw_web", kind: "browser", name: "Chrome", identityKey: browser.encoded, vouchedBy: linkVoucher),
            ReloApprover(id: "dev_ipad", kind: "phone", name: "iPad", identityKey: ipad.encoded, vouchedBy: ipadVoucher),
        ]
        XCTAssertEqual(Set(try approvers.update(listed, selfID: "dev_mac", selfKey: mac.publicKeyX963, now: now).keys),
                       ["dev_phone", "dev_mac", "dev_ipad", "brw_web"])
        // A link older than 14 days vouches for nothing.
        let fresh = ReloTrustedApprovers(store: ApproverStore())
        try fresh.update([ReloApprover(id: "dev_ipad", kind: "phone", name: "iPad", identityKey: ipad.encoded, vouchedBy: nil)],
                         selfID: "dev_mac", selfKey: mac.publicKeyX963, now: now)
        let later = now.addingTimeInterval(15 * 86_400)
        XCTAssertNil(try fresh.update(listed, selfID: "dev_mac", selfKey: mac.publicKeyX963, now: later)["brw_web"])
    }
}
