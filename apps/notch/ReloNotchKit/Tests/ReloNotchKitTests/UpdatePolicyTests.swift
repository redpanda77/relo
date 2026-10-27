import Foundation
import Testing
@testable import ReloNotchKit

@Suite struct UpdatePolicyTests {
    let release = URL(string: "https://relo.example.com")!
    let remote = URL(string: "https://my.example.org")!
    let loopback = URL(string: "http://127.0.0.1:8787")!

    @Test func aRemoteServerKeepsItsOwnFeed() {
        let url = UpdatePolicy.appcastURL(serverOrigin: remote, releaseOrigin: release, localMode: false)
        #expect(url?.absoluteString == "https://my.example.org/mac/appcast.xml")
    }

    @Test func localModeAndLoopbackUseTheReleaseFeed() {
        let expected = "https://relo.example.com/mac/appcast.xml"
        #expect(UpdatePolicy.appcastURL(serverOrigin: loopback, releaseOrigin: release, localMode: true)?.absoluteString == expected)
        #expect(UpdatePolicy.appcastURL(serverOrigin: loopback, releaseOrigin: release, localMode: false)?.absoluteString == expected)
        #expect(UpdatePolicy.appcastURL(serverOrigin: nil, releaseOrigin: release, localMode: true)?.absoluteString == expected)
    }

    @Test func noOriginMeansNoCheck() {
        #expect(UpdatePolicy.appcastURL(serverOrigin: nil, releaseOrigin: release, localMode: false) == nil)
        #expect(UpdatePolicy.appcastURL(serverOrigin: loopback, releaseOrigin: nil, localMode: false) == nil)
    }

    @Test func laterHidesTheReminderForADayThenItReturns() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let until = UpdatePolicy.snoozedUntil(from: now)
        #expect(UpdatePolicy.isSnoozed(version: "1.2", snoozedVersion: "1.2", until: until, now: now.addingTimeInterval(3600)))
        #expect(!UpdatePolicy.isSnoozed(version: "1.2", snoozedVersion: "1.2", until: until, now: now.addingTimeInterval(86_401)))
    }

    @Test func aNewerVersionIsNotSnoozed() {
        let now = Date()
        #expect(!UpdatePolicy.isSnoozed(version: "1.3", snoozedVersion: "1.2", until: now.addingTimeInterval(100), now: now))
        #expect(!UpdatePolicy.isSnoozed(version: "1.3", snoozedVersion: nil, until: nil, now: now))
    }

    @Test func theLineAfterAnUpdateSaysWhatHappenedToTheAgents() {
        #expect(UpdatePolicy.updatedLine(version: "0.2.32", agents: .notApplicable) == "Updated to 0.2.32")
        #expect(UpdatePolicy.updatedLine(version: "0.2.32", agents: .refreshed) == "Updated to 0.2.32 · agents refreshed")
        #expect(UpdatePolicy.updatedLine(version: "0.2.32", agents: .failed)
                == "Updated to 0.2.32 · agents not refreshed: Set up agents again in Settings")
        #expect(UpdatePolicy.versionText("0.2.32") == "Version 0.2.32")
    }
}
