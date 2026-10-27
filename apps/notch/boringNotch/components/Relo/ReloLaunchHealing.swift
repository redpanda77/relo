import Foundation
import Observation
import ReloNotchKit

/// What Relo for Mac repairs by itself at every launch, in the background, in both modes (audit 2026-10-26,
/// "Self-healing on every new version"). It runs the app's bundled relo command with the owner's shell environment
/// (LocalServer.run) and writes only what is the app's own: Relo's launcher, never another relo command.
///
///  - Local mode: the relo command is checked to report to this Mac (re-linked quietly when it does not), and
///    `relo doctor` is read for advice about several relo commands, shown in Settings > Agents (`relosWarning`).
///  - Server mode: when `~/.local/bin/relo` is Relo for Mac's launcher and the app is a new version, the agents'
///    setup is refreshed (`setup --refresh`) and the version is saved only after it worked. Another relo there, or
///    none, is left exactly as it is, and nothing is written.
@MainActor @Observable
final class ReloLaunchHealing {
    static let shared = ReloLaunchHealing()

    /// `relo doctor`'s advice about several relo commands, for Settings > Agents; nil when there is none.
    private(set) var relosWarning: LocalServer.RelosWarning?

    static let serverVersionKey = "relo.serverMode.lastRefreshedRelease"

    private var running = false

    /// Runs the launch checks of whichever mode the app is in; never blocks the main actor, never throws.
    @MainActor static func onLaunch() {
        let healing = shared
        guard !healing.running else { return }
        let service = ReloServerService.shared
        guard service.isBundled else { return }
        healing.running = true
        let server = service.server
        let local = ReloLocalMode.isOn
        Task { @MainActor in
            defer { healing.running = false }
            if local {
                // The command reports to this Mac (re-linked quietly after `relo auth switch`).
                await ReloLocalMode.checkCommandReportsHere()
            } else {
                await healServerMode(server)
            }
            healing.relosWarning = await server.relosWarning()
        }
    }

    /// Server mode: the app's own launcher runs `setup --refresh` once per new app version; saved only on success.
    @MainActor private static func healServerMode(_ server: LocalServer) async {
        server.refreshLauncherIfMoved() // only ever a launcher the app wrote
        guard server.launcherIsApps() else { return }
        let defaults = UserDefaults.standard
        let last = defaults.string(forKey: serverVersionKey)
        guard last != server.appRelease else { return }
        // A first launch has nothing older to catch up with: remember the version and leave the agents alone.
        guard last != nil else { defaults.set(server.appRelease, forKey: serverVersionKey); return }
        do {
            try await server.refreshAgents(timeout: 60)
            defaults.set(server.appRelease, forKey: serverVersionKey)
        } catch { /* tried again at the next launch */ }
    }
}
