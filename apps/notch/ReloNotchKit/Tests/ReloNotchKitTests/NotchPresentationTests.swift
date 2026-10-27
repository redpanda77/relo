import Foundation
import ReloCore
import Testing
@testable import ReloNotchKit

/// The notch shows the server's derivation: these pin that it reads the shared contract fixture
/// (packages/contracts/fixtures/owner-state-v1.json, mirrored in apps/ios) without deciding anything.
struct NotchPresentationTests {
    private func summary() throws -> NowSummary {
        struct Fixture: Decodable { let nowSummary: NowSummary }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../ios/Tests/ReloCoreTests/Fixtures/owner-state-v1.json").standardizedFileURL
        return try ReloWireJSON.decoder().decode(Fixture.self, from: Data(contentsOf: url)).nowSummary
    }

    @Test func focusIsTheServersLockScreenFocus() throws {
        let presentation = NotchPresentation(summary: try summary())
        #expect(presentation.focus?.id == "act_00000000-0000-4000-8000-000000000001")
        #expect(presentation.focus?.tone == .needsYou)
        #expect(presentation.focus?.title == "Ship the release")
        #expect(presentation.needsYouCount == 1)
    }

    @Test func focusFallsBackToTheFirstLockScreenCardAndOtherwiseStaysEmpty() throws {
        var now = try summary()
        now.lockScreen.focus = nil
        #expect(NotchPresentation(summary: now).focus?.id == now.lockScreen.cards.first)
        now.lockScreen.cards = []
        #expect(NotchPresentation(summary: now).focus == nil)
    }

    @Test func sectionsFollowTheServersNowSectionsAndSkipEmptyOnes() throws {
        let presentation = NotchPresentation(summary: try summary())
        #expect(presentation.sections.map(\.kind) == [.needsYou, .waitingOnYou, .running, .recent, .quiet])
        #expect(presentation.activeCount == 3)
        let running = try #require(presentation.sections.first { $0.kind == .running }?.rows.first)
        #expect(running.progress.map { abs($0 - 1.0 / 3.0) < 0.001 } == true)
        #expect(running.currentStep == "Run local gates")
        #expect(presentation.sections.first { $0.kind == .recent }?.rows.map(\.tone) == [.failed, .done])
    }

    /// The Mac draws the plan as the iPhone's detail does: rounds, nested steps and each step's own state from the
    /// server, never a flat list ticked by a top-level count (that marked a phase's substeps done out of order).
    @Test func theOpenedPlanIsTheIPhonesOutlineOfRoundsAndNestedSteps() throws {
        var now = try summary()
        let id = try #require(now.running.first?.id)
        let wire = """
        {"plan":[{"id":"s1","state":"done","label":"Propose the frame","round":1},
                 {"id":"s2","state":"open","label":"Implement","round":2},
                 {"id":"s3","state":"done","label":"Shared examples","parent":"s2","round":2},
                 {"id":"s4","state":"current","label":"Mac speech queue","parent":"s2","round":2},
                 {"id":"s5","state":"open","label":"Test and ship","round":2}],
         "rounds":[{"n":1,"state":"closed","title":"Propose","outcome":"Draft ADR committed"},{"n":2,"state":"open","title":"Build"}]}
        """
        struct Plan: Decodable { let plan: [InboxCardDigest.PlanStep]; let rounds: [InboxCardDigest.PlanRound] }
        let decoded = try ReloWireJSON.decoder().decode(Plan.self, from: Data(wire.utf8))
        now.running[0].plan = decoded.plan
        now.running[0].rounds = decoded.rounds
        let plans = ReloNotchStore.planOutlines(now, open: { _, _ in nil })
        let row = try #require(NotchPresentation(summary: now, plans: plans).sections.flatMap(\.rows).first { $0.id == id })
        let outline = try #require(row.outline)
        #expect(outline.rounds.map(\.heading) == ["Round 1 · Propose", "Round 2 · Build"])
        #expect(outline.rounds[0].outcome == "Draft ADR committed")
        #expect(outline.startsFolded(outline.rounds[0]))
        guard case let .branch(implement) = outline.items(in: outline.rounds[1]).first else { Issue.record("no step"); return }
        #expect(implement.node.state == .current)
        #expect(implement.opened)
        #expect(implement.count == PlanProgress.Sub(done: 1, total: 2))
        #expect(outline.currentLeaf?.label == "Mac speech queue")
        // A work without a plan has no outline.
        #expect(ReloNotchStore.planOutlines(try summary(), open: { _, _ in nil })[id] == nil)
    }

