import Foundation
import ReloCore
import Testing
@testable import ReloNotchKit

private let ticket = "relo_pending_" + String(repeating: "a", count: 43)

private func pending(startedAt: Date = Date()) -> PendingSignIn {
    PendingSignIn(origin: URL(string: "https://relo.example.org")!, ticket: ticket, codeVerifier: String(repeating: "v", count: 43),
                  installationId: "11111111-2222-3333-4444-555555555555", startedAt: startedAt)
}

private let approvedBody = Data("""
{"sessionToken":"tok","session":{"id":"s1","expiresAt":"2026-12-01T10:00:00.000Z"},"user":{"id":"u1","name":"Ana","email":"ana@example.org"}}
""".utf8)

/// Answers a script of (status, body) in order (the last repeats), or fails like a lost connection.
private final class Script: @unchecked Sendable {
    enum Step { case answer(Int, Data), offline }
    private let lock = NSLock()
    private var steps: [Step]
    private(set) var requests: [URLRequest] = []
    private(set) var sleeps: [TimeInterval] = []
    init(_ steps: [Step]) { self.steps = steps }
    func send(_ request: URLRequest) async throws -> (Data, Int) {
        let step: Step = lock.withLock { requests.append(request); return steps.count > 1 ? steps.removeFirst() : steps[0] }
        switch step {
        case .answer(let status, let data): return (data, status)
        case .offline: throw URLError(.notConnectedToInternet)
        }
    }
    func sleep(_ seconds: TimeInterval) async throws { lock.withLock { sleeps.append(seconds) } }
}

@Suite struct PendingApprovalTests {
    // MARK: The callback

    @Test func aPendingCallbackGivesItsTicket() throws {
        let flow = BrowserSignIn(verifier: "v", state: "st")
        let url = URL(string: "relo://auth/callback?pending=\(ticket)&state=st")!
        #expect(try PendingSignInCallback.ticket(in: url, flow: flow) == ticket)
    }

