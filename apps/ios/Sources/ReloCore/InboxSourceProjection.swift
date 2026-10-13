import Foundation

public struct InboxSourceIdentity: Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let kind: String

    public var systemImageName: String {
        switch kind {
        case "cli": "terminal.fill"
        case "webhook": "point.3.connected.trianglepath.dotted"
        case "dashboard": "rectangle.3.group.fill"
        case "agent": "sparkles"
        default: "antenna.radiowaves.left.and.right"
        }
    }
}

public struct InboxTopicIdentity: Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
}

public struct InboxSourceGroup: Equatable, Identifiable, Sendable {
    public let source: InboxSourceIdentity
    public let projects: [InboxProjectGroup]
    public var id: String { source.id }
    public var itemCount: Int { projects.reduce(0) { $0 + $1.itemCount } }
}

/// Presentation identities come from resources/context, never from notification copy.
public enum InboxSourceProjection {
    public static let unscopedTopicID = "unscoped"

    public static func source(for item: InboxItem) -> InboxSourceIdentity {
        let context = InboxHierarchyProjection.context(for: item)
        let name = normalized(item.resources?.source.name) ?? normalized(item.sourceName) ?? "Unknown source"
        let kind = normalized(item.resources?.source.kind) ?? normalized(context?.producerKind) ?? "unknown"
        let id = normalized(item.resources?.source.id)
            ?? ["legacy", name, context?.providerName ?? "", context?.computer ?? ""].joined(separator: "\u{0}")
        return InboxSourceIdentity(id: id, name: name, kind: kind)
    }

    public static func topic(for item: InboxItem) -> InboxTopicIdentity? {
        let context = InboxHierarchyProjection.context(for: item)
        let name = normalized(context?.threadName)
        if let id = normalized(item.resources?.conversationId) ?? normalized(item.activitySummary?.conversationId) {
            return InboxTopicIdentity(id: "conversation:\(id)", name: name ?? "Unnamed topic")
        }
        if let id = normalized(context?.providerThreadId) ?? normalized(item.activitySummary?.originThreadId) {
            let key = ["provider", context?.providerName ?? "", id].joined(separator: "\u{0}")
            return InboxTopicIdentity(id: key, name: name ?? "Unnamed topic")
        }
        if let name { return InboxTopicIdentity(id: "name:\(name)", name: name) }
        return nil
    }

    public static func groups(for items: [InboxItem]) -> [InboxSourceGroup] {
        orderedGroups(items, key: { source(for: $0).id }).map { sourceItems in
            let identity = source(for: sourceItems[0])
            let projects = orderedGroups(sourceItems, key: { InboxHierarchyProjection.project(for: $0).id }).map { projectItems in
                let project = InboxHierarchyProjection.project(for: projectItems[0])
                let topics = orderedGroups(projectItems, key: { topic(for: $0)?.id ?? unscopedTopicID }).map { topicItems in
                    let topic = topic(for: topicItems[0])
                    return InboxThreadGroup(
                        id: [identity.id, project.id, topic?.id ?? unscopedTopicID].joined(separator: "\u{0}"),
                        name: topic?.name ?? "No topic",
                        isContextual: topic != nil,
                        items: topicItems
                    )
                }
                return InboxProjectGroup(project: project, threads: topics)
            }
            return InboxSourceGroup(source: identity, projects: projects)
        }
    }

    public static func matches(_ item: InboxItem, sourceID: String?, topicID: String? = nil) -> Bool {
        if let sourceID, source(for: item).id != sourceID { return false }
        if let topicID, (topic(for: item)?.id ?? unscopedTopicID) != topicID { return false }
        return true
    }

    private static func orderedGroups(_ items: [InboxItem], key: (InboxItem) -> String) -> [[InboxItem]] {
        var order: [String] = []
        var groups: [String: [InboxItem]] = [:]
        for item in items {
            let id = key(item)
            if groups[id] == nil { order.append(id); groups[id] = [] }
            groups[id, default: []].append(item)
        }
        return order.compactMap { groups[$0] }
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return clean.isEmpty ? nil : clean
    }
}
