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

}