    @Test func movingWorkWaitingOnItsOwnJobReadsRunning() throws {
        let running = try #require(try summary().running.first)
        #expect(NotchPresentation.tone(running.owner) == .working)
    }

    @Test func theBadgeIsTheIPhonesSymbolColourAndLabelPerTone() {
        // Pinned to apps/ios HistoryServerOutcome.make (plan 12b, U4); the colours and symbols live in
        // boringNotch/components/Relo/ReloNotchTheme.swift, this pins the vocabulary a row can carry.
        let tones: [NotchPresentation.Tone] = [.working, .needsYou, .yourTurn, .paused, .quiet, .done, .failed, .dropped, .leftUnfinished]
        #expect(Set(tones.map(\.rawValue)).count == tones.count)
        #expect(tones.filter(\.isMoving) == [.working])
        #expect(tones.filter(\.isStopped) == [.failed, .dropped, .leftUnfinished])
    }

    @Test func planLineFollowsRuleU2() throws {
        var row = try #require(NotchPresentation(summary: try summary()).sections.first { $0.kind == .running }?.rows.first)
        row.stepsDone = 2; row.stepsTotal = 5; row.currentStep = "Run the gates"
        row.tone = .working
        #expect(row.planLine == "Step 3 of 5 · Run the gates")
        row.tone = .paused
        #expect(row.planLine == "Paused at 2 of 5")
        row.tone = .failed
        #expect(row.planLine == "Stopped at 2 of 5")
        row.tone = .dropped
        #expect(row.planLine == "Stopped at 2 of 5")
        row.tone = .done; row.stepsDone = 5
        #expect(row.planLine == "5 of 5 done")
        row.stepsTotal = 0
        #expect(row.planLine == nil)
    }

    @Test func sealedPlaceholdersReadAsPrivateWorkAndFlagApproval() throws {
        var now = try summary()
        now.running[0].title = ReloSealedCards.titlePlaceholder
        now.running[0].status = ReloSealedCards.statusPlaceholder
        let presentation = NotchPresentation(summary: now)
        let row = try #require(presentation.sections.first { $0.kind == .running }?.rows.first)
        #expect(row.unreadable)
        #expect(row.status == nil)
        #expect(presentation.hasUnreadable)
    }

    @Test func quietAndPausedWorkIsFoldedAfterEverythingThatMoves() throws {
        let presentation = NotchPresentation(summary: try summary())
        #expect(presentation.sections.last?.kind == .quiet)
        #expect(presentation.sections.last?.isFolded == true)
        #expect(!presentation.isQuiet)
        var quietOnly = try summary()
        quietOnly.needsYou = []; quietOnly.waitingOnYou = []; quietOnly.running = []; quietOnly.recent = []
        #expect(NotchPresentation(summary: quietOnly).isQuiet)
    }

    @Test func sinceYouLookedRecapsTheServersCountsInOrderOfWhatMatters() throws {
        let presentation = NotchPresentation(summary: try summary())
        #expect(presentation.sinceYouLooked == "1 needs you · 1 failed · 1 finished · 1 your turn")
        var now = try summary()
        now.sinceYouLooked.finished = 0; now.sinceYouLooked.failed = 0; now.sinceYouLooked.waitingOnYou = 0
        now.sinceYouLooked.needsYou = 0; now.sinceYouLooked.stoppedWithoutFinishing = 0
        #expect(NotchPresentation(summary: now).sinceYouLooked == nil)
    }

