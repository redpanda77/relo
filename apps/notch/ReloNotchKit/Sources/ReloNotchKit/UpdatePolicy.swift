import Foundation

/// Where Relo for Mac looks for updates, and when a waiting update is shown again.
public enum UpdatePolicy {
    /// A local install, or a server on this Mac, hands out no Mac app: they use the public release feed. A remote
    /// server keeps its own feed. Nil (no check) when there is nothing to ask.
    public static func appcastURL(serverOrigin: URL?, releaseOrigin: URL?, localMode: Bool) -> URL? {
        let useRelease = localMode || serverOrigin.map(isLoopback) ?? false
        guard let origin = useRelease ? releaseOrigin : serverOrigin else { return nil }
        return origin.appendingPathComponent("mac/appcast.xml")
    }

    public static func isLoopback(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]" || host.hasSuffix(".localhost")
    }

    /// "Later" hides the reminder for a day.
    public static let snoozeInterval: TimeInterval = 24 * 3600

    public static func snoozedUntil(from now: Date) -> Date { now.addingTimeInterval(snoozeInterval) }

    /// Whether the reminder shows: not while snoozed (a snooze for another version no longer counts).
    public static func isSnoozed(version: String, snoozedVersion: String?, until: Date?, now: Date) -> Bool {
        guard snoozedVersion == version, let until else { return false }
        return now < until
    }

    public enum AgentsRefresh: Sendable { case notApplicable, refreshed, failed }

    /// The line after an update: "Updated to 0.2.32", with what happened to the agents' setup when it ran.
    public static func updatedLine(version: String, agents: AgentsRefresh) -> String {
        let base = "Updated to \(version)"
        switch agents {
        case .notApplicable: return base
        case .refreshed: return base + " · agents refreshed"
        case .failed: return base + " · agents not refreshed: Set up agents again in Settings"
        }
    }

    /// "Version 0.2.32": the one way the app's version reads, never with the build.
    public static func versionText(_ version: String) -> String { "Version \(version)" }
}
