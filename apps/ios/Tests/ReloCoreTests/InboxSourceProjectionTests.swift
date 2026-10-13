import XCTest
@testable import ReloCore

final class InboxSourceProjectionTests: XCTestCase {
    func testCanonicalSourcesWithSameNameStaySeparate() {
        let a = item("a", sourceID: "source-a", projectID: "project", conversationID: "topic")
        let b = item("b", sourceID: "source-b", projectID: "project", conversationID: "topic")
        let groups = InboxSourceProjection.groups(for: [a, b])
        XCTAssertEqual(groups.map(\.source.id), ["source-a", "source-b"])
        XCTAssertEqual(groups.map { $0.projects.first?.itemCount }, [1, 1])
    }

    func testCanonicalProjectAndTopicIDsWinOverLegacyLabelsAndThreads() throws {
        let a = item("a", sourceID: "source", projectID: "project-a", conversationID: "topic-a",
                     context: .init(project: "Old project", providerThreadId: "legacy", threadName: "Release"))
        let b = item("b", sourceID: "source", projectID: "project-a", conversationID: "topic-b",
                     context: .init(project: "Old project", providerThreadId: "legacy", threadName: "Release"))
        let c = item("c", sourceID: "source", projectID: "project-b", conversationID: "topic-a")
        let projects = try XCTUnwrap(InboxSourceProjection.groups(for: [a,b,c]).first).projects
        XCTAssertEqual(projects.map(\.project.id), ["project-a", "project-b"])
        XCTAssertEqual(projects.first?.project.name, "Current project")
        XCTAssertEqual(projects.first?.threads.count, 2)
        XCTAssertEqual(InboxSourceProjection.topic(for: a)?.id, "conversation:topic-a")
        XCTAssertEqual(InboxSourceProjection.topic(for: b)?.id, "conversation:topic-b")
        XCTAssertEqual(InboxSourceProjection.source(for: a).name, "Codex")
    }

    func testNoContextDoesNotInventProjectOrTopic() throws {
        let direct = InboxItem(id: "direct", kind: .notification, sourceName: "Backup service",
                               title: "A title that looks like a project", createdAt: .distantPast)
        XCTAssertNil(InboxSourceProjection.topic(for: direct))
        XCTAssertTrue(InboxHierarchyProjection.project(for: direct).isDirect)
        let topic = try XCTUnwrap(InboxSourceProjection.groups(for: [direct]).first?.projects.first?.threads.first)
        XCTAssertEqual(topic.name, "No topic")
        XCTAssertFalse(topic.isContextual)
    }

    func testLegacyOriginsUseProviderAndComputerToAvoidNameCollisions() {
        let a = legacy("a", provider: "Codex", computer: "Mac")
        let b = legacy("b", provider: "Codex", computer: "Server")
        let c = legacy("c", provider: "Other agent", computer: "Mac")
        XCTAssertEqual(InboxSourceProjection.groups(for: [a,b,c]).count, 3)
    }

    func testActivitySummaryContextDefinesCurrentTopic() {
        let value = InboxItem(id: "activity", kind: .liveActivity, sourceName: "Codex", title: "Build",
            createdAt: .distantPast,
            activitySummary: .init(id: "activity", conversationId: "current", generation: 1, sequence: 1,
                state: "active", title: "Build", status: "Running",
                context: .init(threadName: "Current topic")),
            context: .init(providerThreadId: "old", threadName: "Old topic"))
        XCTAssertEqual(InboxSourceProjection.topic(for: value)?.id, "conversation:current")
        XCTAssertEqual(InboxSourceProjection.topic(for: value)?.name, "Current topic")
    }

    func testGroupsKeepFirstSeenOrderAndEveryEventExactlyOnce() {
        let a = item("a", sourceID: "b", projectID: "b", conversationID: "b")
        let b = item("b", sourceID: "a", projectID: "a", conversationID: "a")
        let c = item("c", sourceID: "b", projectID: "b", conversationID: "b")
        let groups = InboxSourceProjection.groups(for: [a,b,c])
        XCTAssertEqual(groups.map(\.source.id), ["b","a"])
        XCTAssertEqual(groups.first?.projects.first?.threads.first?.items.map(\.id), ["a","c"])
        XCTAssertEqual(groups.flatMap(\.projects).flatMap(\.threads).flatMap(\.items).count, 3)
    }

    private func item(_ id: String, sourceID: String, projectID: String, conversationID: String,
                      context: InboxContext = .init(threadName: "Release")) -> InboxItem {
        InboxItem(id: id, kind: .notification, sourceName: "Legacy sender", title: id, createdAt: .distantPast,
            context: context,
            resources: .init(source: .init(id: sourceID, kind: "cli", name: "Codex"),
                project: .init(id: projectID, name: "Current project", isDirect: false,
                               palette: .init(slot: 2, generation: 1), icon: "code", revision: 1),
                conversationId: conversationID))
    }

    private func legacy(_ id: String, provider: String, computer: String) -> InboxItem {
        InboxItem(id: id, kind: .notification, sourceName: "Automation", title: id, createdAt: .distantPast,
                  context: .init(providerName: provider, computer: computer))
    }
}
