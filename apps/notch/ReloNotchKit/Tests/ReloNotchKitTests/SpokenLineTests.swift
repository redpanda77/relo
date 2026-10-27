import Foundation
import Testing
@testable import ReloNotchKit

/// What the notch says (ADR 0015): "<Kind>: <name>. <gist>", held to the CLI's golden file so both sides agree.
struct SpokenLineTests {
    private func row(_ title: String, tone: NotchPresentation.Tone, status: String? = nil, outcome: String? = nil,
                     step: String? = nil, unreadable: Bool = false) -> NotchPresentation.Row {
        NotchPresentation.Row(
            id: "wrk_1", title: title, status: status, project: nil, source: nil, tone: tone, chip: nil,
            stepsDone: nil, stepsTotal: nil, currentStep: step, startedAt: .now, questionID: nil, notificationID: nil,
            questionPending: false, unreadable: unreadable, computerSymbol: nil,
            declaredAt: .now, roundOutcome: outcome)
    }

    @Test func aQuietCardIsSpokenAsQuietNeverAsWorking() {
        let card = row("Notch redesign", tone: .quiet, step: "Build the list")
        #expect(SpokenLine.text(for: card, quiet: "Session idle since 3:12 PM") == "Quiet: Notch redesign. Session idle since 3:12 PM.")
        #expect(SpokenLine.text(for: card) == "Quiet: Notch redesign.")
        #expect(SpokenLine.text(for: card, kind: false, quiet: "No update since 3:12 PM") == "Notch redesign. No update since 3:12 PM.")
    }

    struct Golden: Decodable {
        var label: String
        var kind: String
        var goal: String
        var name: String?
        var prompt: String?
        var step: String?
        var gist: String?
        var line: String
    }

    private static let goldens: [Golden] = {
        // packages/cli/test/fixtures/spoken-lines.json, from apps/notch/ReloNotchKit/Tests/ReloNotchKitTests.
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../../packages/cli/test/fixtures/spoken-lines.json").standardized
        struct File: Decodable { var cases: [Golden] }
        return (try? JSONDecoder().decode(File.self, from: Data(contentsOf: url)).cases) ?? []
    }()

    private static let tones: [String: NotchPresentation.Tone] = [
        "question": .needsYou, "failed": .failed, "yourTurn": .yourTurn, "finished": .done,
        "working": .working, "paused": .paused, "stopped": .dropped,
    ]

    @Test func theGoldenFileIsRead() {
        #expect(Self.goldens.count >= 15)
    }

    /// The Mac takes the CLI's gist as the card's sealed `spoken` (deliver, finish), or composes it from the prompt
    /// (a question) or the current step (the play button), then frames the line.
    @Test(arguments: goldens.map(\.label)) func golden(_ label: String) throws {
        let golden = try #require(Self.goldens.first { $0.label == label })
        let tone = try #require(Self.tones[golden.kind])
        var card = row(golden.goal, tone: tone, step: golden.step)
        card.spokenName = golden.name
        if ["failed", "yourTurn", "finished"].contains(golden.kind) { card.spoken = golden.gist }
        #expect(SpokenLine.text(for: card, prompt: golden.prompt) == golden.line)
    }

    @Test func everyLineStartsWithAKindWordFitsOneBreathAndCarriesNoInventory() {
        let kinds = ["Needs you", "Failed", "Your turn", "Finished", "Working", "Paused", "Stopped"]
        for golden in Self.goldens {
            let line = golden.line
            #expect(kinds.contains { line.hasPrefix("\($0):") }, "\(line)")
            #expect(line.split(separator: " ").count <= 28 && line.count <= SpokenLine.maxLength, "\(line)")
            #expect(line.range(of: #"\d+\.\d+|\b[0-9a-f]{7,}\b|/|\("#, options: .regularExpression) == nil, "\(line)")
        }
    }

    @Test func withoutASealedGistTheMacSaysTheFrameAloneNeverTheOutcome() {
        let line = SpokenLine.text(for: row("Relo deploy", tone: .done, status: "Shipped server 0.18.99", outcome: "Shipped server 0.18.99"))
        #expect(line == "Finished: Relo deploy.")
        #expect(SpokenLine.text(for: row("Ship it now", tone: .yourTurn, status: "Replaying old cards")) == "Your turn: Ship it now.")
    }

    @Test func aLineFromAnOlderCLIStillGetsItsFrameAndItsCap() {
        var card = row("Relo deploy", tone: .done)
        card.spoken = "Server 0.18.99 is live. " + String(repeating: "All gates passed and more. ", count: 20)
        let line = try? #require(SpokenLine.text(for: card))
        #expect(line?.hasPrefix("Finished: Relo deploy. Server 0.18.99 is live.") == true)
        #expect((line?.count ?? 0) <= SpokenLine.maxLength)
        #expect(line?.hasSuffix(".") == true)
    }

    /// ADR 0015 revision 1: the owner's detail and the card's level meet at the lower of the two.
    @Test func theDetailIsTheLowerOfTheOwnersAndTheCards() {
        var card = row("Relo deploy", tone: .done)
        card.spokenName = "Relo deploy"
        card.spoken = "Server is live and every gate passed."
        #expect(SpokenLine.text(for: card, owner: .verbose) == "Finished: Relo deploy. Server is live and every gate passed.")
        #expect(SpokenLine.text(for: card, owner: .brief) == "Finished: Relo deploy.")
        card.spokenVoice = .brief
        #expect(SpokenLine.text(for: card, owner: .verbose) == "Finished: Relo deploy.")
        card.spokenVoice = .off
        #expect(SpokenLine.text(for: card, owner: .verbose) == nil, "a project set to off is never said, not even by the play button")
    }

