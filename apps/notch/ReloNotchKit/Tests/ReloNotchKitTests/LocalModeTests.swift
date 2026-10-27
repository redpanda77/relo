import Foundation
import Testing
@testable import ReloNotchKit

@Suite struct LocalModeTests {
    private let avoided = ["sign in", "sign out", "account", "server", "port ", "release", "encrypt", "private work", "iphone",
                           "approve", "dashboard", "connect", "offline"]

    @Test func localWordsNeverNameWhatLocalModeDoesNotHave() {
        let words = [LocalMode.needsRepair, LocalMode.repair, LocalMode.hoverToRepair, LocalMode.hoverStartFailed,
                     LocalMode.startFailedTitle, LocalMode.notAnswering, LocalMode.notAnsweringShort, LocalMode.starting,
                     LocalMode.replyInTerminal, LocalMode.untitled(local: true), LocalMode.unreadable(local: true),
                     LocalMode.offlineAnswer(local: true), LocalMode.textReply(local: true), LocalMode.offlineLabel(local: true),
                     LocalMode.onThisMac, LocalMode.removed]
        for text in words {
            for word in avoided { #expect(!text.lowercased().contains(word), "\(text) says \(word)") }
        }
    }

    @Test func remoteWordsStayAsTheyWere() {
        #expect(LocalMode.unreadable(local: false) == "Approve this Mac on your iPhone to read it")
        #expect(LocalMode.offlineAnswer(local: false) == "Offline: answer on your iPhone")
        #expect(LocalMode.textReply(local: false) == "Reply on your iPhone or in the Dashboard")
        #expect(LocalMode.untitled(local: false) == "Private work")
    }

    @Test func theOfflineWordsFollowTheMode() {
        #expect(LocalMode.offlineLabel(local: false) == "Offline")
        #expect(LocalMode.offlineSymbol(local: false) == "wifi.slash")
        #expect(LocalMode.offlineLabel(local: true) == "Not answering")
        #expect(LocalMode.offlineSymbol(local: true) == "exclamationmark.circle")
    }

    @Test func theConfirmationsSayWhatHappens() {
        #expect(LocalMode.replaceLoginConfirmation(host: "relo.example.com")
                == "Relo will sign out of relo.example.com and run on this Mac instead: your agents report here, and nothing leaves this Mac. You can sign in to relo.example.com again later from Settings.")
        #expect(LocalMode.leaveConfirmation.hasPrefix("Relo on this Mac stops. Your cards stay on this Mac."))
    }

    @Test func theFlagIsTheDefaultsKey() {
        let defaults = UserDefaults(suiteName: "relo.test.localmode")!
        defaults.removePersistentDomain(forName: "relo.test.localmode")
        #expect(!LocalMode.isOn(defaults))
        defaults.set(true, forKey: "relo.localMode")
        #expect(LocalMode.isOn(defaults))
        LocalMode.set(false, defaults)
        #expect(!LocalMode.isOn(defaults))
    }
}
