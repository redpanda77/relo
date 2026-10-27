import Foundation
import Testing
@testable import ReloNotchKit

@Suite struct ComputerConnectTests {
    let origin = URL(string: "https://relo.example.com")!
    let code = "rci_" + String(repeating: "a", count: 32)

    @Test func theInviteRequestIsTheDeviceCredentialsPost() throws {
        let request = LocalServer.computerInviteRequest(origin: origin, bearer: "tok")
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "https://relo.example.com/api/devices/self/computer-invites")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        let bytes = try #require(request.httpBody)
        let body = try #require(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        #expect(Set(body.keys) == ["level", "approvals"])
        #expect(body["approvals"] as? Bool == false)
    }

    @Test func readsTheCodeOrSaysWhy() {
        let ok = Data(#"{"inviteId":"cin_1","code":"\#(code)","command":"x"}"#.utf8)
        #expect((try? LocalServer.parseComputerInvite(status: 201, data: ok).get()) == code)
        #expect(throws: LocalServer.Failure.self) { try LocalServer.parseComputerInvite(status: 201, data: Data(#"{"code":"nope"}"#.utf8)).get() }
        #expect(throws: LocalServer.Failure.self) { try LocalServer.parseComputerInvite(status: 401, data: Data()).get() }
        #expect(throws: LocalServer.Failure.self) { try LocalServer.parseComputerInvite(status: 500, data: Data()).get() }
    }

    @Test func theJoinNamesTheServerProfileAndSkipsAgents() {
        let args = LocalServer.connectArguments(code: code, origin: origin, clientName: "Ana's MacBook")
        #expect(args == ["auth", "join", code, "--api-url", "https://relo.example.com", "--profile", "relo-example-com",
                         "--client-name", "Ana's MacBook", "--no-setup", "--json"])
        #expect(!args.contains("--local"))
    }

    @Test func profileNamesFitTheCLI() {
        #expect(LocalServer.profileName(forHost: "relo.example.com") == "relo-example-com")
        #expect(LocalServer.profileName(forHost: "") == "server")
        #expect(LocalServer.profileName(forHost: String(repeating: "a", count: 90)).count == 40)
    }

    @Test func theOutcomeIsPlainWords() throws {
        let saved = #"{"saved":{"server":"https://relo.example.com"},"clientName":"Mac","setup":{"agents":[]}}"#
        #expect(try LocalServer.connectOutcome(status: 0, stdout: saved, stderr: "").get().hasPrefix("Connected."))
        #expect(throws: LocalServer.Failure.self) { try LocalServer.connectOutcome(status: 1, stdout: "", stderr: "invalid code").get() }
        #expect(throws: LocalServer.Failure.self) { try LocalServer.connectOutcome(status: 1, stdout: "", stderr: "boom").get() }
    }
}