    @Test func soundAsTheKindDropsOnlyTheKindWord() {
        var card = row("Relo deploy", tone: .done)
        card.spoken = "Server is live and every gate passed."
        #expect(SpokenLine.text(for: card, kind: false) == "Relo deploy. Server is live and every gate passed.")
        #expect(SpokenLine.text(for: card, owner: .brief, kind: false) == "Relo deploy.")
    }

    @Test func aFinishedStepIsSaidOnlyAtVerbose() {
        var card = row("Redesign the open notch view", tone: .working, step: "Build the list (with motion)")
        card.spokenName = "Notch redesign"
        card.stepsDone = 3
        card.stepsTotal = 5
        // A readable card (Relo on this Mac) names no level: the owner's detail decides.
        #expect(SpokenLine.progress(for: card, owner: .verbose) == "Working: Notch redesign. 3 of 5 done, now build the list.")
        #expect(SpokenLine.progress(for: card, owner: .full) == nil)
        card.spokenVoice = .verbose
        #expect(SpokenLine.progress(for: card, owner: .verbose) == "Working: Notch redesign. 3 of 5 done, now build the list.")
        #expect(SpokenLine.progress(for: card, owner: .full) == nil)
        card.spokenVoice = .full
        #expect(SpokenLine.progress(for: card, owner: .verbose) == nil)
    }

    @Test func aSealedCardThisMacCannotOpenSaysNothing() {
        #expect(SpokenLine.text(for: row("Private work", tone: .done, unreadable: true)) == nil)
    }

    @Test func markdownGlyphsLinksPathsAndIdsAreSaidAsWords() {
        #expect(SpokenLine.clean("**Done** · see `ReloCards.swift`") == "Done, see ReloCards.swift")
        #expect(SpokenLine.clean("Fixed /Users/me/relo/apps/notch/ReloCards.swift and apps/notch/README.md")
                == "Fixed ReloCards.swift and README.md")
        #expect(SpokenLine.clean("Read [the PR](https://github.com/x/y/pull/9) at https://relo.example.com/now") ==
                "Read the PR at relo.example.com")
        #expect(SpokenLine.clean("Closed wrk_66bb4f2f ✓ for now…") == "Closed for now.")
    }

    @Test func versionsHashesAndCodesAreNeverRead() {
        #expect(SpokenLine.strip("Deploy server fea6d51 to production (no migrations)") == "Deploy server to production")
        #expect(SpokenLine.strip("0.17 is on TestFlight, build 289") == "The new version is on TestFlight")
        #expect(SpokenLine.strip("Approve the sign-in, code HB9H-9HKB") == "Approve the sign-in")
    }
}

/// The lines waiting after their cue (ADR 0015): one at a time, two per burst, then a count; stale news dropped.
struct SpokenQueueTests {
    private let start = Date(timeIntervalSince1970: 1_000_000)
    private func line(_ id: String, _ kind: NotchEvent.Kind, at offset: TimeInterval = 0) -> SpokenQueue.Line {
        SpokenQueue.Line(id: id, kind: kind, text: "\(kind.rawValue) \(id)", at: start.addingTimeInterval(offset))
    }

    @Test func threeUpdatesInOneBurstGiveTwoLinesAndACount() {
        var queue = SpokenQueue()
        queue.add([line("a", .finished), line("b", .yourTurn), line("c", .finished)])
        #expect(queue.next(now: start, open: { _ in true })?.text == "yourTurn b")
        #expect(queue.next(now: start, open: { _ in true })?.text == "finished a")
        #expect(queue.next(now: start, open: { _ in true })?.text == "And 1 more update.")
        #expect(queue.next(now: start, open: { _ in true })?.text == nil)
    }

    @Test func questionsComeFirstAndQuestionsAndFailuresEachGetTheirOwnLine() {
        var queue = SpokenQueue()
        queue.add([line("a", .finished), line("b", .finished), line("c", .question), line("d", .failed), line("e", .question)])
        let said = (0..<6).compactMap { _ in queue.next(now: start, open: { _ in true })?.text }
        #expect(said == ["question c", "question e", "failed d", "And 2 more updates."])
    }

    @Test func staleNewsIsDroppedAndAnAnsweredQuestionIsNotSaid() {
        var queue = SpokenQueue()
        queue.add([line("a", .finished), line("b", .question), line("c", .question)])
        let later = start.addingTimeInterval(SpokenQueue.staleAfter + 1)
        #expect(queue.next(now: later, open: { $0.id == "c" })?.text == "question c")
        #expect(queue.next(now: later, open: { _ in true })?.text == nil)
    }

    @Test func aNewerLineForTheSameCardReplacesTheOlderOne() {
        var queue = SpokenQueue()
        queue.add([line("a", .yourTurn)])
        queue.add([SpokenQueue.Line(id: "a", kind: .yourTurn, text: "newer", at: start)])
        #expect(queue.next(now: start, open: { _ in true })?.text == "newer")
        #expect(queue.isEmpty)
    }

    @Test func aBurstEndsWhenTheQueueEmpties() {
        var queue = SpokenQueue()
        queue.add([line("a", .finished), line("b", .finished)])
        _ = queue.next(now: start, open: { _ in true })
        _ = queue.next(now: start, open: { _ in true })
        #expect(queue.next(now: start, open: { _ in true })?.text == nil)
        queue.add([line("c", .finished)])
        #expect(queue.next(now: start, open: { _ in true })?.text == "finished c")
    }
}
