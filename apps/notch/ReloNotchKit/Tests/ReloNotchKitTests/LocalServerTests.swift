import Foundation
import Testing
@testable import ReloNotchKit

@Suite struct LocalServerTests {
    @Test func readsThePortFromTheConfig() {
        #expect(LocalServer.port(fromConfig: Data(#"{"port": 8187, "handle": "owner"}"#.utf8)) == 8187)
        #expect(LocalServer.port(fromConfig: Data(#"{"port": 0}"#.utf8)) == nil)
        #expect(LocalServer.port(fromConfig: Data("nope".utf8)) == nil)
    }

    @Test func readsHealth() {
        let health = LocalServer.health(fromResponse: Data(#"{"status":"ok","release":"0.4+12","instance":"abc"}"#.utf8))
        #expect(health?.release == "0.4+12")
        #expect(health?.instance == "abc")
        #expect(LocalServer.health(fromResponse: Data(#"{"status":"starting"}"#.utf8)) == nil)
    }

    @Test func aServerIsOursOnlyWhenTheInstanceMatches() {
        let health = LocalServer.Health(release: "1+1", instance: "abc")
        #expect(LocalServer.isOurs(health: health, configInstance: "abc"))
        #expect(!LocalServer.isOurs(health: health, configInstance: "other"))
        #expect(!LocalServer.isOurs(health: health, configInstance: nil))
        #expect(!LocalServer.isOurs(health: LocalServer.Health(release: "1+1", instance: ""), configInstance: ""))
        #expect(LocalServer.instance(fromConfig: Data(#"{"port":8187,"instance":"abc"}"#.utf8)) == "abc")
        #expect(LocalServer.instance(fromConfig: Data(#"{"port":8187}"#.utf8)) == nil)
    }

    @Test func readsTheProcessesThatMustEndBeforeTheDataGoes() {
        #expect(LocalServer.pid(fromSupervisorJSON: Data(#"{"pid":4242,"port":8187}"#.utf8)) == 4242)
        #expect(LocalServer.pid(fromSupervisorJSON: Data("nope".utf8)) == nil)
        #expect(LocalServer.pid(fromPostmasterFile: "5151\n/data/db\n1700000000\n") == 5151)
        #expect(LocalServer.pid(fromPostmasterFile: "") == nil)
    }

    @Test func localSetupNeedsApplicationsAndAppleSilicon() {
        let home = URL(fileURLWithPath: "/Users/a")
        func problem(_ path: String, silicon: Bool = true) -> String? {
            LocalServer.setupProblem(appURL: URL(fileURLWithPath: path), home: home, appleSilicon: silicon)
        }
        #expect(problem("/Applications/Relo.app") == nil)
        #expect(problem("/Users/a/Applications/Relo.app") == nil)
        let move = "Move Relo to your Applications folder, then open it again."
        #expect(problem("/Volumes/Relo/Relo.app") == move)
        #expect(problem("/Users/a/Downloads/Relo.app") == move)
        #expect(problem("/private/var/folders/x/AppTranslocation/ABC/d/Relo.app") == move)
        #expect(problem("/Applications/Relo.app", silicon: false) == "Relo for Mac needs a Mac with Apple silicon.")
    }

    @Test func readsTheInviteLine() {
        let line = #"{"code":"rci_abc","expiresAt":"2026-10-23T10:15:30.500Z","apiUrl":"http://127.0.0.1:8187","macApp":true}"#
        let invite = LocalServer.parseInvite("noise\n\(line)\n")
        #expect(invite?.code == "rci_abc")
        #expect(invite?.expiresAt == ISO8601DateFormatter().date(from: "2026-10-23T10:15:30Z")?.addingTimeInterval(0.5))
        #expect(LocalServer.parseISO8601("2026-10-23T10:15:30Z") != nil)
        #expect(invite?.apiURL.absoluteString == "http://127.0.0.1:8187")
        #expect(LocalServer.parseInvite(#"{"code":"rci_x","apiUrl":"https://example.com"}"#) == nil)
        #expect(LocalServer.parseInvite("") == nil)
    }

    @Test func pkceChallengeIsTheS256OfTheVerifier() {
        // RFC 7636 appendix B: this verifier gives this challenge.
        let known = LocalServer.pkce(verifierBytes: [116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186,
                                                    22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121])
        #expect(known.verifier == "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        #expect(known.challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        let fresh = LocalServer.pkce()
        #expect(fresh.verifier.count == 43)
        #expect(fresh.challenge.count == 43)
    }

    @Test func theLauncherNamesTheBundledNodeAndCLI() {
        let script = LocalServer.launcherScript(node: "/A/Relo.app/Contents/Resources/server/node",
                                                cli: "/A/Relo.app/Contents/Resources/server/cli/bin/relo.mjs")
        #expect(script.hasPrefix("#!/bin/sh\n"))
        #expect(script.contains(#"exec "/A/Relo.app/Contents/Resources/server/node" "/A/Relo.app/Contents/Resources/server/cli/bin/relo.mjs" "$@""#))
    }

    @Test func writesTheLauncherOverAnOlderFile() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("relo-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let server = LocalServer(resources: home.appendingPathComponent("Resources"), bundleIdentifier: "ai.relo.test", appRelease: "1+1", home: home)
        try FileManager.default.createDirectory(at: server.launcherURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try (LocalServer.launcherMarker + "\nold\n").write(to: server.launcherURL, atomically: true, encoding: .utf8)
        #expect(try server.installLauncher() == .written)
        let text = try String(contentsOf: server.launcherURL, encoding: .utf8)
        #expect(text.contains("exec "))
        let mode = try FileManager.default.attributesOfItem(atPath: server.launcherURL.path)[.posixPermissions] as? Int
        #expect(mode == 0o755)
        #expect(server.isBundled == false)
    }

    @Test func anOlderReloCommandIsReplacedAndKept() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("relo-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let server = LocalServer(resources: home.appendingPathComponent("Resources"), bundleIdentifier: "ai.relo.test", appRelease: "1+1", home: home)
        let fm = FileManager.default
        func package(_ folder: URL, _ version: String) throws {
            try fm.createDirectory(at: folder.appendingPathComponent("bin"), withIntermediateDirectories: true)
            fm.createFile(atPath: folder.appendingPathComponent("bin/relo.mjs").path, contents: Data())
            try #"{"name":"@relo/cli","version":"\#(version)"}"#.write(to: folder.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        }
        // The app's own CLI is 0.17.64; a Homebrew copy at 0.17.54 sits behind a script at ~/.local/bin/relo.
        try package(server.cliURL!.deletingLastPathComponent().deletingLastPathComponent(), "0.17.64")
        fm.createFile(atPath: server.nodeURL!.path, contents: Data())
        let brew = home.appendingPathComponent("homebrew/lib/node_modules/@relo/cli")
        try package(brew, "0.17.54")
        try fm.createDirectory(at: server.launcherURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let old = "#!/bin/sh\nexec /opt/homebrew/bin/node \(brew.path)/bin/relo.mjs \"$@\"\n"
        try old.write(to: server.launcherURL, atomically: true, encoding: .utf8)
        #expect(server.foreignLauncherVersion() == "0.17.54")
        #expect(try server.installLauncher() == .written)
        #expect(try String(contentsOf: server.launcherURL, encoding: .utf8).contains(LocalServer.launcherMarker))
        #expect(try String(contentsOf: server.replacedLauncherURL, encoding: .utf8) == old)
        // A newer one stays.
        try fm.removeItem(at: server.launcherURL)
        try package(brew, "0.18.0")
        try old.write(to: server.launcherURL, atomically: true, encoding: .utf8)
        #expect(try server.installLauncher() == .otherInstalled)
        #expect(LocalServer.isOlder("0.17.54", than: "0.17.64") && !LocalServer.isOlder("0.17.64", than: "0.17.64")
                && !LocalServer.isOlder("1.0.0", than: "0.17.64"))
    }

    @Test func anotherReloCommandIsNeverReplaced() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("relo-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let resources = home.appendingPathComponent("Resources")
        let server = LocalServer(resources: resources, bundleIdentifier: "ai.relo.test", appRelease: "1+1", home: home)
        let fm = FileManager.default
        try fm.createDirectory(at: server.launcherURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        // The app must carry a CLI for the launcher to be written at all.
        try fm.createDirectory(at: server.cliURL!.deletingLastPathComponent(), withIntermediateDirectories: true)
        fm.createFile(atPath: server.cliURL!.path, contents: Data())
        fm.createFile(atPath: server.nodeURL!.path, contents: Data())
        // An install.sh launcher: a file without the marker.
        try "#!/bin/sh\nexec node /elsewhere/relo.mjs \"$@\"\n".write(to: server.launcherURL, atomically: true, encoding: .utf8)
        #expect(try server.installLauncher() == .otherInstalled)
        #expect(try String(contentsOf: server.launcherURL, encoding: .utf8).contains("/elsewhere/relo.mjs"))
        // An npm link: a symlink to a real file.
        try fm.removeItem(at: server.launcherURL)
        let target = home.appendingPathComponent("npm-relo.mjs")
        try "// relo".write(to: target, atomically: true, encoding: .utf8)
        try fm.createSymbolicLink(at: server.launcherURL, withDestinationURL: target)
        #expect(try server.installLauncher() == .otherInstalled)
        #expect(try fm.destinationOfSymbolicLink(atPath: server.launcherURL.path) == target.path)
        // Nothing there, or a link to nothing: Relo for Mac's own is written.
        try fm.removeItem(at: server.launcherURL)
        try fm.createSymbolicLink(at: server.launcherURL, withDestinationURL: home.appendingPathComponent("gone"))
        #expect(try server.installLauncher() == .written)
        #expect(try String(contentsOf: server.launcherURL, encoding: .utf8).contains(LocalServer.launcherMarker))
    }

    @Test func readsTheMacAppSignInCodeFromTheJoinLine() {
        let out = #"{"ok":true,"join":{"clientName":"Mac","macAppSignInCode":"relo_signin_x"}}"#
        #expect(LocalServer.firstString("macAppSignInCode", inJSONLines: out) == "relo_signin_x")
        #expect(LocalServer.firstString("macAppSignInCode", inJSONLines: #"{"ok":true}"#) == nil)
    }

    @Test func readsEachHarnessSetUpOrNot() {
        let out = #"{"ok":true,"show":true,"harnesses":[{"harness":"antigravity","level":"none","skill":"none"},{"harness":"codex","level":"guide","skill":"outdated"},{"harness":"claude-code","level":"optimize","skill":"current"}]}"#
        let harnesses = LocalServer.parseHarnesses(out)
        #expect(harnesses.map(\.id) == ["claude-code", "antigravity", "codex"])
        #expect(harnesses.map(\.isSetUp) == [true, false, true])
        #expect(harnesses.map(\.outdated) == [false, false, true])
        #expect(harnesses[1].name == "Antigravity")
        #expect(LocalServer.parseHarnesses("").isEmpty)
    }

    @Test func readsInstalledConfiguredAndParts() throws {
        let out = #"{"ok":true,"show":true,"harnesses":[{"harness":"claude-code","installed":true,"configured":true,"level":"guide","parts":{"instructions":"current","skill":"outdated","hooks":"guide","mcp":false,"approvals":true}},{"harness":"codex","installed":true,"configured":true,"level":"notify","parts":{"instructions":"current","skill":"none","hooks":"off","mcp":false,"approvals":false}},{"harness":"antigravity","installed":false,"configured":false,"level":"none","parts":{"instructions":"none","skill":"none","hooks":"n/a","mcp":false,"approvals":false}}]}"#
        let harnesses = LocalServer.parseHarnesses(out)
        #expect(harnesses.map(\.installed) == [true, true, false])
        let claude = try #require(harnesses.first)
        #expect(claude.parts == .init(instructions: .current, skill: .outdated, hooks: "guide", mcp: false, approvals: true))
        #expect(claude.outdated)
        #expect(claude.statusLine == "Shows its work in Relo · Live cards and session tracking")
        #expect(claude.installedSummary == "Instructions, Relo skill, session tracking, permission prompts on your iPhone")
        #expect(claude.updateReadyText == "An update is ready")
        #expect(claude.currentChoice == .guide)
        let codex = harnesses[1]
        #expect(codex.statusLine == "Instructions only · Notifications and questions")
        #expect(codex.currentChoice == .notify)
        #expect(codex.updateReadyText == nil)
        let missing = harnesses[2]
        #expect(missing.statusLine == "Not set up")
        #expect(missing.installedSummary == nil)
        #expect(missing.lacksSessionTracking)
        #expect(LocalServer.SetupChoice.recommended(for: missing) == .track)
        #expect(LocalServer.SetupChoice.recommended(for: claude) == .guide)
    }

    @Test func oldRowsKeepTheirMeaning() {
        let old = LocalServer.parseHarnesses(#"{"harnesses":[{"harness":"codex","level":"track","skill":"current"},{"harness":"cursor"}]}"#)
        #expect(old.map(\.installed) == [true, true])
        #expect(old.map(\.isSetUp) == [true, false])
        #expect(old[0].statusLine == "Shows its work in Relo · Live cards")
        #expect(old[1].statusLine == "Not set up")
        #expect(old[0].installedSummary == nil)
        #expect(old[1].currentChoice == .guide)
    }

    @Test func setupResultListsWhatChangedPerPart() {
        let out = #"{"ok":true,"changed":[{"kind":"block","harness":"codex"},{"kind":"skill","harness":"codex"},{"kind":"hooks","harness":"codex","action":"added"},{"kind":"other"}],"ownerSteps":[{"harness":"codex","step":"In Codex, type /hooks and trust Relo's hooks."}]}"#
        let result = LocalServer.parseSetUpResult(out)
        #expect(result.steps == ["Added instructions", "Installed the Relo skill", "Added session tracking"])
        #expect(result.ownerSteps == ["In Codex, type /hooks and trust Relo's hooks."])
        #expect(LocalServer.parseSetUpResult(#"{"ok":true}"#) == .init(steps: [], ownerSteps: []))
        let args = LocalServer.setUpAgentsArguments(agents: ["codex"], computer: "Mac", level: "guide", approvals: true)
        #expect(args == ["setup", "--computer", "Mac", "--json", "--level", "guide", "--approvals", "on", "--agent", "codex"])
    }

    @Test func removesOneHarnessOnly() {
        #expect(LocalServer.removeAgentArguments("antigravity") == ["uninstall", "--agent", "antigravity", "--apply", "--json"])
    }

    @Test func readsWhetherTheCommandIsSignedIn() {
        let signedIn = LocalServer.parseCommandSignIn(#"{"ok":true,"signedIn":true,"server":"https://relo.example.com","profile":"default"}"#)
        #expect(signedIn == .init(signedIn: true, server: URL(string: "https://relo.example.com")))
        #expect(LocalServer.parseCommandSignIn(#"{"ok":true,"signedIn":false}"#).signedIn == false)
        #expect(LocalServer.parseCommandSignIn("not json").signedIn == false)
    }

    @Test func listsAgentsClaudeCodeAndOpenCodeFirst() {
        let out = #"{"ok":true,"show":true,"harnesses":[{"harness":"codex"},{"harness":"opencode"},{"harness":"cursor"},{"harness":"claude-code"}]}"#
        #expect(LocalServer.parseAgents(out).map(\.id) == ["claude-code", "opencode", "codex", "cursor"])
        #expect(LocalServer.parseAgents(out).first?.name == "Claude Code")
        #expect(LocalServer.parseAgents("").isEmpty)
        let google = #"{"ok":true,"show":true,"harnesses":[{"harness":"gemini"},{"harness":"antigravity"}]}"#
        #expect(LocalServer.parseAgents(google).map(\.name) == ["Gemini CLI", "Antigravity"])
    }

    @Test func readsWhatTheOwnerStillDoesFromSetup() {
        let out = #"{"ok":true,"changed":[],"ownerSteps":[{"harness":"codex","step":"In Codex, type /hooks and trust Relo's hooks."}]}"#
        #expect(LocalServer.ownerSteps(inJSONLines: out) == ["In Codex, type /hooks and trust Relo's hooks."])
        #expect(LocalServer.ownerSteps(inJSONLines: #"{"ok":true,"changed":[]}"#).isEmpty)
    }

    @Test func buildsTheJoinInviteAndRestartCommands() {
        let args = LocalServer.joinArguments(code: "rci_1", apiURL: URL(string: "http://127.0.0.1:8187")!, challenge: "C", clientName: "Mac")
        #expect(args == ["auth", "join", "rci_1", "--api-url", "http://127.0.0.1:8187", "--local", "--profile", "local",
                         "--client-name", "Mac", "--mac-app-challenge", "C"])
        let server = LocalServer(resources: URL(fileURLWithPath: "/R"), bundleIdentifier: "ai.relo.notch", appRelease: "1+2", home: URL(fileURLWithPath: "/H"))
        let invite = server.inviteArguments(level: "guide", agents: ["claude-code", "opencode"])
        #expect(invite == ["/R/server/app/server/dist/local/main.js", "invite", "--root", "/H/Library/Application Support/Relo/server",
                           "--mac-app", "--level", "guide", "--agent", "claude-code", "--agent", "opencode"])
        #expect(server.restartArguments.last == "gui/\(getuid())/ai.relo.notch.server")
    }

    @Test func restartsOnlyWhenTheReleaseDiffers() {
        #expect(LocalServer.needsRestart(runningRelease: "0.4+1", appVersion: "0.4+1") == false)
        #expect(LocalServer.needsRestart(runningRelease: "0.3+9", appVersion: "0.4+1"))
    }

    @Test func runsAnInjectedRunner() async throws {
        let server = LocalServer(resources: URL(fileURLWithPath: "/R"), bundleIdentifier: "x", appRelease: "1+1", home: URL(fileURLWithPath: "/H"),
                                 runner: { exe, args in .init(stdout: "\(exe.lastPathComponent) \(args.joined(separator: " "))", stderr: "", status: 0) })
        let out = try await server.relo(["doctor", "--json"])
        #expect(out.stdout == "node /R/server/cli/bin/relo.mjs doctor --json")
    }

    @Test func shortVersionDropsTheBuild() {
        #expect(LocalServer.shortVersion(ofRelease: "0.2.32+257") == "0.2.32")
        #expect(LocalServer.shortVersion(ofRelease: "0.2.32") == "0.2.32")
    }

    @Test func skippingAgentsLinksOnlyTheCommandAndTheApp() {
        let url = URL(string: "http://127.0.0.1:8187")!
        #expect(!LocalServer.joinArguments(code: "rci_1", apiURL: url, challenge: "C", clientName: "Mac").contains("--no-setup"))
        #expect(LocalServer.joinArguments(code: "rci_1", apiURL: url, challenge: "C", clientName: "Mac", setUpAgents: false).contains("--no-setup"))
    }

    @Test func setsUpOnlyTheNamedAgentsWithoutAnyPrompt() {
        let args = LocalServer.setUpAgentsArguments(agents: ["claude-code", "opencode"], computer: "Mac")
        #expect(args.starts(with: ["setup"]))
        #expect(args.contains("--json"))
        // The installed level and approvals stay as they are.
        #expect(!args.contains("--level") && !args.contains("--approvals"))
        #expect(zip(args, args.dropFirst()).filter { $0.0 == "--agent" }.map(\.1) == ["claude-code", "opencode"])
    }

    @Test func setUpAgentsCanNameTheLevel() {
        let args = LocalServer.setUpAgentsArguments(agents: ["claude-code"], computer: "Mac", level: "guide")
        #expect(zip(args, args.dropFirst()).contains { $0.0 == "--level" && $0.1 == "guide" })
        #expect(zip(args, args.dropFirst()).filter { $0.0 == "--agent" }.map(\.1) == ["claude-code"])
    }

    @Test func prepareRunsTheSupervisorOnTheDataRoot() {
        let server = LocalServer(resources: URL(fileURLWithPath: "/App/Contents/Resources"), bundleIdentifier: "ai.relo.notch",
                                 appRelease: "1+1", home: URL(fileURLWithPath: "/Users/a"))
        let args = server.prepareArguments
        #expect(args?.dropFirst().first == "prepare")
        #expect(args?.last == server.dataRoot.path)
        #expect(args?.contains("--root") == true)
    }

    @Test func findsARemoteLoginInTheActiveProfileOfTheCLIConfig() {
        func host(_ json: String) -> String? { LocalServer.remoteLoginHost(inConfig: Data(json.utf8)) }
        #expect(host(#"{"activeProfile":"default","profiles":{"default":{"apiUrl":"https://relo.example.com","token":"x"}}}"#) == "relo.example.com")
        // The profile Relo for Mac made is not a login to leave, whatever its address.
        #expect(host(#"{"activeProfile":"local","profiles":{"local":{"apiUrl":"http://127.0.0.1:8187","local":true},"default":{"apiUrl":"https://relo.example.com"}}}"#) == nil)
        // An SSH tunnel is loopback too: only the local flag says it is this Mac's.
        #expect(host(#"{"activeProfile":"default","profiles":{"default":{"apiUrl":"http://127.0.0.1:9999"}}}"#) == "127.0.0.1")
        #expect(host(#"{"apiUrl":"https://relo.example.com"}"#) == nil)
        #expect(host("nope") == nil)
    }

    @Test func onlyALauncherWithTheMarkerIsRewrittenOrRemoved() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("relo-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let fm = FileManager.default
        let nodeA = home.appendingPathComponent("A/Relo.app/Contents/Resources/server/node")
        let cliA = home.appendingPathComponent("A/Relo.app/Contents/Resources/server/cli/bin/relo.mjs")
        for url in [nodeA, cliA] {
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try "".write(to: url, atomically: true, encoding: .utf8)
        }
        let server = LocalServer(resources: home.appendingPathComponent("A/Relo.app/Contents/Resources"), bundleIdentifier: "ai.relo.test",
                                 appRelease: "1+1", home: home)
        try fm.createDirectory(at: server.launcherURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Another install's relo: left alone.
        try "#!/bin/sh\nexec node /elsewhere/relo.mjs \"$@\"\n".write(to: server.launcherURL, atomically: true, encoding: .utf8)
        #expect(!server.launcherIsStale())
        server.refreshLauncherIfMoved()
        server.removeLauncher()
        #expect(fm.fileExists(atPath: server.launcherURL.path))
        // Ours, written for a copy of the app that has since moved: pointed at this one.
        try LocalServer.launcherScript(node: "/old/node", cli: "/old/relo.mjs").write(to: server.launcherURL, atomically: true, encoding: .utf8)
        #expect(server.launcherIsStale())
        server.refreshLauncherIfMoved()
        #expect(try String(contentsOf: server.launcherURL, encoding: .utf8).contains(nodeA.path))
        #expect(!server.launcherIsStale())
        server.removeLauncher()
        #expect(!fm.fileExists(atPath: server.launcherURL.path))
    }

    @Test func theLeaveAndUninstallCommandsTouchOnlyTheLocalProfile() async throws {
        let calls = CallLog()
        let server = LocalServer(resources: URL(fileURLWithPath: "/R"), bundleIdentifier: "x", appRelease: "1+1", home: URL(fileURLWithPath: "/H"),
                                 runner: { _, args in calls.add(args); return .init(stdout: "", stderr: "", status: 0) })
        try await server.logoutLocalProfile()
        try await server.setAutomaticUpdates()
        #expect(calls.all == [["/R/server/cli/bin/relo.mjs", "auth", "logout", "--profile", "local", "--only-local"],
                              ["/R/server/cli/bin/relo.mjs", "update", "--mode", "auto"]])
    }
}

private final class CallLog: @unchecked Sendable {
    private let lock = NSLock()
    private var calls: [[String]] = []
    func add(_ args: [String]) { lock.lock(); calls.append(args); lock.unlock() }
    var all: [[String]] { lock.lock(); defer { lock.unlock() }; return calls }

    @Test func theLoginEnvironmentKeepsOnlyAllowListedNames() {
        let output = """
        PATH=/opt/homebrew/bin:/usr/bin
        HOME=/Users/a
        CLAUDE_CONFIG_DIR=/Users/a/.claude-work
        CODEX_HOME=/Users/a/.codex-x
        GEMINI_CLI_HOME=/Users/a/g
        GEMINI_API_KEY=secret
        XDG_CONFIG_HOME=/Users/a/.config
        RELO_PROFILE=work
        RELO_TOKEN=secret
        RELO_HOOK_LAUNCHER=/elsewhere/relo
        AWS_SECRET_ACCESS_KEY=nope
        NOTE=line one
        continues here
        """
        let parsed = LocalServer.parseLoginEnvironment(output)
        #expect(parsed["PATH"] == "/opt/homebrew/bin:/usr/bin")
        #expect(parsed["CLAUDE_CONFIG_DIR"] == "/Users/a/.claude-work")
        #expect(parsed["CODEX_HOME"] == "/Users/a/.codex-x")
        #expect(parsed["GEMINI_CLI_HOME"] == "/Users/a/g")
        #expect(parsed["XDG_CONFIG_HOME"] == "/Users/a/.config")
        #expect(parsed["RELO_PROFILE"] == "work")
        #expect(parsed["GEMINI_API_KEY"] == nil)
        #expect(parsed["RELO_TOKEN"] == nil)
        #expect(parsed["AWS_SECRET_ACCESS_KEY"] == nil)
        #expect(parsed["NOTE"] == nil)
        #expect(LocalServer.parseLoginEnvironment("garbage without equals") == [:])
    }

    @Test func theChildEnvironmentKeepsTheAppsHookLauncher() {
        let base = ["PATH": "/usr/bin", "RELO_HOOK_LAUNCHER": "/Users/a/.local/bin/relo", "TMPDIR": "/tmp/x"]
        let login = ["PATH": "/opt/homebrew/bin:/usr/bin", "RELO_HOOK_LAUNCHER": "/elsewhere/relo", "CODEX_HOME": "/c"]
        let merged = LocalServer.childEnvironment(base: base, login: login)
        #expect(merged["PATH"] == "/opt/homebrew/bin:/usr/bin")
        #expect(merged["CODEX_HOME"] == "/c")
        #expect(merged["RELO_HOOK_LAUNCHER"] == "/Users/a/.local/bin/relo")
        #expect(merged["TMPDIR"] == "/tmp/x")
        #expect(LocalServer.childEnvironment(base: base, login: [:]) == base)
    }

    @Test func aLoginShellThatFailsOrHangsFallsBackToNothing() {
        #expect(LocalServer.captureLoginEnvironment(shell: "/nonexistent/shell", timeout: 1) == nil)
        let script = FileManager.default.temporaryDirectory.appendingPathComponent("hang-shell-\(UUID().uuidString)")
        try? "#!/bin/sh\nsleep 5\n".write(to: script, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        defer { try? FileManager.default.removeItem(at: script) }
        #expect(LocalServer.captureLoginEnvironment(shell: script.path, timeout: 0.3) == nil)
    }

    @Test func readsTheRelosWarningFromDoctor() {
        let some = #"{"ok":true,"warnings":{"relos":{"state":"several","hint":"2 relo commands on PATH"}}}"#
        #expect(LocalServer.parseRelosWarning(some) == LocalServer.RelosWarning(state: "several", hint: "2 relo commands on PATH"))
        #expect(LocalServer.parseRelosWarning(#"{"ok":true,"warnings":{}}"#) == nil)
        #expect(LocalServer.parseRelosWarning("nope") == nil)
    }
}
