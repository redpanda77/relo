import Foundation
import ReloCore
import Testing
@testable import ReloNotchKit

@Suite @MainActor struct OnboardingStageTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    private func stage(_ phase: OnboardingStage.Phase, done: Int = 2, total: Int = 5, status: String? = nil) -> NotchPresentation {
        .onboarding(OnboardingStage(phase: phase, stepsDone: done, stepsTotal: total, title: "Setting up Relo", status: status),
                    startedAt: start)
    }

    private func summary() throws -> NowSummary {
        struct Fixture: Decodable { let nowSummary: NowSummary }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../ios/Tests/ReloCoreTests/Fixtures/owner-state-v1.json").standardizedFileURL
        return try ReloWireJSON.decoder().decode(Fixture.self, from: Data(contentsOf: url)).nowSummary
    }

    @Test func workingIsARunningRowWithItsPlanBar() throws {
        let p = stage(.working)
        let row = try #require(p.focus)
        #expect(row.id == "onboarding" && row.tone == .working && row.title == "Setting up Relo")
        #expect(p.sections.map(\.kind) == [.running] && p.activeCount == 1 && p.needsYouCount == 0)
        let bar = try #require(row.bar)
        #expect(bar.segments.map(\.state) == [.done, .done, .current, .open, .open])
        #expect(row.spoken == nil && row.questionID == nil && !row.unreadable)
    }

    @Test func yourTurnWaitsOnTheOwner() throws {
        let p = stage(.yourTurn)
        #expect(p.focus?.tone == .yourTurn && p.sections.map(\.kind) == [.waitingOnYou] && p.activeCount == 1)
        #expect(p.focus?.bar?.segments.map(\.state) == [.done, .done, .current, .open, .open])
    }

    @Test func failedIsRecentAndKeepsItsStatus() throws {
        let p = stage(.failed, status: "Setup failed")
        #expect(p.focus?.tone == .failed && p.focus?.status == "Setup failed")
        #expect(p.sections.map(\.kind) == [.recent] && p.activeCount == 0)
        #expect(p.tally.map(\.kind) == [.failed])
    }

    @Test func doneFillsTheBar() throws {
        let p = stage(.done, done: 3)
        #expect(p.focus?.tone == .done && p.focus?.stepsDone == 5 && p.sections.map(\.kind) == [.recent])
        #expect(p.focus?.bar?.segments.allSatisfy { $0.state == .done } == true)
    }

    @Test func transitionsMakeTheRealEvents() {
        let none: NotchPresentation = .empty
        #expect(NotchEvent.between(none, stage(.working, done: 0)).map(\.kind) == [.started])
        #expect(NotchEvent.between(stage(.working, done: 0), stage(.working, done: 1)).isEmpty)
        #expect(NotchEvent.between(stage(.working, done: 1), stage(.yourTurn, done: 1)).map(\.kind) == [.yourTurn])
        #expect(NotchEvent.between(stage(.yourTurn, done: 1), stage(.working, done: 2)).isEmpty)
        #expect(NotchEvent.between(stage(.working), stage(.failed)).map(\.kind) == [.failed])
        #expect(NotchEvent.between(stage(.working), stage(.done, done: 5)).map(\.kind) == [.finished])
    }

    @Test func stagingHoldsBackTheServerAndClearingRestoresIt() throws {
        let store = ReloNotchStore()
        #expect(!store.isStagingOnboarding)
        store.stageOnboarding(stage(.working))
        #expect(store.isStagingOnboarding && store.presentation.focus?.id == "onboarding")
        let now = try summary()
        store.receive(now)
        #expect(store.summary != nil)
        #expect(store.presentation.focus?.id == "onboarding")
        store.stageOnboarding(stage(.yourTurn))
        #expect(store.presentation.focus?.tone == .yourTurn)
        store.stageOnboarding(nil)
        #expect(!store.isStagingOnboarding)
        #expect(store.presentation == NotchPresentation(summary: now))
    }

    @Test func clearingWithoutASummaryIsEmpty() {
        let store = ReloNotchStore()
        store.stageOnboarding(stage(.working))
        store.stageOnboarding(nil)
        #expect(store.presentation == .empty)
    }
}
