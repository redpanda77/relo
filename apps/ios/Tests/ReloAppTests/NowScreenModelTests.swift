import Foundation
import ReloCore
import XCTest
@testable import Relo

/// Now renders the server's lists as is (plan 1.14): fixed section order, folds, Since you looked
/// copy, the missed-question footnote, the offline rename, and the Sessions section.
final class NowScreenModelTests: XCTestCase {
    private let locale = Locale(identifier: "en_US_POSIX")
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }
    /// 2027-01-15 18:00 UTC.
    private let serverTime = Date(timeIntervalSince1970: 1_800_036_000)

    private func item(_ id: String, _ state: OwnerState, reason: NowNeedsReason? = nil,
                      status: String? = "Working", minutesAgo: Double = 10) -> NowItemInput {
        NowItemInput(id: id, notificationID: "ntf_\(id)", title: "Work \(id)", status: status, source: "Claude Code",
                     project: "relo", state: state, reason: reason,
                     evidenceAt: serverTime.addingTimeInterval(-minutesAgo * 60))
    }

    private func session(_ id: String, computer: String?, phase: NowSessionInput.Phase?, folded: Bool = false,
                         waitingFor: String? = nil, workID: String? = nil) -> NowSessionInput {
        NowSessionInput(id: id, title: "Claude Code · relo", computer: computer, phase: phase, waitingFor: waitingFor,
                        lastSeenAt: serverTime.addingTimeInterval(-240), workID: workID, folded: folded)
    }

    private func busy() -> NowScreenInput {
        NowScreenInput(
            serverTime: serverTime,
            sinceYouLooked: NowSinceInput(since: serverTime.addingTimeInterval(-3_600), finished: 3, failed: 1),
            recent: [item("r1", .done), item("r2", .failed)],
            needsYou: [item("n1", .needsYou, reason: .missedQuestion)],
            waitingOnYou: [item("w1", .waitingOnYou)],
            running: [item("m1", .moving), item("q1", .workingQuietly)],
            quiet: [item("s1", .stale), item("s2", .stoppedResponding), item("s3", .noSignal)],
            paused: [item("p1", .paused)],
            sessions: [session("ags_1", computer: "Studio", phase: .working, workID: "m1"),
                       session("ags_2", computer: "Studio", phase: .idle, folded: true)])
    }

    private func make(_ input: NowScreenInput, offline: Bool = false, open: Set<String> = []) -> [NowBlock] {
        NowScreenModel.make(input, isOffline: offline, openFolds: open, calendar: calendar, locale: locale)
    }

    func testBlocksFollowSpecOrder() {
        XCTAssertEqual(make(busy()).map(\.id),
                       ["needs", "waiting", "running", "since", "fold-quiet", "fold-paused", "sessions"])
    }

    func testEmptyBlocksAreOmitted() {
        let blocks = make(NowScreenInput(serverTime: serverTime, sinceYouLooked: nil, running: [item("m1", .moving)]))
        XCTAssertEqual(blocks.map(\.id), ["running"])
    }

    func testFoldsCountAndRowsAndStayClosedByDefault() {
        for block in make(busy()) {
            guard case let .fold(fold, count, rows, open) = block else { continue }
            XCTAssertEqual(count, rows.count)
            XCTAssertFalse(open, "\(fold) is closed by default")
            switch fold {
            case .quiet: XCTAssertEqual(count, 3)
            case .paused: XCTAssertEqual(count, 1)
            case .idle: XCTFail("idle folds live in Sessions")
            }
        }
        let opened = make(busy(), open: ["quiet"])
        XCTAssertTrue(opened.contains { if case .fold(.quiet, _, _, true) = $0 { true } else { false } })
    }

    /// The owner's turn is shown open, as full work cards: status, plan and where it runs, never a bare row.
    func testWaitingOnYouIsOpenWorkCards() {
        var waiting = item("w1", .waitingOnYou, status: "Left on for debugging")
        waiting.steps = NowItem.Steps(done: 0, total: 10, current: "Reproduce the issue")
        waiting.computer = "Studio"
        waiting.topic = "App architecture audit"
        let blocks = make(NowScreenInput(serverTime: serverTime, sinceYouLooked: nil, waitingOnYou: [waiting]))
        guard case let .waitingOnYou(rows) = blocks.first else { return XCTFail("Waiting on you is a section, not a fold") }
        let card = try! XCTUnwrap(rows.first?.card)
        XCTAssertEqual(card.badge, "Your turn")
        XCTAssertEqual(card.status, "Left on for debugging")
        XCTAssertEqual(card.origin, ["Claude Code", "relo", "App architecture audit"])
        XCTAssertEqual(card.computer, "Studio")
        XCTAssertEqual(card.caption, "Step 1 of 10 · Reproduce the issue", "the time is the header's, never repeated")
        XCTAssertEqual(rows.first?.steps?.total, 10)
    }

    func testQuietNeverSaysRunningOrFailed() {
        let rows = busy().quiet.map { NowScreenModel.quietRow($0, now: serverTime, locale: locale) }
        for row in rows {
            let text = ([row.title, row.chip ?? ""] + row.lines).joined(separator: " ").lowercased()
            XCTAssertFalse(text.contains("running"), text)
            XCTAssertFalse(text.contains("failed"), text)
        }
        XCTAssertTrue(rows[1].lines[0].hasPrefix("Stopped responding at Working, last seen"))
        XCTAssertTrue(rows[2].lines[0].hasPrefix("No signal since"))
    }

    func testSinceLineCopy() {
        func line(_ since: NowSinceInput) -> NowScreenModel.SinceLine {
            NowScreenModel.sinceLine(since, serverTime: serverTime, calendar: calendar, locale: locale)
                ?? .init(text: "", spoken: "")
        }
        let today = serverTime.addingTimeInterval(-3_600)
        func clock(_ date: Date) -> String { date.formatted(Date.FormatStyle(time: .shortened).locale(locale)) }
        let five = clock(today)
        let all = line(NowSinceInput(since: today, finished: 3, failed: 1, waitingOnYou: 2, stoppedWithoutFinishing: 1))
        XCTAssertEqual(all.text, "Since \(five): 3 finished, 1 failed, 2 waiting on you, 1 stopped without finishing")
        XCTAssertFalse(all.spoken.contains(":  "))
        XCTAssertEqual(line(NowSinceInput(since: today, failed: 2)).text, "Since \(five): 2 failed", "zero parts omitted")
        let yesterday = line(NowSinceInput(since: serverTime.addingTimeInterval(-20 * 3_600), finished: 1))
        XCTAssertEqual(yesterday.text, "Since yesterday \(clock(serverTime.addingTimeInterval(-20 * 3_600))): 1 finished")
        let window = line(NowSinceInput(since: serverTime.addingTimeInterval(-NowScreenModel.defaultWindow), finished: 1))
        XCTAssertEqual(window.text, "In the last 8 hours: 1 finished")
        XCTAssertNil(NowScreenModel.sinceLine(NowSinceInput(since: today), serverTime: serverTime,
                                              calendar: calendar, locale: locale),
                     "a quiet stretch has no line: the deck's sync status already says it")
        let quiet = make(NowScreenInput(serverTime: serverTime, sinceYouLooked: NowSinceInput(since: today)))
        XCTAssertFalse(quiet.contains { $0.id == "since" }, "nothing new and nothing recent: no since section")
    }

    func testRecentShowsThreeThenMore() {
        var input = busy()
        input.recent = (1...7).map { item("r\($0)", .done) }
        guard case let .sinceYouLooked(_, _, recent, more) = make(input).first(where: { $0.id == "since" }) else { return XCTFail("since first") }
        XCTAssertEqual(recent.count, 3)
        XCTAssertEqual(more, 4)
        guard case let .sinceYouLooked(_, _, all, none) = make(input, open: ["recent"]).first(where: { $0.id == "since" }) else { return XCTFail() }
        XCTAssertEqual(all.count, 7)
        XCTAssertEqual(none, 0)
        let left = NowScreenModel.recentRow(item("l", .leftUnfinished), locale: locale)
        XCTAssertEqual(left.chip, "STOPPED WITHOUT FINISHING")
        XCTAssertTrue(left.lines[0].hasPrefix("last update "))
    }

    func testPausedQuietAndSettledWorkUseTheSharedCard() {
        var paused = item("p", .paused, status: "Waiting for the review")
        paused.steps = NowItem.Steps(done: 2, total: 12, current: "Inspect the push payload")
        let row = NowScreenModel.pausedRow(paused, locale: locale)
        XCTAssertEqual(row.card?.badge, "Paused")
        XCTAssertEqual(row.card?.ownerState, .paused)
        XCTAssertEqual(row.card?.status, "Waiting for the review")
        XCTAssertEqual(row.card?.caption, "Paused at 2 of 12")
        XCTAssertEqual(row.card?.at, paused.evidenceAt)
        XCTAssertEqual(row.steps, paused.steps)
        XCTAssertEqual(NowScreenModel.quietRow(item("q", .stale), now: serverTime, locale: locale).card?.badge, "Quiet")
        XCTAssertEqual(NowScreenModel.recentRow(item("d", .done), locale: locale).card?.badge, "Done")
        XCTAssertEqual(NowScreenModel.recentRow(item("l", .leftUnfinished), locale: locale).card?.badge, "Left unfinished")
    }

    func testMissedQuestionLeavesTheLateAnswerNoteToTheAnswerPage() {
        let missed = NowScreenModel.needsRow(item("n1", .needsYou, reason: .missedQuestion), locale: locale)
        XCTAssertTrue(missed.chip?.hasPrefix("MISSED") == true)
        XCTAssertEqual(missed.reason, .missedQuestion)
        // The card carries the facts (when it was due, where it ran); the explanation is said once, on the page
        // where the late answer is given.
        XCTAssertNil(missed.footnote)
        XCTAssertEqual(missed.card?.badge, "Missed")
        XCTAssertEqual(NowScreenModel.lateAnswerNote,
                       "Late answers reach the session marked late. An approval here is not permission: the session must ask again.")
        let permission = NowScreenModel.needsRow(item("n2", .needsYou, reason: .permission), locale: locale)
        XCTAssertEqual(permission.chip, "PERMISSION")
        XCTAssertEqual(permission.lines, ["Claude Code is waiting for a permission prompt on your computer."])
        XCTAssertEqual(permission.footnote, "Answer it on your computer.")
    }

    func testWorkWaitingOnItsOwnJobReadsRunning() {
        let waiting = NowScreenModel.runningRow(item("m2", .moving, status: "Waiting on CI"), now: serverTime, isOffline: false)
        XCTAssertNil(waiting.card?.badge, "no Waiting badge: the work is moving, so it reads Running")
        XCTAssertTrue(waiting.lines.contains("Waiting on CI"), "the status says what it waits on")
        XCTAssertTrue(waiting.shimmer)
        let moving = NowScreenModel.runningRow(item("m3", .moving), now: serverTime, isOffline: false)
        XCTAssertTrue(moving.shimmer)
    }

    func testOfflineRenamesRunningToLastKnownWithoutShimmer() {
        guard case let .running(title, rows)? = make(busy(), offline: true).first(where: { $0.id == "running" }) else {
            return XCTFail("running block")
        }
        XCTAssertEqual(title, "Last known")
        XCTAssertTrue(rows.allSatisfy { !$0.shimmer && $0.chip == "Unconfirmed" })
        guard case let .running(online, liveRows)? = make(busy()).first(where: { $0.id == "running" }) else { return XCTFail() }
        XCTAssertEqual(online, "Running")
        XCTAssertTrue(liveRows[0].shimmer, "moving shimmers")
        XCTAssertFalse(liveRows[1].shimmer, "working quietly does not")
        XCTAssertEqual(liveRows[1].tone, .runningQuiet)
        XCTAssertTrue(liveRows[1].lines.contains { $0.hasPrefix("Working quietly · updated") })
    }

    func testTheSameWorkInTwoListsShowsOnce() {
        var input = busy()
        input.running.append(item("w1", .moving))
        let ids = make(input).flatMap { block -> [String] in
            switch block {
            case let .needsYou(rows), let .waitingOnYou(rows), let .running(_, rows), let .fold(_, _, rows, _): rows.map(\.id)
            case let .sinceYouLooked(_, _, rows, _): rows.map(\.id)
            case .sessions: []
            }
        }
        XCTAssertEqual(ids.filter { $0 == "w1" }.count, 1)
    }

    // MARK: Sessions

    private func sessionsBlock(_ sessions: [NowSessionInput], work: [NowItemInput] = []) -> NowSessionsBlock {
        NowScreenModel.sessionsBlock(sessions, work: work, now: serverTime)
    }

    func testSessionsGroupByComputerInServerOrder() {
        let block = sessionsBlock([session("a", computer: "Studio", phase: .working),
                                   session("b", computer: nil, phase: .idle),
                                   session("c", computer: "Studio", phase: .waiting),
                                   session("d", computer: "Laptop", phase: .working)])
        XCTAssertEqual(block.groups.map(\.title), ["Studio", "Unknown computer", "Laptop"])
        XCTAssertEqual(block.groups[0].rows.map(\.id), ["a", "c"])
        XCTAssertEqual(block.working, 2)
    }

    func testIdleFold() {
        let block = sessionsBlock([session("a", computer: "Studio", phase: .working),
                                   session("b", computer: "Studio", phase: .idle, folded: true),
                                   session("c", computer: "Studio", phase: .idle, folded: true)])
        XCTAssertEqual(block.groups[0].rows.map(\.id), ["a"])
        XCTAssertEqual(block.groups[0].idle.map(\.id), ["b", "c"])
    }

    func testSessionChipCopyAndHooksOffLastSeen() {
        let rows = sessionsBlock([session("a", computer: "S", phase: .working),
                                  session("b", computer: "S", phase: .waiting, waitingFor: "input"),
                                  session("c", computer: "S", phase: .waiting, waitingFor: "turn"),
                                  session("d", computer: "S", phase: .idle),
                                  session("e", computer: "S", phase: .ended),
                                  session("f", computer: "S", phase: nil)]).groups[0].rows
        XCTAssertEqual(Array(rows.map(\.chip).prefix(5)), ["Working", "Needs your input", "Your turn", "Idle", "Ended"])
        XCTAssertTrue(rows[5].chip.hasPrefix("Last seen"), rows[5].chip)
    }

    func testSessionLinksToItsWork() {
        let block = sessionsBlock([session("a", computer: "S", phase: .working, workID: "m1")], work: [item("m1", .moving)])
        XCTAssertEqual(block.groups[0].rows[0].workTitle, "Work m1")
        XCTAssertEqual(block.groups[0].rows[0].notificationID, "ntf_m1")
    }

    func testNoAgentWordingInSessions() {
        let rows = sessionsBlock(busy().sessions).groups.flatMap { $0.rows + $0.idle }
        for row in rows { XCTAssertFalse(row.chip.lowercased().contains("agent")) }
    }

    func testSummaryMappingKeepsLiveQuestionsOutAndRenamesSessions() throws {
        let fixture = try XCTUnwrap(Self.fixtureSummary())
        let input = NowScreenInput(summary: fixture)
        XCTAssertTrue(input.needsYou.allSatisfy { $0.reason != .question },
                      "live questions render from the decision feed")
        XCTAssertEqual(input.sessions.count, fixture.sessions.sessions.count)
        XCTAssertEqual(input.running.map(\.id), fixture.running.map(\.id))
    }

    func testSessionNameOpenedOnThePhoneLeadsTheRow() throws {
        var summary = try XCTUnwrap(Self.fixtureSummary())
        let envelope = try ReloWireJSON.decoder().decode(ReloEnvelope.self, from: Data("""
        {"v":"relo.e2e.v1","kind":"names","context":"ses:x","sender":"k_x","recipients":[],"nonce":"n","ct":"c","sig":"s"}
        """.utf8))
        summary.sessions.sessions[0].sealedNames = envelope
        let opened = summary.openingSessionNames { sealed, itemID in
            XCTAssertEqual(sealed.kind, "names")
            XCTAssertEqual(itemID, "ags_00000000-0000-4000-8000-000000000001")
            return Data(#"{"names":{},"title":"Ship the release notes"}"#.utf8)
        }
        XCTAssertEqual(opened.sessions.sessions[0].title, "Ship the release notes")
        let row = try XCTUnwrap(NowScreenInput(summary: opened).sessions.first)
        XCTAssertEqual(row.title, "Ship the release notes")
        XCTAssertEqual(row.context, "Claude Code · relo")

        // Not openable here (no keys, another phone's envelope): the row keeps tool and project.
        let closed = summary.openingSessionNames { _, _ in nil }
        let plain = try XCTUnwrap(NowScreenInput(summary: closed).sessions.first)
        XCTAssertEqual(plain.title, "Claude Code · relo")
        XCTAssertNil(plain.context)
        XCTAssertNil(ReloNames.carriedTitle(in: Data(#"{"title":"line one\nline two"}"#.utf8)))
    }

    /// The contract fixture's summary, when it carries one; else a minimal decoded summary.
    private static func fixtureSummary() -> NowSummary? {
        let json = """
        {"serverTime":"2027-01-15T18:00:00Z",
         "sinceYouLooked":{"since":"2027-01-15T17:00:00Z","finished":1,"failed":0,"waitingOnYou":0,"stoppedWithoutFinishing":0,"needsYou":1},
         "needsYou":[], "recent":[], "waitingOnYou":[], "quiet":[], "paused":[],
         "running":[], "folds":{"waitingOnYou":0,"quiet":0,"paused":0},
         "lockScreen":{"cards":[],"needsYouCount":0,"focus":null},
         "sessions":{"sessions":[{"id":"ags_00000000-0000-4000-8000-000000000001","source":"claude-code","project":"relo",
           "computer":"Studio","phase":"working","observed":true,"waitingFor":null,"lastSeenAt":"2027-01-15T17:59:00Z",
           "fold":null,"workId":null,"sealedNames":null,"nextChangeAt":null}],"folds":{"idle":0}},
         "refreshAt":null}
        """
        return try? ReloWireJSON.decoder().decode(NowSummary.self, from: Data(json.utf8))
    }
}
