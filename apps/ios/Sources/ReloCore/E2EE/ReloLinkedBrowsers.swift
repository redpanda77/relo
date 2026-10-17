import Foundation

/// The browsers this phone vouches for (docs/ENCRYPTION-PROTOCOL.md, "Linked browsers").
/// Computers accept a link signature only while it is less than 14 days old, so the phone re-signs
/// the links it keeps; unlinking here means the phone stops renewing, whatever the server does.
/// Only this local list is ever re-signed: the server's list is not trusted for that.
public struct ReloLocalLinkedBrowser: Codable, Equatable, Sendable, Identifiable {
    public var browserId: String
    /// Browser identity public key, base64url X9.63, exactly as scanned.
    public var identityKey: String
    public var name: String
    public var linkedAt: Date
    public var lastSignedAt: Date

    public var id: String { browserId }

    public init(browserId: String, identityKey: String, name: String, linkedAt: Date, lastSignedAt: Date) {
        self.browserId = browserId
        self.identityKey = identityKey
        self.name = name
        self.linkedAt = linkedAt
        self.lastSignedAt = lastSignedAt
    }
}

public protocol ReloLinkedBrowserStore: Sendable {
    func load() throws -> [ReloLocalLinkedBrowser]
    func save(_ browsers: [ReloLocalLinkedBrowser]) throws
}

public enum ReloBrowserLinkRenewalPolicy {
    /// Computers refuse a link signature this old.
    public static let acceptanceWindow: TimeInterval = 14 * 24 * 60 * 60
    /// The phone re-signs well before that, so a phone used every few days never lets a link lapse.
    public static let renewAfter: TimeInterval = 3 * 24 * 60 * 60

    public static func isDue(_ browser: ReloLocalLinkedBrowser, now: Date) -> Bool {
        // A signature dated in the future (clock moved back) is re-signed too.
        now.timeIntervalSince(browser.lastSignedAt) >= renewAfter || browser.lastSignedAt > now
    }

    public static func due(_ browsers: [ReloLocalLinkedBrowser], now: Date) -> [ReloLocalLinkedBrowser] {
        browsers.filter { isDue($0, now: now) }
    }
}

public struct ReloLinkedBrowsers: Sendable {
    public let store: any ReloLinkedBrowserStore

    public init(store: any ReloLinkedBrowserStore) {
        self.store = store
    }

    public func all() throws -> [ReloLocalLinkedBrowser] { try store.load() }

    public func contains(_ browserID: String) throws -> Bool {
        try store.load().contains { $0.browserId == browserID }
    }

    /// After the server accepted a new link; replaces any earlier entry for the same browser.
    public func remember(browserID: String, identityKey: String, name: String, signedAt: Date) throws {
        var browsers = try store.load().filter { $0.browserId != browserID }
        browsers.insert(ReloLocalLinkedBrowser(browserId: browserID, identityKey: identityKey, name: name,
                                               linkedAt: signedAt, lastSignedAt: signedAt), at: 0)
        try store.save(browsers)
    }

    /// After the server accepted a renewal. A browser unlinked meanwhile stays unlinked.
    public func markSigned(browserID: String, identityKey: String, name: String?, at date: Date) throws {
        var browsers = try store.load()
        guard let index = browsers.firstIndex(where: { $0.browserId == browserID && $0.identityKey == identityKey }) else { return }
        browsers[index].lastSignedAt = date
        if let name, !name.isEmpty { browsers[index].name = name }
        try store.save(browsers)
    }

    public func forget(browserID: String) throws {
        let browsers = try store.load()
        let kept = browsers.filter { $0.browserId != browserID }
        if kept != browsers { try store.save(kept) }
    }
}

public extension ReloBrowserLink {
    /// The signed body for `POST /api/devices/self/links`, for a browser already in the local list.
    static func request(
        browserID: String, identityKey: String, phoneDeviceID: String, signer: any ReloIdentitySigning, now: Date = Date()
    ) throws -> ReloBrowserLinkRequest {
        let signedAt = ReloKeyRing.timestamp(now)
        let signature = try signer.sign(signingInput(
            browserID: browserID, identityKey: identityKey, phoneDeviceID: phoneDeviceID, signedAt: signedAt))
        return ReloBrowserLinkRequest(browserId: browserID, identityKey: identityKey, signedAt: signedAt,
                                      signature: ReloE2EE.base64URL(signature))
    }
}
