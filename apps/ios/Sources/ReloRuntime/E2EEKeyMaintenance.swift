import Foundation
import ReloCore

/// Keeps this phone's end-to-end encryption keys current (docs/END-TO-END-ENCRYPTION.md, E2.1):
/// rotates the prekey when due, deletes expired private prekeys, and publishes the current prekey
/// whenever the server has not yet accepted it for this device credential.
public actor E2EEKeyMaintenance {
    private let ring: ReloKeyRing
    private let publisher: any DeviceKeyPublishing
    private let directory: (any ClientKeyDirectory)?
    private let trust: ReloTrustedClients?
    private let erase: (@Sendable () -> Void)?
    private let browserLinks: BrowserLinkRenewal?
    private var publishedFor: String?

    public init(ring: ReloKeyRing, publisher: any DeviceKeyPublishing,
                directory: (any ClientKeyDirectory)? = nil, trust: ReloTrustedClients? = nil,
                erase: (@Sendable () -> Void)? = nil, browserLinks: BrowserLinkRenewal? = nil) {
        self.erase = erase
        self.browserLinks = browserLinks
        self.ring = ring
        self.publisher = publisher
        self.directory = directory
        self.trust = trust
    }

    /// Trust on first use for the account's computers, so their sealed messages open with no setup.
    public func refreshTrustedComputers(credential: DeviceCredential, now: Date = Date()) async throws {
        guard let directory, let trust else { return }
        try trust.autoTrust(try await directory.clientKeys(credential: credential), now: now)
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

    /// Sign-out: deletes this phone's encryption keys, trusted computers, names and replay ledger,
    /// so the next account starts with fresh keys and trusts nothing from the last one.
    public func forget() {
        erase?()
        publishedFor = nil
    }
}
