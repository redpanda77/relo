import Testing
import XCTest
@testable import ReloCore

final class InboxHierarchyProjectionTests: XCTestCase {
    func testClassifiesContextualAndDirectProjectsTruthfully() {
        let contextual = item(
            id: "project",
            context: InboxContext(project: "Relo", threadName: "UI maturity")
        )
        let directCLI = item(
            id: "cli",
            context: InboxContext(producerKind: "cli")
        )
        let directUnknown = item(id: "direct", context: nil)

        XCTAssertEqual(
            InboxHierarchyProjection.project(for: contextual),
            InboxProjectIdentity(id: "project:Relo", name: "Relo", isDirect: false)
        )
        XCTAssertEqual(InboxHierarchyProjection.project(for: directCLI).name, "Direct CLI")
        XCTAssertEqual(InboxHierarchyProjection.project(for: directUnknown).name, "Direct calls")
    }

    func testGroupsByProjectAndThreadWithoutInventingUnthreadedContext() throws {
        let contextual = item(
            id: "threaded",
            context: InboxContext(
                project: "Relo",
                providerThreadId: "thread-1",
                threadName: "UI maturity"
            )
        )
        let direct = item(id: "direct", context: InboxContext(producerKind: "webhook"))

        let groups = InboxHierarchyProjection.groups(for: [contextual, direct])

        XCTAssertEqual(groups.count, 2)
        let project = try XCTUnwrap(groups.first(where: { $0.project.name == "Relo" }))
        XCTAssertEqual(project.threads.first?.name, "UI maturity")
        XCTAssertEqual(project.threads.first?.isContextual, true)

        let directGroup = try XCTUnwrap(groups.first(where: { $0.project.name == "Direct webhook" }))
        XCTAssertEqual(directGroup.threads.first?.name, "Direct calls")
        XCTAssertEqual(directGroup.threads.first?.isContextual, false)
    }

    func testProjectFilterUsesCanonicalIdentity() {
        let project = item(id: "project", context: InboxContext(project: "Relo"))
        let direct = item(id: "direct", context: InboxContext(producerKind: "cli"))

        XCTAssertTrue(
            InboxHierarchyProjection.matchesProject(project, selectedProjectID: "project:Relo")
        )
        XCTAssertFalse(
            InboxHierarchyProjection.matchesProject(direct, selectedProjectID: "project:Relo")
        )
        XCTAssertTrue(InboxHierarchyProjection.matchesProject(direct, selectedProjectID: nil))
    }

    func testNormalizedResourcesOverrideLegacyLabelsAndSupplyStablePalette() throws {
        let resources = InboxResourceLinks(
            source: InboxResourceSource(id: "src_1", kind: "agent", name: "Codex"),
            project: InboxResourceProject(
                id: "prj_stable",
                name: "Relo notifications",
                isDirect: false,
                palette: .init(slot: 7, generation: 2),
                icon: "folder",
                revision: 1
            ),
            conversationId: "cnv_stable"
        )
        let resourceItem = item(
            id: "normalized",
            context: InboxContext(project: "Old project"),
            resources: resources
        )

        let project = InboxHierarchyProjection.project(for: resourceItem)
        XCTAssertEqual(project.id, "prj_stable")
        XCTAssertEqual(project.name, "Relo notifications")
        XCTAssertEqual(project.paletteSlot, 7)
        XCTAssertEqual(project.paletteGeneration, 2)
        XCTAssertEqual(project.icon, "folder")
        XCTAssertEqual(project.systemImageName, "folder.fill")
        XCTAssertEqual(try XCTUnwrap(InboxHierarchyProjection.groups(for: [resourceItem]).first).threads.first?.isContextual, true)
    }

    func testProjectIconsMapOnlyToKnownSystemImages() {
        let project = { (icon: String) in
            InboxProjectIdentity(id: "project", name: "Project", isDirect: false, icon: icon)
        }
        XCTAssertEqual(project("terminal").systemImageName, "terminal.fill")
        XCTAssertEqual(project("webhook").systemImageName, "point.3.connected.trianglepath.dotted")
        XCTAssertEqual(project("code").systemImageName, "chevron.left.forwardslash.chevron.right")
        XCTAssertEqual(project("unknown").systemImageName, "folder.fill")
    }

    private func item(
        id: String,
        context: InboxContext?,
        resources: InboxResourceLinks? = nil
    ) -> InboxItem {
        InboxItem(
            id: id,
            kind: .notification,
            sourceName: "Notification service",
            title: id,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            context: context,
            resources: resources
        )
    }
}

/// A project keeps one colour on every surface: the server's slot first, else the Dashboard's name hash.
@Suite("Project palette")
struct ProjectPaletteTests {
    @Test("Twelve colours, the contracts' table; the server's slot picks one, wrapped into range")
    func slots() {
        #expect(ProjectPalette.hex.count == 12)
        #expect(ProjectPalette.hex.first == 0x5CE1FF && ProjectPalette.hex.last == 0xFDE047)
        #expect(ProjectPalette.slot(3, name: "relo") == 3)
        #expect(ProjectPalette.slot(14, name: nil) == 2)
    }

    @Test("Without a slot the name hashes as the Dashboard's hashSlot does; nothing without a name")
    func nameHash() {
        // Values from the Dashboard's `hashSlot` (apps/dashboard/src/features/inbox/activity-model.ts).
        #expect(ProjectPalette.slot(nil, name: "relo") == 2)
        #expect(ProjectPalette.slot(nil, name: "HSKHarness") == 0)
        #expect(ProjectPalette.slot(nil, name: "Écrire") == 4)
        #expect(ProjectPalette.slot(nil, name: nil) == nil)
        #expect(ProjectPalette.slot(nil, name: "") == nil)
    }
}
