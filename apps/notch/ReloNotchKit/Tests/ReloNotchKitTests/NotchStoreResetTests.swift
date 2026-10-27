import Foundation
import ReloCore
import ReloTransport
import Testing
@testable import ReloNotchKit

@Suite @MainActor struct NotchStoreResetTests {
    private func summary() throws -> NowSummary {
        struct Fixture: Decodable { let nowSummary: NowSummary }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../ios/Tests/ReloCoreTests/Fixtures/owner-state-v1.json").standardizedFileURL
        return try ReloWireJSON.decoder().decode(Fixture.self, from: Data(contentsOf: url)).nowSummary
    }

    private func store() -> ReloNotchStore {
        let store = ReloNotchStore()
        store.nowCache = NowCache(url: FileManager.default.temporaryDirectory
            .appendingPathComponent("relo-store-tests-\(UUID().uuidString)/now.json"), maxAge: 600)
        return store
    }

    @Test func aRefusedCredentialForgetsTheOldNowAndSignalsAReset() throws {
        let store = store()
        store.receive(try summary())
        #expect(store.summary != nil && store.lastUpdated != nil)
        let before = store.resetGeneration
        store.credentialRefused()
        #expect(store.summary == nil && store.presentation == .empty && store.lastUpdated == nil)
        #expect(store.questions.isEmpty && store.answers.isEmpty && store.waitingComputers.isEmpty && store.notices.isEmpty)
        #expect(store.connection == .needsSignIn && store.problem != nil)
        #expect(store.resetGeneration == before + 1)
    }

    @Test func aLocalServerThatFailsToStartDropsTheCachedNow() throws {
        let store = store()
        store.showCachedNow(try summary(), data: Data("{}".utf8))
        #expect(store.showingCached && store.summary != nil)
        store.setLocalStartFailed(true, detail: "port busy")
        #expect(!store.showingCached && store.summary == nil && store.presentation == .empty)
    }

    @Test func theCachedNowExpiresAfterTenMinutesWithoutLiveData() throws {
        let store = store()
        let wrote = Date()
        store.showCachedNow(try summary(), data: Data("{}".utf8), modified: wrote)
        store.expireCachedNow(now: wrote.addingTimeInterval(300))
        #expect(store.showingCached && store.summary != nil)
        store.expireCachedNow(now: wrote.addingTimeInterval(601))
        #expect(!store.showingCached && store.summary == nil)
    }

    @Test func errorsReachTheScreenAsPlainSentences() {
        struct Odd: Error { let secret = "OSStatus -25293 boom" }
        let signIn = "Relo couldn't sign in. Try again, or try it on this Mac."
        #expect(ReloNotchStore.message(for: Odd()) == signIn)
        #expect(ReloNotchStore.message(for: CredentialStoreError.keychain(-25293)).contains("-25293") == false)
        #expect(ReloNotchStore.message(for: URLError(.notConnectedToInternet))
                == "Relo can't reach your server. Check your connection and try again.")
        #expect(!ReloNotchStore.message(for: Odd(), local: true).contains("OSStatus"))
        #expect(!ReloNotchStore.message(for: Odd(), fallback: "Relo couldn't send that answer. Try again.").contains("Odd"))
    }

    @Test func openingHomeCountsAsALookFromNow() throws {
        let store = store()
        let origin = try #require(URL(string: "http://127.0.0.1:8180"))
        let account = "look-test-\(UUID().uuidString)"
        store.adoptCredentialForTesting(DeviceCredential(deviceId: "d", installationId: UUID(), accessToken: "t",
                                                         issuedAt: Date(), accountId: account, credentialVersion: 1), origin: origin)
        let key = "now.lastLookedAt|\(origin.absoluteString)|\(account)"
        defer { UserDefaults.standard.removeObject(forKey: key) }
        #expect(UserDefaults.standard.object(forKey: key) == nil)
        let before = Date()
        store.markLooked()
        let saved = try #require(UserDefaults.standard.object(forKey: key) as? Date)
        #expect(saved >= before && saved <= Date())
    }
}
