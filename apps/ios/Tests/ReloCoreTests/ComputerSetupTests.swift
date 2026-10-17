import CryptoKit
import Foundation
import XCTest
@testable import ReloCore

final class ComputerSetupTests: XCTestCase {
    private let zeroBind = "AAAAAAAAAAAAAAAAAAAAAA"
    private let clientID = "key_0123456789ab"
    private let identityKey = "BAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4_QA"
    /// HMAC-SHA256 under sixteen zero bytes, computed with Python's hmac module (the CLI's `computerBinding` is the same MAC).
    private let expectedBinding = "cwZdokxhsQn3KcyLzr60QOdB-5-eW2IUEu3mRrDxk2k"

    // MARK: Bind

    func testGeneratedBindIsSixteenRandomBytesAsTwentyTwoBase64URLCharacters() {
        let first = ReloComputerBind.generate()
        XCTAssertEqual(first.count, 22)
        XCTAssertTrue(ReloComputerBind.isValid(first))
        XCTAssertNotEqual(first, ReloComputerBind.generate())
        XCTAssertNil(first.rangeOfCharacter(from: CharacterSet(charactersIn: "+/=.")))
    }

    func testBindEncodingIsUnpaddedURLSafeBase64() {
        XCTAssertEqual(ReloComputerBind.encode(Data(repeating: 0, count: 16)), zeroBind)
        XCTAssertEqual(ReloComputerBind.encode(Data(repeating: 0xFB, count: 16)), "-_v7-_v7-_v7-_v7-_v7-w")
        XCTAssertFalse(ReloComputerBind.isValid("short"))
        XCTAssertFalse(ReloComputerBind.isValid(zeroBind + "A"))
        XCTAssertFalse(ReloComputerBind.isValid("AAAAAAAAAAAAAAAAAAAA+/"))
    }

    func testFullCodeJoinsRedeemAndBindHalvesWithADot() {
        XCTAssertEqual(ReloComputerBind.fullCode(code: "rci_abc", bind: zeroBind), "rci_abc." + zeroBind)
    }

    // MARK: HMAC

    func testBindingMatchesTheCLIsHMAC() {
        XCTAssertEqual(ReloComputerBind.binding(bind: zeroBind, clientID: clientID, identityKey: identityKey), expectedBinding)
        XCTAssertTrue(ReloComputerBind.verifies(bind: zeroBind, clientID: clientID, identityKey: identityKey, binding: expectedBinding))
    }

    func testASwappedKeyLoginOrBindFailsVerification() {
        XCTAssertFalse(ReloComputerBind.verifies(bind: zeroBind, clientID: clientID, identityKey: identityKey + "A", binding: expectedBinding))
        XCTAssertFalse(ReloComputerBind.verifies(bind: zeroBind, clientID: "key_other", identityKey: identityKey, binding: expectedBinding))
        XCTAssertFalse(ReloComputerBind.verifies(bind: ReloComputerBind.generate(), clientID: clientID, identityKey: identityKey,
                                                 binding: expectedBinding))
        XCTAssertFalse(ReloComputerBind.verifies(bind: zeroBind, clientID: clientID, identityKey: identityKey, binding: "short"))
        XCTAssertFalse(ReloComputerBind.verifies(bind: "not a bind", clientID: clientID, identityKey: identityKey, binding: expectedBinding))
    }

    // MARK: Status decoding

    private func decode(_ json: String) throws -> ReloComputerInviteStatus {
        try JSONDecoder().decode(ReloComputerInviteStatus.self, from: Data(json.utf8))
    }

