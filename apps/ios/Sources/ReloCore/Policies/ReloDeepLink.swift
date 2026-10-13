import Foundation

public enum ReloDeepLink {
    public static func activityURL(identity: LiveActivityIdentity) -> URL? {
        guard identity.isValid else { return nil }
        var components = URLComponents()
        components.scheme = "relo"
        components.host = "activity"
        components.path = "/\(identity.activityID)"
        components.queryItems = [URLQueryItem(name: "generation", value: String(identity.generation))]
        return components.url
    }

    public static func activityIdentity(from url: URL) -> LiveActivityIdentity? {
        guard
            url.scheme?.lowercased() == "relo",
            url.host?.lowercased() == "activity",
            url.user == nil,
            url.password == nil,
            url.fragment == nil,
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let queryItems = components.queryItems,
            queryItems.count == 1,
            queryItems[0].name == "generation",
            let generationValue = queryItems[0].value,
            let generation = Int(generationValue),
            generation > 0
        else { return nil }
        let pathComponents = url.pathComponents.filter { $0 != "/" }
        guard
            pathComponents.count == 1,
            let activityID = pathComponents.first
        else { return nil }
        let identity = LiveActivityIdentity(activityID: activityID, generation: generation)
        return identity.isValid ? identity : nil
    }

    /// Settings → Security, where a new device waiting for access is approved.
    public static let securitySettingsURL = URL(string: "relo://settings/security")!

    /// `relo://settings/security` (a trailing slash allowed; nothing else).
    public static func isSecuritySettings(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "relo", url.host?.lowercased() == "settings",
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return false }
        return url.pathComponents.filter { $0 != "/" }.map { $0.lowercased() } == ["security"]
    }

    /// A notification's `relo.destination` or `relo.deepLink` naming Settings → Security.
    public static func opensSecuritySettings(relo: [String: Any]) -> Bool {
        ["destination", "deepLink"].contains { key in
            (relo[key] as? String).flatMap { URL(string: $0) }.map(isSecuritySettings) ?? false
        }
    }
}
