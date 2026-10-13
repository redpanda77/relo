import Foundation
import ReloCore

/// Keeps this phone's end-to-end encryption keys current (docs/END-TO-END-ENCRYPTION.md, E2.1):
/// rotates the prekey when due, deletes expired private prekeys, and publishes the current prekey
/// whenever the server has not yet accepted it for this device credential.
public actor E2EEKeyMaintenance {
    private let ring: ReloKeyRing
    private let publisher: any DeviceKeyPublishing
    private var publishedFor: String?

    public init(ring: ReloKeyRing, publisher: any DeviceKeyPublishing) {
        self.ring = ring
        self.publisher = publisher
    }

    /// Returns true when a publication was sent. Errors leave the next call to retry.
    @discardableResult
    public func run(credential: DeviceCredential, now: Date = Date()) async throws -> Bool {
        let state = try ring.maintain(now: now)
        guard let current = state.prekeys.first(where: { $0.retiredAt == nil }) else { return false }
        let marker = "\(credential.deviceId)|\(credential.credentialVersion)|\(current.id)|\(ReloE2EE.base64URL(state.identity.publicKey))"
        guard publishedFor != marker else { return false }
        try await publisher.publishDeviceKeys(
            credential: credential, keys: try ring.publication(deviceID: credential.deviceId, state: state)
        )
        publishedFor = marker
        return true
    }
}