    func testWaitingStatusHasNoComputer() throws {
        let status = try decode(#"{"inviteId":"cin_00000000-0000-0000-0000-000000000001","state":"waiting","expiresAt":"2026-10-17T12:30:00.000Z","computer":null}"#)
        XCTAssertEqual(status.state, .waiting)
        XCTAssertNil(status.computer)
        XCTAssertEqual(ReloSetupProgress(status: status).stage, .waiting)
    }

    func testReportedStatusDecodesKeyBindingHarnessesAndCheck() throws {
        let status = try decode("""
        {"inviteId":"cin_00000000-0000-0000-0000-000000000001","state":"key_published","expiresAt":"2026-10-17T12:30:00Z",
         "computer":{"clientId":"\(clientID)","name":"orchard","cliVersion":"0.17.2","identityKey":"\(identityKey)","binding":"\(expectedBinding)",
           "harnesses":[{"id":"claude-code","detected":true,"level":"guide"},{"id":"codex","detected":true,"level":"none"}],
           "check":{"ok":false,"failing":["sealing"]}}}
        """)
        XCTAssertEqual(status.state, .keyPublished)
        let computer = try XCTUnwrap(status.computer)
        XCTAssertEqual(computer.clientId, clientID)
        XCTAssertEqual(computer.identityKey, identityKey)
        XCTAssertEqual(computer.binding, expectedBinding)
        XCTAssertEqual(computer.harnesses.map(\.level), ["guide", "none"])
        XCTAssertEqual(computer.check, .init(ok: false, failing: ["sealing"]))
    }

    func testKeyAndBindingMayBeAbsentBeforeThePublish() throws {
        let status = try decode(#"{"inviteId":"cin_1","state":"redeemed","expiresAt":"x","computer":{"clientId":"key_1","name":"orchard","cliVersion":null,"identityKey":null,"binding":null,"harnesses":[],"check":null}}"#)
        XCTAssertNil(status.computer?.identityKey)
        XCTAssertEqual(ReloComputerBindCheck.evaluate(status, bind: zeroBind), .notYet)
    }

    func testInviteDecodesIdCodeAndCommand() throws {
        let json = #"{"inviteId":"cin_1","code":"rci_abc","command":"curl -fsSL https://relo.example/install.sh | sh -s -- rci_abc","expiresAt":"2026-10-17T12:30:00.000Z","level":"track","approvals":false,"agents":null}"#
        let invite = try JSONDecoder().decode(ReloComputerInvite.self, from: Data(json.utf8))
        XCTAssertEqual(invite.inviteId, "cin_1")
        XCTAssertNil(invite.agents)
        XCTAssertEqual(ReloComputerSetup.command(for: invite, bind: zeroBind),
                       "curl -fsSL https://relo.example/install.sh | sh -s -- rci_abc.\(zeroBind)")
        XCTAssertNotNil(ReloComputerSetup.expiry(invite.expiresAt))
    }

    // MARK: Bind check

    private func status(state: ReloComputerInviteStatus.State, key: String?, binding: String?) -> ReloComputerInviteStatus {
        .init(inviteId: "cin_1", state: state, expiresAt: "x",
              computer: .init(clientId: clientID, name: "orchard", identityKey: key, binding: binding))
    }

    func testBindCheckVerifiesAMatchingKeyAndRejectsASwappedOne() {
        XCTAssertEqual(ReloComputerBindCheck.evaluate(status(state: .keyPublished, key: identityKey, binding: expectedBinding), bind: zeroBind),
                       .verified(clientID: clientID, identityKey: identityKey))
        XCTAssertEqual(ReloComputerBindCheck.evaluate(status(state: .keyPublished, key: identityKey + "A", binding: expectedBinding), bind: zeroBind),
                       .mismatch)
        XCTAssertEqual(ReloComputerBindCheck.evaluate(status(state: .keyPublished, key: identityKey, binding: nil), bind: zeroBind), .notYet)
    }

    func testJoiningKeyBuildsTheApprovalSubjectFromAP256Key() throws {
        let key = P256.Signing.PrivateKey().publicKey.x963Representation
        let encoded = ReloE2EE.base64URL(key)
        let client = try XCTUnwrap(ReloClientKey.joining(clientID: clientID, name: "orchard", identityKey: encoded))
        XCTAssertEqual(client.publicKey, encoded)
        XCTAssertEqual(client.keyId, ReloE2EE.keyID(publicKeyX963: key))
        XCTAssertNil(ReloClientKey.joining(clientID: clientID, name: "orchard", identityKey: "AAAA"))
    }

    // MARK: State mapping

    func testStatesMapToStagesAndLiveActivityStates() {
        let expectations: [(ReloComputerInviteStatus.State, ReloSetupProgress.Stage, String)] = [
            (.waiting, .waiting, "waiting"), (.redeemed, .connecting, "redeemed"), (.keyPublished, .connecting, "redeemed"),
            (.reported, .connected, "reported"), (.tested, .tested, "tested"), (.expired, .expired, "expired"),
        ]
        for (state, stage, activity) in expectations {
            let progress = ReloSetupProgress(status: status(state: state, key: nil, binding: nil))
            XCTAssertEqual(progress.stage, stage, "\(state)")
            XCTAssertEqual(progress.activityState, activity, "\(state)")
        }
        XCTAssertEqual(ReloSetupProgress(status: nil).stage, .waiting)
        XCTAssertTrue(ReloSetupProgress(status: status(state: .tested, key: nil, binding: nil)).isFinished)
        XCTAssertTrue(ReloSetupProgress(status: status(state: .expired, key: nil, binding: nil)).isFinished)
        XCTAssertFalse(ReloSetupProgress(status: status(state: .reported, key: nil, binding: nil)).isFinished)
    }

    func testProgressNamesTheComputerAndSplitsAgentsByWhetherTheyAreConnected() throws {
        let reported = try decode("""
        {"inviteId":"cin_1","state":"reported","expiresAt":"x","computer":{"clientId":"key_1","name":"orchard","cliVersion":"0.17.2",
         "identityKey":null,"binding":null,"harnesses":[{"id":"claude-code","detected":true,"level":"guide"},
         {"id":"codex","detected":true,"level":"none"},{"id":"gemini","detected":false,"level":"none"}],"check":{"ok":true,"failing":[]}}}
        """)
        let progress = ReloSetupProgress(status: reported)
        XCTAssertEqual(progress.headline, "orchard connected")
        XCTAssertEqual(progress.connectedAgents, ["Claude Code (guide)"])
        XCTAssertEqual(progress.foundAgents, ["Codex"])
        XCTAssertEqual(progress.failingChecks, [])
        XCTAssertEqual(ReloSetupProgress(status: nil).headline, "Waiting for your computer…")
        XCTAssertEqual(ReloSetupProgress(status: status(state: .redeemed, key: nil, binding: nil)).headline, "orchard is connecting…")
    }

    func testPushedAgentEntriesKeepTheirLevelAndGetTheirNames() {
        XCTAssertEqual(ReloComputerSetup.agentLine("claude-code (guide)"), "Claude Code (guide)")
        XCTAssertEqual(ReloComputerSetup.agentLine("Claude Code (guide)"), "Claude Code (guide)")
        XCTAssertEqual(ReloComputerSetup.agentLine("codex"), "Codex")
        XCTAssertEqual(ReloComputerSetup.agentLine("unknown-agent"), "unknown-agent")
    }

    func testAgentPromptCarriesTheFullCodeAndTheLevel() {
        let prompt = ReloComputerSetup.agentPrompt(origin: URL(string: "https://relo.example/")!, fullCode: "rci_abc." + zeroBind, level: "guide")
        XCTAssertEqual(prompt, "Read https://relo.example/install.md?code=rci_abc.\(zeroBind) and set up Relo on this computer at the guide level. "
            + "It sends me a first notification when it is done.")
    }

    // MARK: Stored code

    func testPendingInviteExpiresAndKeepsItsFullCode() {
        let now = Date()
        let invite = ReloPendingComputerInvite(inviteId: "cin_1", code: "rci_abc", bind: zeroBind, command: "cmd", level: "track",
                                               mode: .agent, expiresAt: now.addingTimeInterval(60))
        XCTAssertEqual(invite.fullCode, "rci_abc." + zeroBind)
        XCTAssertFalse(invite.isExpired(now))
        XCTAssertTrue(invite.isExpired(now.addingTimeInterval(61)))
        let store = InMemoryComputerInviteStore()
        XCTAssertNil(try store.load())
        try? store.save(invite)
        XCTAssertEqual(try store.load(), invite)
        try? store.delete()
        XCTAssertNil(try store.load())
    }

    // MARK: Deep link and sign-up URL

    func testSetupDeepLinkAndSignUpURL() {
        XCTAssertTrue(ReloDeepLink.isSetup(ReloDeepLink.setupURL))
        XCTAssertFalse(ReloDeepLink.isSetup(URL(string: "relo://setup/extra")!))
        XCTAssertFalse(ReloDeepLink.isSetup(URL(string: "relo://settings/security")!))
        let flow = BrowserSignIn(verifier: String(repeating: "a", count: 43), state: String(repeating: "s", count: 20))
        let origin = URL(string: "https://relo.example")!
        let items = { (url: URL?) in URLComponents(url: url!, resolvingAgainstBaseURL: false)?.queryItems?.map(\.name) ?? [] }
        XCTAssertFalse(items(flow.authorizationURL(origin: origin)).contains("mode"))
        XCTAssertEqual(URLComponents(url: flow.authorizationURL(origin: origin, signUp: true)!, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "mode" }?.value, "sign-up")
    }

    // MARK: Approval, restart hint, options

    private func approvalStatus(_ approval: String?, state: String = "reported", key: Bool = true) throws -> ReloComputerInviteStatus {
        let field = approval.map { #","approval":"\#($0)""# } ?? ""
        return try decode("""
        {"inviteId":"cin_1","state":"\(state)","expiresAt":"x","computer":{"clientId":"key_1","name":"orchard","cliVersion":null,
         "identityKey":\(key ? "\"\(identityKey)\"" : "null"),"binding":null,"harnesses":[{"id":"codex","detected":true,"level":"guide"}],
         "check":null\(field)}}
        """)
    }

    func testApprovalDecodesAndIsOptional() throws {
        XCTAssertEqual(try approvalStatus("waiting").computer?.approval, .waiting)
        XCTAssertEqual(try approvalStatus("approved").computer?.approval, .approved)
        XCTAssertEqual(try approvalStatus("not_needed").computer?.approval, .notNeeded)
        XCTAssertNil(try approvalStatus(nil).computer?.approval)
    }

    func testWaitingApprovalHoldsTheFirstNotificationStep() throws {
        let waiting = ReloSetupProgress(status: try approvalStatus("waiting", state: "tested"))
        XCTAssertTrue(waiting.needsApproval)
        XCTAssertFalse(waiting.notificationStep.done)
        XCTAssertEqual(waiting.notificationStep.detail, "It opens here once you approve orchard.")
        for approval in ["approved", "not_needed", nil] {
            let step = ReloSetupProgress(status: try approvalStatus(approval, state: "tested")).notificationStep
            XCTAssertTrue(step.done)
            XCTAssertEqual(step.title, "First notification sent")
        }
        XCTAssertFalse(ReloSetupProgress(status: try approvalStatus("approved", state: "reported")).notificationStep.done)
        // Approved on this phone a poll before the server counts it.
        XCTAssertFalse(ReloSetupProgress(status: try approvalStatus("waiting"), approvedHere: true).needsApproval)
        // No key yet: nothing to approve.
        XCTAssertFalse(ReloSetupProgress(status: try approvalStatus("waiting", key: false)).needsApproval)
    }

    func testRestartHintNamesTheConnectedAgents() throws {
        XCTAssertEqual(ReloSetupProgress(status: try approvalStatus("approved")).connectedAgentNames, ["Codex"])
        XCTAssertEqual(ReloComputerSetup.restartHint(agents: ["Claude Code"], computer: "orchard"),
                       "Restart Claude Code on orchard so they load Relo. Sessions already open don't see it until then.")
        XCTAssertEqual(ReloComputerSetup.restartHint(agents: ["Claude Code", "Codex", "Amp"], computer: nil),
                       "Restart Claude Code, Codex and Amp on the computer so they load Relo. Sessions already open don't see it until then.")
        XCTAssertNil(ReloComputerSetup.restartHint(agents: [], computer: "orchard"))
    }

    func testAgentOptionEncoding() {
        XCTAssertEqual(ReloComputerSetup.agentsOption(all: true, chosen: ["codex"]), [])
        XCTAssertEqual(ReloComputerSetup.agentsOption(all: false, chosen: ["amp", "codex", "claude-code", "bogus"]), ["claude-code", "codex", "amp"])
        XCTAssertNil(ReloComputerSetup.agentsOption(all: false, chosen: []))
        XCTAssertEqual(ReloComputerSetup.agentName("amp"), "Amp")
    }

    func testResumeKeepsAWaitingCodeWithItsCommand() throws {
        let record = ReloPendingComputerInvite(inviteId: "cin_1", code: "rci_abc", bind: zeroBind, command: "run rci_abc." + zeroBind,
                                               level: "track", mode: .command, expiresAt: Date().addingTimeInterval(600))
        let store = InMemoryComputerInviteStore()
        try store.save(record)
        let back = try JSONDecoder().decode(ReloPendingComputerInvite.self, from: JSONEncoder().encode(try XCTUnwrap(store.load())))
        XCTAssertEqual(back, record)
        XCTAssertNil(back.approved)
        XCTAssertFalse(back.isExpired(Date()))
    }
}
