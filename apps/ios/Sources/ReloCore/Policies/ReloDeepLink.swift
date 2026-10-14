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

    /// `relo://security/request/<id>`: one phone (`dev_…`) or computer (`key_…`) waiting for approval.
    public static func accessRequestURL(id: String) -> URL? {
        guard isAccessRequestID(id) else { return nil }
        return URL(string: "relo://security/request/\(id)")
    }

    public static func accessRequestID(from url: URL) -> String? {
        guard url.scheme?.lowercased() == "relo", url.host?.lowercased() == "security",
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 2, parts[0].lowercased() == "request", isAccessRequestID(parts[1]) else { return nil }
        return parts[1]
    }

    /// A notification's `relo.deepLink` (or `relo.destination`) naming one access request.
    public static func accessRequestID(relo: [String: Any]) -> String? {
        for key in ["deepLink", "destination"] {
            if let id = (relo[key] as? String).flatMap({ URL(string: $0) }).flatMap(accessRequestID(from:)) { return id }
        }
        return nil
    }

    static func isAccessRequestID(_ id: String) -> Bool {
        id.range(of: #"^(dev|key)_[A-Za-z0-9-]{8,64}$"#, options: .regularExpression) != nil
    }
}
