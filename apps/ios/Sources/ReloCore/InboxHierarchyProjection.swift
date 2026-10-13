import Foundation

public struct InboxProjectIdentity: Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let isDirect: Bool
    public let paletteSlot: Int?
    public let paletteGeneration: Int?
    public let icon: String?

    public init(
        id: String,
        name: String,
        isDirect: Bool,
        paletteSlot: Int? = nil,
        paletteGeneration: Int? = nil,
        icon: String? = nil
    ) {
        self.id = id
        self.name = name
        self.isDirect = isDirect
        self.paletteSlot = paletteSlot
        self.paletteGeneration = paletteGeneration
        self.icon = icon
    }

    public var systemImageName: String {
        switch icon {
        case "terminal": "terminal.fill"
        case "webhook": "point.3.connected.trianglepath.dotted"
        case "dashboard": "rectangle.3.group.fill"
        case "code": "chevron.left.forwardslash.chevron.right"
        case "build": "hammer.fill"
        case "success": "checkmark.circle.fill"
        case "warning": "exclamationmark.triangle.fill"
        case "folder", "project": "folder.fill"
        default: isDirect ? "terminal.fill" : "folder.fill"
        }
    }

    public var presentationSymbol: LiveActivityDisplayPresentation.Symbol {
        switch icon {
        case "terminal": .terminal
        case "code": .code
        case "build", "folder", "project": .build
        case "success": .success
        case "warning": .warning
        default: isDirect ? .terminal : .info
        }
    }
}
public struct InboxThreadGroup: Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let isContextual: Bool
    public let items: [InboxItem]

    public init(id: String, name: String, isContextual: Bool, items: [InboxItem]) {
        self.id = id
        self.name = name
        self.isContextual = isContextual
        self.items = items
    }
}

public struct InboxProjectGroup: Equatable, Identifiable, Sendable {
    public let project: InboxProjectIdentity
    public let threads: [InboxThreadGroup]

    public var id: String { project.id }
    public var itemCount: Int { threads.reduce(0) { $0 + $1.items.count } }

    public init(project: InboxProjectIdentity, threads: [InboxThreadGroup]) {
        self.project = project
        self.threads = threads
    }
}

public enum InboxHierarchyProjection {
    public static func context(for item: InboxItem) -> InboxContext? {
        item.activitySummary?.context ?? item.context
    }

    public static func project(for item: InboxItem) -> InboxProjectIdentity {
        if let project = item.resources?.project {
            return InboxProjectIdentity(
                id: project.id,
                name: ReloNames.display(project.name) ?? project.name,
                isDirect: project.isDirect,
                paletteSlot: project.palette.slot,
                paletteGeneration: project.palette.generation,
                icon: project.icon
            )
        }
        let context = context(for: item)
        if let project = normalized(context?.project) {
            return InboxProjectIdentity(id: "project:\(project)", name: project, isDirect: false)
        }

        let kind = normalized(context?.producerKind)?.lowercased()
        let label: String
        switch kind {
        case "cli": label = "Direct CLI"
        case "webhook": label = "Direct webhook"
        case "dashboard": label = "Dashboard"
        case let value?: label = "Direct \(value.replacingOccurrences(of: "_", with: " ").capitalized)"
        case nil:
            if let provider = normalized(context?.providerName) {
                label = "Direct \(provider)"
            } else {
                label = "Direct calls"
            }
        }
        return InboxProjectIdentity(id: "direct:\(kind ?? label.lowercased())", name: label, isDirect: true)
    }

    public static func projectOptions(for items: [InboxItem]) -> [InboxProjectIdentity] {
        var seen = Set<String>()
        return items.compactMap { item in
            let identity = project(for: item)
            return seen.insert(identity.id).inserted ? identity : nil
        }
    }

    public static func matchesProject(_ item: InboxItem, selectedProjectID: String?) -> Bool {
        guard let selectedProjectID else { return true }
        return project(for: item).id == selectedProjectID
    }

    public static func groups(for items: [InboxItem]) -> [InboxProjectGroup] {
        struct ThreadAccumulator {
            let id: String
            let name: String
            let isContextual: Bool
            var items: [InboxItem]
        }
        struct ProjectAccumulator {
            let project: InboxProjectIdentity
            var threadOrder: [String]
            var threads: [String: ThreadAccumulator]
        }

        var projectOrder: [String] = []
        var projects: [String: ProjectAccumulator] = [:]

        for item in items {
            let identity = project(for: item)
            if projects[identity.id] == nil {
                projectOrder.append(identity.id)
                projects[identity.id] = ProjectAccumulator(
                    project: identity,
                    threadOrder: [],
                    threads: [:]
                )
            }

            let context = context(for: item)
            let threadID = normalized(context?.providerThreadId)
                ?? normalized(item.activitySummary?.originThreadId)
                ?? normalized(item.resources?.conversationId)
                ?? normalized(item.activitySummary?.conversationId)
                ?? normalized(context?.threadName).map { "name:\($0)" }
            let threadKey = threadID ?? "direct"

            var project = projects[identity.id]!
            if project.threads[threadKey] == nil {
                project.threadOrder.append(threadKey)
                project.threads[threadKey] = ThreadAccumulator(
                    id: threadKey,
                    name: normalized(context?.threadName) ?? (threadID == nil ? "Direct calls" : "Unnamed thread"),
                    isContextual: threadID != nil,
                    items: []
                )
            }
            project.threads[threadKey]!.items.append(item)
            projects[identity.id] = project
        }

        return projectOrder.compactMap { projectID in
            guard let project = projects[projectID] else { return nil }
            let threads = project.threadOrder.compactMap { threadID -> InboxThreadGroup? in
                guard let thread = project.threads[threadID] else { return nil }
                return InboxThreadGroup(
                    id: "\(projectID):\(thread.id)",
                    name: thread.name,
                    isContextual: thread.isContextual,
                    items: thread.items
                )
            }
            return InboxProjectGroup(project: project.project, threads: threads)
        }
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? nil : normalized
    }
}
