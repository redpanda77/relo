import Foundation
import Testing
@testable import ReloCore

@Suite("Native Inbox attention and navigation")
struct InboxAttentionProjectionTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func item(_ id: String = "request", expiry: Double = 60, activityID: String? = nil,
                      sequence: Int = 1, state: String = "active", stale: Double? = nil,
                      withdrawn: Bool = false, pending: Bool = true) -> InboxItem {
        InboxItem(id: id, kind: activityID == nil ? .notification : .liveActivity,
            sourceName: "Agent", title: "Review change", withdrawnAt: withdrawn ? now : nil,
            createdAt: now.addingTimeInterval(Double(sequence)),
            activitySummary: activityID.map { InboxActivitySummary(id: $0, generation: 1,
                sequence: sequence, state: state, title: "Review change", status: "Working",
                staleAt: stale.map { now.addingTimeInterval($0) }) },
            interaction: pending ? InboxInteraction(id: "interaction-\(id)", kind: .approval,
                prompt: "Approve?", state: .pending, expiresAt: now.addingTimeInterval(expiry)) : nil)
    }
    private func project(_ items: [InboxItem], at date: Date? = nil, accepted: Set<String> = [], queued: Set<String> = []) -> InboxAttentionProjection.Snapshot {
        InboxAttentionProjection.make(items: items, now: date ?? now, acceptedNotificationIDs: accepted, queuedNotificationIDs: queued)
    }
    @Test("A question past its deadline stays: the server keeps it as missed") func expiry() {
        let request = item()
        #expect(project([request]).requests.count == 1)
        #expect(project([request]).nextTransitionAt == now.addingTimeInterval(60))
        #expect(project([request], at: now.addingTimeInterval(60)).requests.count == 1) // the server decides missed
        #expect(request.interaction?.state == .pending)
    }
    @Test(arguments: ["ended", "expired", "replaced"])
    func terminal(state: String) {
        let previous = item("old", activityID: "work", sequence: 1)
        let terminal = item("new", activityID: "work", sequence: 2, state: state, pending: false)
        #expect(project([previous, terminal]).requests.isEmpty)
        #expect(project([previous, terminal]).activities.isEmpty)
    }
    @Test func withdrawalAndAcceptance() {
        #expect(project([item(withdrawn: true)]).requests.isEmpty)
        #expect(project([item()], accepted: ["request"]).requests.isEmpty)
    }
    @Test("Stale progress stays visible without implying completion") func staleness() {
        let work = item(activityID: "work", stale: 30, pending: false)
        #expect(project([work]).nextTransitionAt == now.addingTimeInterval(30))
        let after = project([work], at: now.addingTimeInterval(30))
        #expect(after.activities == [work])
        #expect(InboxAttentionProjection.isStale(work, now: now.addingTimeInterval(30)))
        #expect(work.activitySummary?.state == "active")
    }
    @Test("Queued decisions retain their request identity") func queuedIdentity() {
        let queued = item("one")
        let other = item("two")
        let result = project([queued, other], queued: ["one"])
        #expect(result.requests.map(\.id) == ["two"])
        #expect(result.queuedRequests.map(\.interaction?.id) == ["interaction-one"])
    }
    @Test("Supersession does not remove unrelated work") func supersession() {
        let old = item("old", activityID: "work", sequence: 1)
        let newer = item("new", activityID: "work", sequence: 2)
        let other = item("other", activityID: "other-work", sequence: 1)
        #expect(Set(project([old, newer, other]).requests.map(\.id)) == ["new", "other"])
    }
    @Test("Navigation consumes the exact item once and preserves the originating tab") func navigation() {
        var routing = ReloNavigationState()
        routing.transition(to: "account-one")
        routing.open("cold-open")
        #expect(routing.notificationID == "cold-open")
        #expect(routing.detailTab == .now)
        routing.dismiss(); routing.tab = .history; routing.open("history-item")
        #expect(routing.detailTab == .history)
        routing.tab = .settings; routing.open("history-item")
        #expect(routing.detailTab == .history) // repeated selection does not reroute it
        routing.dismiss(); routing.open("push")
        #expect(routing.tab == .now)
        routing.transition(to: "account-two")
        #expect(routing.notificationID == nil)
        #expect(routing.tab == .now)
    }
    @Test("Drafts cannot migrate to a different request or account") func drafts() {
        var drafts = ReplyDraftState()
        drafts.transition(to: "account-one")
        drafts.set("Continue", requestID: "notification|interaction-one")
        drafts.transition(to: "account-one")
        #expect(drafts.text(requestID: "notification|interaction-one") == "Continue")
        #expect(drafts.text(requestID: "notification|interaction-two") == "")
        drafts.transition(to: "account-two")
        #expect(drafts.text(requestID: "notification|interaction-one") == "")
    }
    @Test("Queued and rejected responses never render success") func responseStates() {
        let request = item()
        let queued = NotificationResponseFeedback(phase: .queued, action: .approve)
        let rejected = NotificationResponseFeedback(phase: .rejected, action: .approve)
        #expect(ResponsePresentationState.make(item: request, now: now, feedback: queued, queued: true, submitting: false, eligible: true) == .queued)
        #expect(ResponsePresentationState.make(item: request, now: now, feedback: rejected, queued: false, submitting: false, eligible: true).allowsSubmission)
        #expect(!ResponsePresentationState.make(item: request, now: now, feedback: nil, queued: false, submitting: true, eligible: true).allowsSubmission)
        #expect(ResponsePresentationState.make(item: request, now: now.addingTimeInterval(60), feedback: nil, queued: false, submitting: false, eligible: true) == .expired)
    }
    @Test("History applies combined predicates only to the loaded window") func search() {
        let one = InboxItem(id: "one", kind: .notification, sourceName: "Agent", title: "Build passed", createdAt: now,
                            context: InboxContext(project: "Relo"))
        let two = InboxItem(id: "two", kind: .response, sourceName: "Agent", title: "Build approved", createdAt: now,
                            context: InboxContext(project: "Relo"))
        let projectID = InboxHierarchyProjection.project(for: one).id
        #expect(ReloHistoryResults.make(items: [one, two], query: "build", kind: .notifications, projectID: projectID) == [one])
        #expect(ReloHistoryResults.make(items: [one, two], query: "absent", kind: .all, projectID: nil).isEmpty)
        let ask = InboxItem(id: "ask", kind: .notification, sourceName: "Agent", title: "Ship?", createdAt: now,
                            interaction: InboxInteraction(id: "int_1", kind: .approval, prompt: "Ship?", state: .pending,
                                                          expiresAt: now + 600))
        #expect(ReloHistoryResults.make(items: [one, ask], query: "", kind: .decisions, projectID: nil) == [ask])
        #expect(ReloHistoryResults.make(items: [one, ask], query: "", kind: .notifications, projectID: nil) == [one])
    }
    @Test("Detail and Inbox copies cannot duplicate or resurrect attention") func duplicateEvent() {
        let pending = item()
        let withdrawn = item(withdrawn: true)
        #expect(project([pending, pending]).requests.count == 1)
        #expect(project([withdrawn, pending]).requests.isEmpty)
        #expect(project([pending, withdrawn]).requests.isEmpty)
    }

    @Test("A new generation wins when its sequence restarts") func generation() {
        let old = item("old", activityID: "work", sequence: 100)
        let newer = InboxItem(id: "new", kind: .liveActivity, sourceName: "Agent", title: "New work", createdAt: now,
            activitySummary: .init(id: "work", generation: 2, sequence: 1, state: "active", title: "New work", status: "Working"))
        #expect(project([old, newer]).requests.isEmpty)
        #expect(project([old, newer]).activities.map(\.id) == ["new"])
    }

    private func notification(_ id: String, age: Double, read: Bool = false,
                              withdrawn: Bool = false) -> InboxItem {
        InboxItem(id: id, kind: .notification, sourceName: "Agent", title: id,
            readAt: read ? now : nil, withdrawnAt: withdrawn ? now : nil,
            createdAt: now.addingTimeInterval(-age))
    }




}
