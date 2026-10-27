// Relo for Mac's background server (plan 16): the program of the login agent the app registers with SMAppService
// (Contents/Library/LaunchAgents/<bundle id>.server.plist). It runs the bundled Node with the server's local-mode
// supervisor, data under ~/Library/Application Support/Relo/server, and tells it the app's version so the app can see
// after an update that the running server is an older one. Its own output, which the supervisor, the API and the worker
// inherit, goes to <root>/logs/relo.log (appended), where the app's "Show details" reads it. scripts/release/embed-server.sh
// compiles it into Contents/MacOS/relo-server.
import Foundation

// Under launchd a BundleProgram's argv[0] is relative: the bundle comes from the executable's own path.
let executable = URL(fileURLWithPath: Bundle.main.executablePath ?? CommandLine.arguments[0]).resolvingSymlinksInPath()
let app = executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
let server = app.appendingPathComponent("Contents/Resources/server")
let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")) as? [String: Any] ?? [:]
let version = "\(info["CFBundleShortVersionString"] as? String ?? "0")+\(info["CFBundleVersion"] as? String ?? "0")"
let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Relo/server")

// stdout and stderr to the log file: the agent's own streams are /dev/null, so without this every server message is lost.
let logs = root.appendingPathComponent("logs")
try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
let log = open(logs.appendingPathComponent("relo.log").path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
if log >= 0 {
    dup2(log, STDOUT_FILENO)
    dup2(log, STDERR_FILENO)
    if log > STDERR_FILENO { close(log) }
} else {
    perror("relo-server: open relo.log")
}

let node = server.appendingPathComponent("node").path
setenv("RELO_POSTGRES_BIN", server.appendingPathComponent("app/postgres/bin").path, 1)
setenv("RELO_RELEASE_IDENTITY", version, 1)
let arguments = [node, server.appendingPathComponent("app/server/dist/local/main.js").path, "run", "--root", root.path]
execv(node, arguments.map { strdup($0) } + [nil])
perror("relo-server: execv")
exit(1)