    @Test func tallyCountsWhatTheListShowsInOrderOfWhatMatters() throws {
        let presentation = NotchPresentation(summary: try summary())
        let tally = presentation.tally
        #expect(tally.prefix(5).map(\.kind) == [.needsYou, .yourTurn, .running, .failed, .finished])
        #expect(tally.prefix(5).map(\.count) == [1, 1, 1, 1, 1])
        #expect(tally.allSatisfy { $0.count > 0 })
        // Every listed row is counted once.
        #expect(tally.reduce(0) { $0 + $1.count } == presentation.sections.reduce(0) { $0 + $1.rows.count })
        // "Running" is the live cards: a working session never adds to it, with a card or without one.
        var both = presentation
        both.sessions = [.init(id: "s1", title: "A", phase: .working, lastSeenAt: .now, hasCard: true),
                         .init(id: "s2", title: "B", phase: .working, lastSeenAt: .now, hasCard: false)]
        let cards = presentation.sections.first { $0.kind == .running }?.rows.count ?? 0
        #expect(both.tally.first { $0.kind == .running }?.count == cards)
        #expect(both.counts.running == cards && both.counts.sessionsWithoutCards == 1)
        #expect(NotchPresentation.empty.tally.isEmpty)
    }

    @Test func finishedWorkSealedBeforeThisMacIsCountedNotListed() throws {
        var now = try summary()
        now.recent[0].title = ReloSealedCards.unreadableTitle
        let presentation = NotchPresentation(summary: now)
        #expect(presentation.privateEarlier == 1)
        #expect(presentation.sections.first { $0.kind == .recent }?.rows.count == 1)
        now.running[0].title = ReloSealedCards.unreadableTitle
        #expect(NotchPresentation(summary: now).sections.first { $0.kind == .running }?.rows.first?.unreadable == true)
    }

    @Test func machinesGroupLiveSessionsByComputerThenHarness() throws {
        let presentation = NotchPresentation(summary: try summary())
        let sessions = presentation.sessions.filter { $0.phase != .ended }
        // Every session sits in one machine (an unnamed computer is called what the caller says).
        let machines = presentation.machines(unnamedAs: "This Mac")
        #expect(machines.reduce(0) { $0 + $1.harnesses.reduce(0) { $0 + $1.total } } == sessions.count)
        #expect(Set(machines.map(\.name)).count == machines.count)
    }

    @Test func unknownIsNotIdle() throws {
        var presentation = NotchPresentation(summary: try summary())
        presentation.sessions = [
            .init(id: "a", title: "A", source: "claude-code", phase: nil, computer: "Mac", lastSeenAt: .now, hasCard: false),
            .init(id: "b", title: "B", source: "claude-code", phase: .idle, computer: "Mac", lastSeenAt: .now, hasCard: false),
            .init(id: "c", title: "C", source: "codex", phase: nil, computer: "Mac2", lastSeenAt: .now, hasCard: false),
        ]
        let mac = try #require(presentation.machines.first { $0.name == "Mac" })
        let harness = try #require(mac.harnesses.first)
        #expect(harness.idle == 1 && harness.untracked == 1 && harness.total == 2)
        #expect(mac.isIdle == false)
        let only = try #require(presentation.machines.first { $0.name == "Mac2" })
        #expect(only.idle == 0 && only.untracked == 1 && only.isIdle == false)
        presentation.sessions = [presentation.sessions[1]]
        #expect(presentation.machines.first?.isIdle == true)
    }

