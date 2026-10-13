@testable import ReloNotificationSupport
import Darwin
import Foundation

enum HarnessError: Error { case failed(String) }
func require(_ condition: @autoclosure () throws -> Bool, _ reason: String) throws {
    guard try condition() else { throw HarnessError.failed(reason) }
}
let arguments = CommandLine.arguments
let root = URL(fileURLWithPath: arguments[1])
let mode = arguments.count > 2 ? arguments[2] : "parent"
let file = NotificationReceiptFile(baseDirectory: root, maximumStored: 500)
let ready = root.appendingPathComponent("lock-held")
let release = root.appendingPathComponent("release-lock")

func awaitFile(_ url: URL) throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while !FileManager.default.fileExists(atPath: url.path) {
        try require(ContinuousClock.now < deadline, "process handshake timed out")
        Thread.sleep(forTimeInterval: 0.001)
    }
}
func launch(_ mode: String) throws -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: arguments[0])
    process.arguments = [root.path, mode]
    try process.run()
    return process
}
func finish(_ process: Process) throws {
    process.waitUntilExit()
    try require(process.terminationStatus == 0, "child process failed")
}

switch mode {
case "hold":
    let descriptor = Darwin.open(root.appendingPathComponent("pending-notification-receipts.json.lock").path, O_RDWR)
    try require(descriptor >= 0 && flock(descriptor, LOCK_EX) == 0, "child could not acquire flock")
    try Data().write(to: ready)
    try awaitFile(release)
    flock(descriptor, LOCK_UN)
    Darwin.close(descriptor)
case "append":
    for i in 100..<200 { try file.append(id: "ntf_\(i)") }
case "remove-and-append":
    try file.remove(ids: Set((0..<50).map { "ntf_\($0)" }))
    for i in 200..<300 { try file.append(id: "ntf_\(i)") }
default:
    for i in 0..<100 { try file.append(id: "ntf_\(i)") }
    let holder = try launch("hold")
    try awaitFile(ready)
    let start = ContinuousClock.now
    let result = try file.append(id: "ntf_blocked", lockDeadline: .now.advanced(by: .milliseconds(20)))
    try require(result == .notRecordedWithinBudget, "another process's flock was bypassed")
    try require(start.duration(to: .now) < .milliseconds(150), "receipt lock blocked presentation budget")
    try Data().write(to: release)
    try finish(holder)
    let app = try launch("append")
    let nse = try launch("remove-and-append")
    try finish(app); try finish(nse)
    let actual = Set(try file.pending(limit: 500))
    try require(actual == Set((50..<300).map { "ntf_\($0)" }), "cross-process read/modify/write lost records")
    print("PASS: two-process flock exclusion, 20 ms capture budget, and 250 exact surviving records")
}
