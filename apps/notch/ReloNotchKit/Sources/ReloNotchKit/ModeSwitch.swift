import Foundation

/// Moving Relo for Mac between Relo on this Mac and a server of the owner's, in either direction: the words the owner
/// confirms and reads, the server address Relo remembers so switching back is prefilled, and whether the relo command
/// reports to this Mac. Plain words only: no "relo command", "hooks", "profile" or "login item".
public enum ModeSwitch {
    public static let lastServerKey = "relo.lastServerAddress"

    // MARK: The address Relo remembers

    /// Remembers the server this Mac was signed in to, so the way back is prefilled. Loopback addresses are not a
    /// server of the owner's (that is Relo on this Mac), and are never kept.
    public static func remember(server: URL, _ defaults: UserDefaults = .standard) {
        guard !UpdatePolicy.isLoopback(server), server.host != nil else { return }
        defaults.set(server.absoluteString, forKey: lastServerKey)
    }

    public static func lastServer(_ defaults: UserDefaults = .standard) -> URL? {
        defaults.string(forKey: lastServerKey).flatMap(URL.init(string:)).flatMap { $0.host == nil ? nil : $0 }
    }

    /// The address as the server field shows it, or blank.
    public static func lastServerAddress(_ defaults: UserDefaults = .standard) -> String {
        lastServer(defaults).map(ReloNotchStore.displayAddress(of:)) ?? ""
    }

    // MARK: Does the relo command report here?

    /// Whether the relo command is signed in to Relo on this Mac (a loopback server on this Mac's port). A different
    /// port is an older server of ours that moved: the command must be linked again.
    public static func commandReportsHere(_ status: LocalServer.CommandSignIn, localPort: Int?) -> Bool {
        guard status.signedIn, let server = status.server, UpdatePolicy.isLoopback(server) else { return false }
        guard let localPort else { return true }
        return (server.port ?? (server.scheme == "https" ? 443 : 80)) == localPort
    }

    // MARK: Words

    /// Before this Mac stops reporting to `host` and Relo runs here instead.
    public static func tryHereTitle() -> String { "Try Relo on this Mac instead?" }
    public static let tryHereButton = "Try it on this Mac"
    public static func tryHereBody(host: String) -> String {
        "The notch will show the agents on this Mac, and nothing leaves this Mac. Your agents stop reporting to \(host). You can switch back anytime in Settings; Relo remembers \(host)."
    }

    /// Before Relo on this Mac stops for a server of the owner's.
    public static let useServerTitle = "Connect Relo to a server?"
    public static let useServerButton = "Connect to a server"
    public static let useServerBody = "Relo on this Mac stops, and your history stays on this Mac. Next you sign in to your Relo account; after that your agents report to the server. You can go back to Relo on this Mac anytime."

    public static let tryHereRowTitle = "Try Relo on this Mac instead…"
    public static let tryHereRowDetail = "Your agents report here and nothing leaves this Mac. Relo remembers your server address so you can switch back."
    public static let useServerRowTitle = "Use another Relo server…"
    public static let useServerRowDetail = "Relo on this Mac stops and your history stays here. After you sign in, your agents report to the server."

    public static let signingIn = "Waiting for you to sign in to your Relo account…"
    public static let connectingAgents = "Connecting this Mac's agents to your server…"
    public static func connected(host: String) -> String { "Connected to \(host). Your agents report there now." }
    public static let cancelled = "Sign-in did not finish. Relo is not running on this Mac or on a server right now."
    public static let goBack = "Go back to Relo on this Mac"
    public static let agentsNotConnected = "You are signed in, but your agents are not connected yet."
    public static let tryAgain = "Try again"
    public static let restoring = "Starting Relo on this Mac again…"

    /// What the owner reads when a setup that was closed or failed has been undone.
    public static func setupUndone(host: String?) -> String {
        guard let host else { return "Relo was not set up on this Mac. Nothing was changed." }
        return "Relo on this Mac was not set up. You are signed out of \(host); sign in again from Settings (the address is filled in)."
    }
}
