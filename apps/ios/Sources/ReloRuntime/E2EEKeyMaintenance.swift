import Foundation
import ReloCore

/// Keeps this phone's end-to-end encryption keys current (docs/ENCRYPTION-PROTOCOL.md, E2.1):
/// rotates the prekey when due, deletes expired private prekeys, and publishes the current prekey
/// whenever the server has not yet accepted it for this device credential.
public actor E2EEKeyMaintenance {
    private let ring: ReloKeyRing
    private let publisher: any DeviceKeyPublishing
    private let directory: (any ClientKeyDirectory)?
    private let trust: ReloTrustedClients?
    private let erase: (@Sendable () -> Void)?
    private let browserLinks: BrowserLinkRenewal?
    private let approving: (any ComputerApproving)?
    private let approvers: ReloTrustedApprovers?
    private var publishedFor: String?
    /// "clientId|publicKey" this device signed an approval for since launch (or the server refused): never twice.
    private var signedApprovals: Set<String> = []

    public init(ring: ReloKeyRing, publisher: any DeviceKeyPublishing,
                directory: (any ClientKeyDirectory)? = nil, trust: ReloTrustedClients? = nil,
                erase: (@Sendable () -> Void)? = nil, browserLinks: BrowserLinkRenewal? = nil,
                approving: (any ComputerApproving)? = nil, approvers: ReloTrustedApprovers? = nil) {
        self.approving = approving
        self.approvers = approvers
        self.erase = erase
        self.browserLinks = browserLinks
        self.ring = ring
        self.publisher = publisher
        self.directory = directory
        self.trust = trust
    }

    /// Trust on first use for the account's computers, so their sealed messages open with no setup; a computer
    /// approved on any of the account's trusted devices opens here too, and this device signs an approval for every
    /// computer it trusts, so they open on the others (docs/ENCRYPTION-PROTOCOL.md, "Computers are approved once").
    public func refreshTrustedComputers(credential: DeviceCredential, now: Date = Date()) async throws {
        guard let directory, let trust else { return }
        let computers = try await directory.clientKeys(credential: credential)
        let signer = ring.existingIdentitySigner()
        var pinned: [String: Data] = [:]
        var names: [String: String] = [:]
        if let approving, let approvers, let signer, let listed = try? await approving.approvers(credential: credential) {
            pinned = (try? approvers.update(listed, selfID: credential.deviceId, selfKey: signer.publicKeyX963, now: now)) ?? [:]
            names = Dictionary(listed.map { ($0.id, $0.name) }, uniquingKeysWith: { _, last in last })
        }
        try trust.autoTrust(computers, approvers: pinned, approverNames: names, now: now)
        guard let approving, let signer else { return }
        for computer in computers where !(computer.approvals ?? []).contains(where: { $0.approverId == credential.deviceId }) {
            guard [.auto, .verified].contains(try trust.trust(of: computer)) else { continue }
            await sign(computer, credential: credential, approving: approving, signer: signer, now: now)
        }
    }

    /// Signs and sends this device's approval of `computer`'s current key (the owner approved it here).
    /// True when the server took the approval.
    @discardableResult
    public func approve(_ computer: ReloClientKey, credential: DeviceCredential, now: Date = Date()) async -> Bool {
        guard let approving, let signer = ring.existingIdentitySigner() else { return false }
        signedApprovals.remove("\(computer.clientId)|\(computer.publicKey)")
        return await sign(computer, credential: credential, approving: approving, signer: signer, now: now)
    }

    @discardableResult
    private func sign(_ computer: ReloClientKey, credential: DeviceCredential, approving: any ComputerApproving,
                      signer: any ReloIdentitySigning, now: Date) async -> Bool {
        let marker = "\(computer.clientId)|\(computer.publicKey)"
        guard !signedApprovals.contains(marker),
              let request = try? ReloComputerApproval.request(for: computer, approverID: credential.deviceId, signer: signer, now: now)
        else { return false }
        signedApprovals.insert(marker)
        do {
            try await approving.approveComputer(credential: credential, request: request)
            return true
        } catch MobileAPIError.unavailable {
            signedApprovals.remove(marker)
        } catch {
            // Refused (a simulator, a key that changed meanwhile): not retried until the next launch.
        }
        return false
    }

    /// Returns true when a publication was sent. Errors leave the next call to retry.
    @discardableResult
    public func run(credential: DeviceCredential, now: Date = Date()) async throws -> Bool {
        let state = try ring.maintain(now: now)
        try? await refreshTrustedComputers(credential: credential, now: now)
        await renewBrowserLinks(credential: credential, now: now)
        guard let current = state.prekeys.first(where: { $0.retiredAt == nil }) else { return false }
        let marker = "\(credential.deviceId)|\(credential.credentialVersion)|\(current.id)|\(ReloE2EE.base64URL(state.identity.publicKey))"
        guard publishedFor != marker else { return false }
        try await publisher.publishDeviceKeys(
            credential: credential, keys: try ring.publication(deviceID: credential.deviceId, state: state)
        )
        publishedFor = marker
        return true
    }

    /// Re-signs the links this phone keeps before computers stop accepting them (14 days).
    @discardableResult
    public func renewBrowserLinks(credential: DeviceCredential, now: Date = Date()) async -> BrowserLinkRenewal.Outcome {
        guard let browserLinks else { return .init() }
        return await browserLinks.run(credential: credential, signer: ring.existingIdentitySigner(), now: now)
    }

    /// Sign-out: forgets trusted computers, linked browsers, names and the replay ledger, so the next
    /// sign-in trusts nothing from the last one; the phone keeps its own keys and publishes them again.
    public func forget() {
        erase?()
        publishedFor = nil
        signedApprovals = []
    }
}
