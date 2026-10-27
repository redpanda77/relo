import Foundation
import Testing
@testable import ReloNotchKit

@MainActor @Suite struct ServerAddressTests {
    @Test func theAddressShowsTheSchemeHostAndAnUnusualPort() {
        func shown(_ text: String) -> String? { URL(string: text).map(ReloNotchStore.displayAddress(of:)) }
        #expect(shown("https://relo.example.com") == "https://relo.example.com")
        #expect(shown("https://relo.example.com:443") == "https://relo.example.com")
        #expect(shown("http://192.168.1.5:8180") == "http://192.168.1.5:8180")
        #expect(shown("https://relo.example.com:8443") == "https://relo.example.com:8443")
    }

    @Test func aTypedSchemeAndPortAreKept() {
        func origin(_ text: String) -> String? { ReloNotchStore.origin(fromTypedAddress: text)?.absoluteString }
        #expect(origin("relo.example.com") == "https://relo.example.com")
        #expect(origin("  relo.example.com/dashboard  ") == "https://relo.example.com")
        #expect(origin("http://192.168.1.5:8180") == "http://192.168.1.5:8180")
        #expect(origin("https://relo.example.com:8443") == "https://relo.example.com:8443")
        #expect(origin("http://relo.example.com") == nil)
        #expect(origin("") == nil)
    }

    @Test func aCredentialsServerIsTheStoredOneThenTheChosenOne() {
        let chosen = URL(string: "https://relo.example.org")!
        let stored = URL(string: "https://stored.example.org")!
        #expect(ReloNotchStore.originOfStoredCredential(stored: stored, chosen: chosen, local: nil, bundled: nil) == stored)
        #expect(ReloNotchStore.originOfStoredCredential(stored: nil, chosen: chosen, local: nil, bundled: nil) == chosen)
        #expect(ReloNotchStore.originOfStoredCredential(stored: nil, chosen: nil, local: nil, bundled: nil) == nil)
    }

    @Test func theOldContainersReloKeysAreCopiedOnceAndNothingIsOverwritten() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("relo-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let bundle = "ai.relo.migrate-test"
        let folder = home.appendingPathComponent("Library/Containers/\(bundle)/Data/Library/Preferences")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let old: [String: Any] = ["relo.serverOrigin": "https://relo.example.org", "relo.notch.credentialOrigin": "https://relo.example.org",
                                  "relo.localMode": true, "other.key": "x"]
        try PropertyListSerialization.data(fromPropertyList: old, format: .binary, options: 0)
            .write(to: folder.appendingPathComponent("\(bundle).plist"))
        let suite = "relo-migrate-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("https://mine.example.org", forKey: "relo.serverOrigin")
        #expect(ReloNotchStore.migrateLegacyDefaults(bundleIdentifier: bundle, home: home, defaults: defaults) == 2)
        #expect(defaults.string(forKey: "relo.serverOrigin") == "https://mine.example.org")
        #expect(defaults.string(forKey: "relo.notch.credentialOrigin") == "https://relo.example.org")
        #expect(defaults.object(forKey: "other.key") == nil)
        #expect(ReloNotchStore.migrateLegacyDefaults(bundleIdentifier: bundle, home: home, defaults: defaults) == 0)
    }
}