    @Test func theStateIsCheckedAsForACode() {
        let flow = BrowserSignIn(verifier: "v", state: "st")
        #expect(throws: BrowserSignIn.CallbackError.stateMismatch) {
            try PendingSignInCallback.ticket(in: URL(string: "relo://auth/callback?pending=\(ticket)&state=other")!, flow: flow)
        }
        #expect(throws: BrowserSignIn.CallbackError.stateMismatch) {
            try PendingSignInCallback.ticket(in: URL(string: "relo://auth/callback?pending=\(ticket)")!, flow: flow)
        }
    }

    @Test func aMalformedTicketOrAMixedCallbackIsRefused() {
        let flow = BrowserSignIn(verifier: "v", state: "st")
        for query in ["pending=nope&state=st", "pending=relo_pending_short&state=st", "pending=\(ticket)&code=relo_signin_x&state=st",
                      "pending=\(ticket)&error=access_denied&state=st", "pending=&state=st"] {
            #expect(throws: BrowserSignIn.CallbackError.malformed, "\(query)") {
                try PendingSignInCallback.ticket(in: URL(string: "relo://auth/callback?\(query)")!, flow: flow)
            }
        }
    }

    @Test func codesCancelsAndOtherAddressesAreNotPending() throws {
        let flow = BrowserSignIn(verifier: "v", state: "st")
        for raw in ["relo://auth/callback?code=relo_signin_x&state=st", "relo://auth/callback?error=access_denied&state=st",
                    "https://auth/callback?pending=\(ticket)&state=st", "relo://other/callback?pending=\(ticket)&state=st"] {
            #expect(try PendingSignInCallback.ticket(in: URL(string: raw)!, flow: flow) == nil, "\(raw)")
        }
    }

    // MARK: The request and its answers

    @Test func theRequestCarriesTheTicketVerifierAndInstallation() throws {
        let request = PendingApproval.request(for: pending())
        #expect(request.url?.absoluteString == "https://relo.example.org/api/mobile/sign-in/pending")
        #expect(request.httpMethod == "POST")
        let body = try JSONSerialization.jsonObject(with: #require(request.httpBody)) as? [String: String]
        #expect(body == ["ticket": ticket, "codeVerifier": String(repeating: "v", count: 43),
                         "installationId": "11111111-2222-3333-4444-555555555555"])
    }

    @Test func eachStatusMapsToOneOutcome() {
        #expect(PendingApproval.outcome(status: 202, data: Data(#"{"status":"pending"}"#.utf8)) == .pending)
        #expect(PendingApproval.outcome(status: 410, data: Data(#"{"status":"declined"}"#.utf8)) == .declined)
        #expect(PendingApproval.outcome(status: 410, data: Data(#"{"status":"expired"}"#.utf8)) == .expired)
        #expect(PendingApproval.outcome(status: 410, data: Data()) == .expired)
        #expect(PendingApproval.outcome(status: 400, data: Data(#"{"error":"invalid_grant"}"#.utf8)) == .invalid)
        for status in [0, 429, 500, 503] { #expect(PendingApproval.outcome(status: status, data: Data()) == .retry) }
        #expect(PendingApproval.outcome(status: 200, data: Data("{}".utf8)) == .retry)
    }

    @Test func anApprovalIsTheTokenSessionTheAppAlreadyHandles() throws {
        guard case .approved(let session) = PendingApproval.outcome(status: 200, data: approvedBody) else {
            Issue.record("not approved"); return
        }
        #expect(session.accessToken == "tok" && session.sessionId == "s1")
        #expect(session.user == AccountUser(id: "u1", name: "Ana", email: "ana@example.org"))
        #expect(session.expiresAt == ReloWireJSON.date(from: "2026-12-01T10:00:00.000Z"))
    }

    // MARK: Backoff and the watch

    @Test func itAsksEveryHalfMinuteAndEveryFiveMinutesAfterAnHour() {
        let start = Date(timeIntervalSince1970: 1_000_000)
        #expect(PendingApproval.interval(startedAt: start, now: start) == 30)
        #expect(PendingApproval.interval(startedAt: start, now: start.addingTimeInterval(3599)) == 30)
        #expect(PendingApproval.interval(startedAt: start, now: start.addingTimeInterval(3600)) == 300)
        #expect(PendingApproval.interval(startedAt: start, now: start.addingTimeInterval(86_400)) == 300)
    }

    @Test func theWatchAsksAgainUntilApproved() async {
        let script = Script([.answer(202, Data()), .offline, .answer(429, Data()), .answer(200, approvedBody)])
        let finish = await PendingApproval.watch(pending(), send: script.send, sleep: script.sleep)
        guard case .approved(let session) = finish else { Issue.record("\(finish)"); return }
        #expect(session.user.email == "ana@example.org")
        #expect(script.requests.count == 4)
        #expect(script.sleeps == [30, 30, 30])
    }

    @Test func theWatchSlowsDownAfterAnHour() async {
        let started = Date(timeIntervalSince1970: 1_000_000)
        let script = Script([.answer(202, Data()), .answer(202, Data()), .answer(410, Data(#"{"status":"declined"}"#.utf8))])
        let finish = await PendingApproval.watch(pending(startedAt: started), now: { started.addingTimeInterval(7200) },
                                                 send: script.send, sleep: script.sleep)
        #expect(finish == .declined)
        #expect(script.sleeps == [300, 300])
    }

    @Test func theWatchEndsOnDeclinedExpiredAndUnknown() async {
        for (status, body, expected) in [(410, #"{"status":"declined"}"#, PendingApproval.Finish.declined),
                                         (410, #"{"status":"expired"}"#, .expired), (400, "{}", .invalid)] {
            let script = Script([.answer(status, Data(body.utf8))])
            let finish = await PendingApproval.watch(pending(), send: script.send, sleep: script.sleep)
            #expect(finish == expected)
            #expect(script.sleeps.isEmpty)
        }
    }

    @Test func aCancelledWatchStops() async {
        let script = Script([.answer(202, Data())])
        let finish = await PendingApproval.watch(pending(), send: script.send, sleep: { _ in throw CancellationError() })
        #expect(finish == .cancelled)
    }

    // MARK: Kept across a quit

    @Test func thePendingStateSurvivesAQuit() throws {
        let store = MemoryPendingSignInStore()
        let kept = pending()
        try store.save(kept)
        #expect(try store.load() == kept)
        try store.delete()
        #expect(try store.load() == nil)
    }

    @Test func thePendingStateRoundTripsThroughItsKeychainEncoding() throws {
        let original = pending(startedAt: Date(timeIntervalSince1970: 1_800_000_000))
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        let decoded = try ReloWireJSON.decoder().decode(PendingSignIn.self, from: encoder.encode(original))
        #expect(decoded == original)
        #expect(decoded.host == "relo.example.org")
    }

    @Test func theWordsNameTheServerAndPromiseThisMac() {
        let line = PendingApproval.waitingLine(host: "relo.example.org")
        #expect(line == "Your account is waiting for approval on relo.example.org. Relo works on this Mac meanwhile and signs in by itself once you're approved.")
        #expect(!PendingApproval.waitingLine(host: "h", localWorks: false).contains("this Mac"))
        #expect(PendingApproval.approved(host: "h") == "You're approved: Relo is now synced with h.")
        #expect(PendingApproval.endedLine(.declined, host: "h")?.contains("declined") == true)
        #expect(PendingApproval.endedLine(.expired, host: "h") == PendingApproval.endedLine(.invalid, host: "h"))
        #expect(PendingApproval.endedLine(.cancelled, host: "h") == nil)
    }
}

@Suite @MainActor struct PendingApprovalStoreTests {
    private func store(_ script: Script, kept: PendingSignIn? = nil) -> (ReloNotchStore, MemoryPendingSignInStore) {
        let store = ReloNotchStore()
        let memory = MemoryPendingSignInStore(kept)
        store.pendingStore = memory
        store.pendingSender = script.send
        store.pendingSleep = { _ in try await Task.sleep(for: .seconds(60)) }
        return (store, memory)
    }

    private func wait(_ condition: () -> Bool) async {
        for _ in 0..<300 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    @Test func aWaitingAccountIsRestoredAtLaunchAndAsksAtOnce() async throws {
        let script = Script([.answer(202, Data())])
        let (store, _) = store(script, kept: pending())
        store.restorePending(try store.pendingStore.load(), hasServerCredential: false)
        #expect(store.pendingApproval?.ticket == ticket)
        await wait { !script.requests.isEmpty }
        #expect(script.requests.count == 1)
        store.cancelPendingApproval()
    }

    @Test func aMacAlreadySignedInToAServerForgetsAStaleRequest() throws {
        let (store, memory) = store(Script([.answer(202, Data())]), kept: pending())
        store.restorePending(try memory.load(), hasServerCredential: true)
        #expect(store.pendingApproval == nil)
        #expect(try memory.load() == nil)
    }

    @Test func aDeclinedRequestIsForgottenAndSaid() async {
        let script = Script([.answer(410, Data(#"{"status":"declined"}"#.utf8))])
        let (store, memory) = store(script, kept: pending())
        var ended: PendingApproval.Finish?
        store.onPendingEnded = { finish, _ in ended = finish }
        store.restorePending(pending(), hasServerCredential: false)
        await wait { ended != nil }
        #expect(ended == .declined)
        #expect(store.pendingApproval == nil)
        #expect((try? memory.load()) == nil)
        #expect(store.problem == PendingApproval.declined(host: "relo.example.org"))
    }

    @Test func anApprovalHandsTheSessionToTheApp() async {
        let script = Script([.answer(200, approvedBody)])
        let (store, memory) = store(script, kept: pending())
        var received: (AccountSession, PendingSignIn)?
        store.onPendingApproved = { session, pending in received = (session, pending) }
        store.restorePending(pending(), hasServerCredential: false)
        await wait { received != nil }
        #expect(received?.0.user.email == "ana@example.org")
        #expect(received?.1.ticket == ticket)
        #expect(store.pendingApproval == nil)
        #expect((try? memory.load()) == nil)
    }

    @Test func cancelRequestForgetsTheTicketAndStopsAsking() async {
        let script = Script([.answer(202, Data())])
        let (store, memory) = store(script, kept: pending())
        store.restorePending(pending(), hasServerCredential: false)
        await wait { !script.requests.isEmpty }
        store.cancelPendingApproval()
        #expect(store.pendingApproval == nil)
        #expect((try? memory.load()) == nil)
    }
}
