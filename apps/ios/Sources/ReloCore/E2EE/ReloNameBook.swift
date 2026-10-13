import Foundation

/// Opaque project, topic, task, computer and account names (docs/END-TO-END-ENCRYPTION.md, E2.5).
/// The CLI sends keyed handles ("p-…", "t-…", "w-…", "c-…", "a-…") to the server and the real names inside sealed envelopes; the phone
/// remembers handle → name and puts the names back wherever server data arrives.
public protocol ReloNameBook: Sendable {
    func names() -> [String: String]
    func learn(_ names: [String: String])
}

public enum ReloNames {
    /// A handle: one-letter kind, a dash, sixteen lowercase base32 characters.
    nonisolated(unsafe) static let handle = /\b[ptwca]-[a-z2-7]{16}\b/
    public static let capacity = 2_000

    public static func isHandle(_ value: String) -> Bool {
        value.wholeMatch(of: handle) != nil
    }

    /// Keeps only well-formed handles with short, single-line names.
    public static func accepted(_ names: [String: String]) -> [String: String] {
        names.filter { isHandle($0.key) && !$0.value.isEmpty && $0.value.count <= 160 && !$0.value.contains("\n") }
    }

    /// The `names` a sealed plaintext carries, if any.
    public static func carried(in plaintext: Data) -> [String: String] {
        struct Carrier: Decodable { let names: [String: String]? }
        return accepted((try? JSONDecoder().decode(Carrier.self, from: plaintext))?.names ?? [:])
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
            case let .steps(id, role, items):
                return .steps(id: id, colorRole: role, items: items.map {
                    LiveActivityDisplayPresentation.Step(id: $0.id, label: text($0.label), state: $0.state)
                })
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
