import Foundation
import ReloCore

/// Re-signs the links this phone keeps (docs/END-TO-END-ENCRYPTION.md, "Linked browsers"): computers
/// accept a link signature for 14 days, so every browser in the local list whose signature is older
/// than 3 days is signed again with `signedAt = now` and posted to the same endpoint. A browser the
/// server no longer knows (404) or whose identity changed (409) leaves the list; it must be linked
/// again. Browsers only the server lists are never signed.
public struct BrowserLinkRenewal: Sendable {
    public struct Outcome: Equatable, Sendable {
        public var renewed: [String] = []
        public var removed: [String] = []
        public var failed: [String] = []
    }

    private let browsers: ReloLinkedBrowsers
    private let linker: any BrowserLinking

    public init(browsers: ReloLinkedBrowsers, linker: any BrowserLinking) {
        self.browsers = browsers
        self.linker = linker
    }

    /// Network or server failures leave the entry for the next upkeep; nothing here throws past the list.
    @discardableResult
    public func run(credential: DeviceCredential, signer: (any ReloIdentitySigning)?, now: Date = Date()) async -> Outcome {
        var outcome = Outcome()
        guard let signer, let entries = try? browsers.all() else { return outcome }
        for entry in ReloBrowserLinkRenewalPolicy.due(entries, now: now) {
            // Unlinked by the owner since the list was read: never vouch for it again.
            guard (try? browsers.contains(entry.browserId)) == true,
                  let request = try? ReloBrowserLink.request(browserID: entry.browserId, identityKey: entry.identityKey,
                                                             phoneDeviceID: credential.deviceId, signer: signer, now: now)
            else { continue }
            do {
                let linked = try await linker.linkBrowser(credential: credential, request: request)
                try browsers.markSigned(browserID: entry.browserId, identityKey: entry.identityKey, name: linked.name, at: now)
                outcome.renewed.append(entry.browserId)
            } catch BrowserLinkError.unknownBrowser, BrowserLinkError.identityMismatch {
                try? browsers.forget(browserID: entry.browserId)
                outcome.removed.append(entry.browserId)
            } catch {
                outcome.failed.append(entry.browserId)
            }
        }
        return outcome
    }
}