    @Test func rowsReadTheServersPlanCountAndTheStateItDerives() throws {
        var now = try summary()
        now.running[0].steps = .init(done: 0, total: 9, current: "old label")
        now.running[0].progress = PlanProgress(done: 2, total: 5, current: 3, fill: 0.5, stepLabel: "Run the tests")
        let row = try #require(NotchPresentation(summary: now).sections.first { $0.kind == .running }?.rows.first)
        #expect(row.stepsDone == 2 && row.stepsTotal == 5)
        #expect(row.currentIndex == 3 && row.currentFill == 0.5)
        #expect(row.planLine == "Step 3 of 5 · old label")
        #expect(row.interruptionLevel == now.running[0].owner.interruptionLevel)
        #expect(row.movedAt == now.running[0].owner.evidenceAt)
    }

    /// A question that timed out asks nothing (the server's derivation returns the card to its work): a work that went
    /// on into a new round reads as running with its plan, never "Missed" with a Dismiss the server cannot clear.
    @Test func aMissedQuestionLeavesTheCardToItsWork() throws {
        var now = try summary()
        now.running[0].question = try ReloWireJSON.decoder().decode(NowItem.Question.self, from: Data(
            #"{"id":"int_9","standing":"missed","askedAt":"2026-10-14T09:58:00.000Z"}"#.utf8))
        now.running[0].progress = PlanProgress(done: 3, total: 5, current: 4, fill: 0, stepLabel: "Write the ledgers")
        let row = try #require(NotchPresentation(summary: now).sections.first { $0.kind == .running }?.rows.first)
        #expect(row.tone == .working)
        #expect(row.questionID == nil && !row.questionPending)
        #expect(row.planLine != nil)
    }

    @Test func aDeliveredRoundSaysWhichRoundAndHidesThePlanLine() throws {
        var now = try summary()
        now.waitingOnYou[0].roundOutcome = "Draft committed"
        now.waitingOnYou[0].roundNumber = 2
        let row = try #require(NotchPresentation(summary: now).sections.first { $0.kind == .waitingOnYou }?.rows.first)
        #expect(row.statusLine == "Round 2 delivered: Draft committed")
        #expect(row.planLine == nil)
        now.waitingOnYou[0].roundNumber = nil
        let bare = try #require(NotchPresentation(summary: now).sections.first { $0.kind == .waitingOnYou }?.rows.first)
        #expect(bare.statusLine == "Round delivered: Draft committed")
    }

    @Test func aQuietRowSaysWhyTheServerSaysItIsQuietNotTheAgentsLastWords() throws {
        var now = try summary()
        let since = Date(timeIntervalSince1970: 1_000_000)
        now.quiet[0].owner.quietReason = .sessionIdle
        now.quiet[0].owner.quietSince = since
        var row = try #require(NotchPresentation(summary: now).sections.first { $0.kind == .quiet }?.rows.first)
        #expect(row.tone == .quiet)
        #expect(row.quietLine?.hasPrefix("Session idle since") == true)
        #expect(row.statusLine == row.quietLine && row.statusLine != row.status)
        // The server's absence, when it sends one, is the more exact reason.
        now.quiet[0].owner.absence = Absence(reason: .noUpdate, since: since)
        row = try #require(NotchPresentation(summary: now).sections.first { $0.kind == .quiet }?.rows.first)
        #expect(row.quietLine?.hasPrefix("No update since") == true)
        // Without a reason or an absence the agent's own status stays.
        now.quiet[0].owner.quietReason = nil; now.quiet[0].owner.absence = nil
        row = try #require(NotchPresentation(summary: now).sections.first { $0.kind == .quiet }?.rows.first)
        #expect(row.quietLine == nil && row.statusLine == row.status)
        // Running work never takes a quiet line.
        let running = try #require(NotchPresentation(summary: try summary()).sections.first { $0.kind == .running }?.rows.first)
        #expect(running.quietLine == nil)
    }

    @Test func oneCountingModelServesEverySurface() throws {
        var presentation = NotchPresentation(summary: try summary())
        presentation.sessions = [.init(id: "s2", title: "B", phase: .working, lastSeenAt: .now, hasCard: false)]
        let counts = presentation.counts
        #expect(counts.needsYou == presentation.needsYouCount)
        // The session without a card is not a running card.
        #expect(counts.running == 1 && counts.sessionsWithoutCards == 1)
        #expect(counts.runningText == "1 running" && counts.needsYouText == "1 needs you")
        #expect(presentation.tally.first { $0.kind == .running }?.count == counts.running)
        #expect(counts.isActive)
        #expect(NotchPresentation.empty.counts == NotchPresentation.Counts())
    }

    @Test func lockedRowsHiddenFromTheListAreNeverCounted() throws {
        var now = try summary()
        now.quiet[0].title = ReloSealedCards.unreadableTitle
        now.recent[0].title = ReloSealedCards.unreadableTitle
        let presentation = NotchPresentation(summary: now)
        let before = NotchPresentation(summary: try summary()).counts
        #expect(presentation.counts.quiet == before.quiet - 1)
        #expect(presentation.counts.failed + presentation.counts.finished + presentation.counts.stopped
                == before.failed + before.finished + before.stopped - 1)
    }

    @Test func offlineOnlyFreezesPastTheServersRefreshAt() throws {
        var now = try summary()
        let served = Date(timeIntervalSince1970: 1_000_000)
        now.serverTime = served
        now.refreshAt = served.addingTimeInterval(300)
        let presentation = NotchPresentation(summary: now)
        #expect(presentation.isFrozen(offline: false, lastUpdated: served, now: served.addingTimeInterval(900)) == false)
        #expect(presentation.isFrozen(offline: true, lastUpdated: served, now: served.addingTimeInterval(100)) == false)
        #expect(presentation.isFrozen(offline: true, lastUpdated: served, now: served.addingTimeInterval(301)))
        now.refreshAt = nil
        let open = NotchPresentation(summary: now)
        #expect(open.isFrozen(offline: true, lastUpdated: served, now: served.addingTimeInterval(60)) == false)
        #expect(open.isFrozen(offline: true, lastUpdated: served, now: served.addingTimeInterval(121)))
        let line = NotchPresentation.asOf(served, locale: Locale(identifier: "en_US_POSIX"), timeZone: TimeZone(identifier: "UTC")!)
        #expect(line.hasPrefix("as of "))
    }

    @Test func computersKeepTheServersOrderAndUnnamedOnesAreHiddenOrCalledThisMac() throws {
        var presentation = NotchPresentation.empty
        presentation.sessions = [
            .init(id: "a", title: "A", phase: .working, computer: "Zed", lastSeenAt: .now, hasCard: false),
            .init(id: "b", title: "B", phase: .working, computer: "c-abcdef123456", lastSeenAt: .now, hasCard: false),
            .init(id: "c", title: "C", phase: .idle, computer: nil, lastSeenAt: .now, hasCard: false),
            .init(id: "d", title: "D", phase: .working, computer: "Alpha", lastSeenAt: .now, hasCard: false),
            .init(id: "e", title: "E", phase: .working, computer: "Zed", lastSeenAt: .now, hasCard: false)
        ]
        #expect(presentation.machines.map(\.name) == ["Zed", "Alpha"])
        let local = presentation.machines(unnamedAs: "This Mac")
        #expect(local.map(\.name) == ["Zed", "This Mac", "Alpha"])
        #expect(local[1].sessions.count == 2)
        #expect(NotchPresentation.readableName("c-abcdef123456") == nil)
    }

    @Test func noSummaryIsEmpty() {
        #expect(NotchPresentation(summary: nil) == .empty)
        #expect(NotchPresentation.empty.isEmpty)
    }

    @Test func hardwareModelIsRealAndNeverReadsAsASimulator() {
        let model = MacDevice.hardwareModel()
        #expect(!["arm64", "x86_64", ""].contains(model))
    }
}
