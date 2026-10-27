import Foundation
import Testing
@testable import ReloNotchKit

@Suite("Launch without waiting")
struct LaunchTests {
    private func cache(maxAge: TimeInterval = 600) -> NowCache {
        NowCache(url: FileManager.default.temporaryDirectory.appendingPathComponent("relo-\(UUID().uuidString)/notch/now.json"), maxAge: maxAge)
    }

    @Test func cacheRoundTripsAndIsOwnerOnly() throws {
        let cache = cache()
        defer { cache.clear() }
        #expect(cache.load() == nil)
        cache.save(Data("{}".utf8))
        #expect(cache.load() == Data("{}".utf8))
        let mode = try FileManager.default.attributesOfItem(atPath: cache.url.path)[.posixPermissions] as? Int
        #expect(mode == 0o600)
    }

    @Test func oldCacheIsIgnoredAndClearRemovesIt() {
        let cache = cache(maxAge: 600)
        defer { cache.clear() }
        cache.save(Data("{}".utf8))
        #expect(cache.load(now: Date().addingTimeInterval(601)) == nil)
        cache.clear()
        #expect(cache.load() == nil)
    }

    @Test func aTimeoutThrowsItsWordsAndLetsFastWorkFinish() async throws {
        await #expect(throws: LocalServer.Failure.self) {
            try await LocalServer.withTimeout(0.1, failure: "too slow") { try await Task.sleep(for: .seconds(30)) }
        }
        try await LocalServer.withTimeout(5, failure: "too slow") {}
    }

    @Test func launchClockReportsTheProcessAge() {
        #expect((LaunchClock.sinceProcessStart() ?? -1) >= 0)
    }
}
