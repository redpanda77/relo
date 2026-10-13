import Foundation

/// Tap destinations mirror the server policy: HTTPS web or universal links, an app's own
/// scheme (`your-app://…`), or `shortcuts://`. Schemes that run code or read local state never open.
public enum NotificationDestinationPolicy {
    static let blockedSchemes: Set<String> = [
        "http", "javascript", "vbscript", "data", "file", "blob", "about", "filesystem", "content",
    ]

    public static func validatedURL(_ url: URL) -> URL? {
        guard
            let scheme = url.scheme?.lowercased(),
            scheme.range(of: "^[a-z][a-z0-9+.-]{0,31}$", options: .regularExpression) != nil,
            !blockedSchemes.contains(scheme),
            url.user == nil,
            url.password == nil,
            url.absoluteString.count <= 2_048
        else { return nil }
        if scheme == "https" {
            guard let host = url.host, !host.isEmpty else { return nil }
        } else if url.absoluteString.count <= scheme.count + 1 {
            return nil
        }
        return url
    }

    public static func validatedURL(_ value: String) -> URL? {
        URL(string: value).flatMap(validatedURL)
    }

    /// Whether the destination is a web page (shown by host) rather than an app or Shortcut.
    public static func isWebLink(_ url: URL) -> Bool { url.scheme?.lowercased() == "https" }
}
