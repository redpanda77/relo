import Foundation
import Testing
@testable import ReloCore

@Suite("Stable account presentation")
struct ReloPresentationScopeTests {
    private let origin = "https://relo.example.com"
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let account = AccountSummary(accountId: "account-one", name: "Owner", email: "owner@example.com")
    private let user = AccountUser(id: "user-one", name: "Owner", email: "owner@example.com")

    private func credential(version: Int, accountID: String = "account-one") -> DeviceCredential {
        .init(deviceId: "device-\(version)", installationId: UUID(), accessToken: "fixture-\(version)",
              issuedAt: now, accountId: accountID, credentialVersion: version)
    }
    private func session(id: String, account: AccountSummary? = nil) -> AccountSession {
        .init(accessToken: "fixture", sessionId: id, expiresAt: now.addingTimeInterval(3600), user: user, account: account)
    }

    @Test("Session validation and device re-registration preserve navigation and detail")
    func registrationKeepsViewLifetime() {
        let restored = ReloPresentationScope(serverOrigin: origin, account: nil,
            session: session(id: "old", account: account), credential: credential(version: 1), user: nil)
        let validated = ReloPresentationScope(serverOrigin: origin, account: account,
            session: session(id: "new", account: account), credential: credential(version: 2), user: user)
        #expect(restored == validated)
        var navigation = ReloNavigationState()
        navigation.transition(to: restored.identity)
        navigation.tab = .history
        navigation.open("notification-one")
        navigation.transition(to: validated.identity)
        #expect(navigation.tab == .history)
        #expect(navigation.notificationID == "notification-one")
        #expect(navigation.detailTab == .history)
    }

    @Test("Device-only restoration and session recovery use the same account identity")
    func deviceOnlyRecovery() {
        let deviceOnly = ReloPresentationScope(serverOrigin: origin, account: nil, session: nil,
                                              credential: credential(version: 1), user: nil)
        let signedIn = ReloPresentationScope(serverOrigin: origin, account: account,
            session: session(id: "recovered", account: account), credential: credential(version: 2), user: user)
        #expect(deviceOnly == signedIn)
    }

    @Test("Changing account or server clears navigation")
    func isolation() {
        let initial = ReloPresentationScope(serverOrigin: origin, account: account, session: nil,
                                            credential: credential(version: 1), user: user)
        let otherAccount = ReloPresentationScope(serverOrigin: origin, account: nil, session: nil,
                                                 credential: credential(version: 1, accountID: "account-two"), user: user)
        let otherServer = ReloPresentationScope(serverOrigin: "https://other.example.com", account: account,
                                                session: nil, credential: credential(version: 1), user: user)
        for changed in [otherAccount, otherServer] {
            #expect(changed != initial)
            var navigation = ReloNavigationState()
            navigation.transition(to: initial.identity)
            navigation.tab = .history
            navigation.open("private-notification")
            navigation.transition(to: changed.identity)
            #expect(navigation.notificationID == nil)
            #expect(navigation.tab == .now)
        }
    }
}
