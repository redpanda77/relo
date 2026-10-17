import Foundation

/// Opaque project, topic, task, computer and account names (docs/ENCRYPTION-PROTOCOL.md, E2.5).
/// The CLI sends keyed handles ("p-…", "t-…", "w-…", "c-…", "a-…") to the server and the real names inside sealed envelopes; the phone
/// remembers handle → name and puts the names back wherever server data arrives.
public protocol ReloNameBook: Sendable {
    func names() -> [String: String]
    /// Names carried by an envelope from `sender` (its key id). A handle another sender already named
    /// is never overwritten, so one computer cannot relabel another computer's projects.
    func learn(_ names: [String: String], sender: String)
}

public enum ReloNames {
    /// A handle: one-letter kind, a dash, sixteen lowercase base32 characters.
    nonisolated(unsafe) static let handle = /\b[ptwca]-[a-z2-7]{16}\b/
    public static let capacity = 2_000

    public static func isHandle(_ value: String) -> Bool {
        value.wholeMatch(of: handle) != nil
    }

    /// Keeps only well-formed handles with short, single-line names.
    /// A learned name and the computer (sender key id) that taught it.
    public struct Entry: Codable, Equatable, Sendable {
        public var name: String
        public var sender: String
        public init(name: String, sender: String) { self.name = name; self.sender = sender }
    }

    /// Adds `names` from `sender`: a handle another sender already named keeps its name, so one
    /// computer cannot relabel another computer's projects. The oldest-sorted handles fall out past capacity.
    public static func learning(_ names: [String: String], sender: String, into book: [String: Entry]) -> [String: Entry] {
        var book = book
        for (handle, name) in accepted(names) where book[handle] == nil || book[handle]?.sender == sender {
            book[handle] = Entry(name: name, sender: sender)
        }
        if book.count > capacity {
            for key in book.keys.sorted().prefix(book.count - capacity) { book.removeValue(forKey: key) }
        }
        return book
    }

    public static func accepted(_ names: [String: String]) -> [String: String] {
        names.filter { isHandle($0.key) && !$0.value.isEmpty && $0.value.count <= 160 && !$0.value.contains("\n") }
    }

    /// The `names` a sealed plaintext carries, if any.
    public static func carried(in plaintext: Data) -> [String: String] {
        struct Carrier: Decodable { let names: [String: String]? }
        return accepted((try? JSONDecoder().decode(Carrier.self, from: plaintext))?.names ?? [:])
    }

    /// The session title a sealed names envelope carries (a single line, at most 80 characters), if any.
    public static func carriedTitle(in plaintext: Data) -> String? {
        struct Carrier: Decodable { let title: String? }
        guard let title = (try? JSONDecoder().decode(Carrier.self, from: plaintext))?.title?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !title.isEmpty, title.count <= 80, !title.contains("\n") else { return nil }
        return title
    }

    /// `value` with any handle replaced by the name this phone learned for it. Applied when a row is
    /// shown, so rows stored before their names arrived still show names (E2.5).
    public static func display(_ value: String?) -> String? {
        guard let value, value.contains(handle) else { return value }
        return resolve(value, ReloSealedCards.knownNames())
    }

    public static func resolve(_ text: String, _ names: [String: String]) -> String {
        guard !names.isEmpty, text.contains("-") else { return text }
        return text.replacing(handle) { match in names[String(match.output)] ?? String(match.output) }
    }

    /// Every string in a JSON document with known handles replaced by their names; anything that is
    /// not JSON is returned unchanged.
    public static func resolve(json data: Data, _ names: [String: String]) -> Data {
        guard !names.isEmpty, let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return data
        }
        func walk(_ value: Any) -> Any {
            switch value {
            case let text as String: return resolve(text, names)
            case let array as [Any]: return array.map(walk)
            case let dictionary as [String: Any]: return dictionary.mapValues(walk)
            default: return value
            }
        }
        return (try? JSONSerialization.data(withJSONObject: walk(object), options: [.fragmentsAllowed])) ?? data
    }
}

public extension LiveActivityPresentation {
    /// Real names for the handles in a card's visible text and identity labels.
    func resolvingNames(_ names: [String: String]) -> LiveActivityPresentation {
        guard !names.isEmpty else { return self }
        let text = { (value: String) in ReloNames.resolve(value, names) }
        func token(_ value: IdentityToken?) -> IdentityToken? {
            value.map { IdentityToken(label: text($0.label), color: $0.color, icon: $0.icon, revision: $0.revision, provenance: $0.provenance) }
        }
        let resolvedComponents = components.map { component -> Component in
            switch component {
            case let .steps(id, role, items, window):
                return .steps(id: id, colorRole: role, items: items.map {
                    LiveActivityDisplayPresentation.Step(id: $0.id, label: text($0.label), state: $0.state)
                }, window: window)
            case let .progressBar(id, role, value, label):
                return .progressBar(id: id, colorRole: role, value: value, label: label.map(text))
            case .image:
                return component
            }
        }
        return LiveActivityPresentation(
            header: header.map(text), title: text(title), subtitle: subtitle.map(text), status: text(status),
            components: resolvedComponents, surfaces: surfaces,
            identity: Identity(project: token(identity.project), thread: token(identity.thread), direct: identity.direct),
            state: state, behavior: behavior, appearance: appearance, privacy: privacy
        )
    }
}
