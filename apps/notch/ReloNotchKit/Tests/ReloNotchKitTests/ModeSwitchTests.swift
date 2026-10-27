import Foundation
import Testing
@testable import ReloNotchKit

@Suite struct ModeSwitchTests {
    private func defaults() -> UserDefaults {
        let name = "relo.test.modeswitch.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    @Test func aServerAddressIsRememberedForTheWayBack() {
        let d = defaults()
        #expect(ModeSwitch.lastServer(d) == nil)
        #expect(ModeSwitch.lastServerAddress(d) == "")
        ModeSwitch.remember(server: URL(string: "https://relo.example.com")!, d)
        #expect(ModeSwitch.lastServerAddress(d) == "https://relo.example.com")
        ModeSwitch.remember(server: URL(string: "http://192.168.1.5:8180")!, d)
        #expect(ModeSwitch.lastServerAddress(d) == "http://192.168.1.5:8180")
    }

    @Test func thisMacIsNeverRememberedAsAServer() {
        let d = defaults()
        ModeSwitch.remember(server: URL(string: "http://127.0.0.1:8181")!, d)
        ModeSwitch.remember(server: URL(string: "http://localhost:8181")!, d)
        #expect(ModeSwitch.lastServer(d) == nil)
    }

    @Test func theCommandReportsHereOnlyToThisMacsServer() {
        func status(_ signedIn: Bool, _ server: String?) -> LocalServer.CommandSignIn {
            .init(signedIn: signedIn, server: server.flatMap(URL.init(string:)))
        }
        #expect(ModeSwitch.commandReportsHere(status(true, "http://127.0.0.1:8181"), localPort: 8181))
        #expect(!ModeSwitch.commandReportsHere(status(true, "http://127.0.0.1:9000"), localPort: 8181))
        #expect(!ModeSwitch.commandReportsHere(status(true, "https://relo.example.com"), localPort: 8181))
        #expect(!ModeSwitch.commandReportsHere(status(false, "http://127.0.0.1:8181"), localPort: 8181))
        #expect(!ModeSwitch.commandReportsHere(status(false, nil), localPort: 8181))
        #expect(ModeSwitch.commandReportsHere(status(true, "http://localhost:8181"), localPort: nil))
    }

    @Test func theWordsAreForNonTechnicalOwners() {
        let words = [ModeSwitch.tryHereTitle(), ModeSwitch.tryHereBody(host: "relo.example.com"), ModeSwitch.useServerTitle,
                     ModeSwitch.useServerBody, ModeSwitch.tryHereRowDetail, ModeSwitch.useServerRowDetail, ModeSwitch.signingIn,
                     ModeSwitch.connectingAgents, ModeSwitch.connected(host: "relo.example.com"), ModeSwitch.cancelled,
                     ModeSwitch.agentsNotConnected, ModeSwitch.setupUndone(host: "relo.example.com"), ModeSwitch.setupUndone(host: nil)]
        for text in words {
            for jargon in ["relo command", "hook", "profile", "login item", "dashboard", "cli"] {
                #expect(!text.lowercased().contains(jargon), "\(text) says \(jargon)")
            }
        }
        #expect(ModeSwitch.tryHereBody(host: "h.example").contains("switch back anytime in Settings"))
        #expect(ModeSwitch.goBack == "Go back to Relo on this Mac")
    }
}
