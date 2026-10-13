@testable import ReloCore
import Darwin
import Foundation
import Testing
@testable import ReloNotificationSupport

@Suite struct NotificationReceiptFileTests {
    private func directory() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }

    @Test func privateNotificationPreservesOnlyItsExplicitReceiptScope() throws {
        let scope = try ReceiptScope(serverOrigin: #require(URL(string: "https://relo.example")),
                                     accountId: "acc_11111111", deviceId: "dev_11111111")
        let wire: [String: Any] = ["serverOriginHash": scope.serverOriginHash,
                                  "accountId": scope.accountId, "deviceId": scope.deviceId]
        let envelope = try #require(ReloNotificationEnvelope(userInfo: ["relo": [
            "notificationId": "ntf_11111111", "privacy": "private", "receiptScope": wire,
            "sourceName": "Private project", "avatarUrl": "https://example.com/avatar.png"
        ]], requestIdentifier: "ignored"))
        #expect(envelope.receiptScope == scope)
        #expect(envelope.sourceName == nil && envelope.avatarURL == nil)
        let missing = ReloNotificationEnvelope(userInfo: ["relo": ["notificationId": "ntf_11111111", "privacy": "private"]], requestIdentifier: "ignored")
        #expect(missing?.receiptScope == nil)
        let root = directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let record = try NotificationReceiptRecord(scope: #require(envelope.receiptScope), notificationID: envelope.notificationID)
        #expect(try ReloNotificationReceiptStore(baseDirectory: root).add(record: record, lockWait: 0.020) == .inserted)
        #expect(try NotificationReceiptFile(baseDirectory: root).pending(scope: scope, limit: 25).records == [record])
    }

    @Test func predecessorEnvelopeAndCapacityAreExplicit() throws {
        let root = directory()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let path = root.appendingPathComponent("pending-notification-receipts.json")
        try Data(#"{"schemaVersion":1,"payload":["ntf_original"]}"#.utf8).write(to: path)
        let file = NotificationReceiptFile(baseDirectory: root)
        let extensionAdapter = ReloNotificationReceiptStore(baseDirectory: root)
        #expect(try extensionAdapter.pending(limit: 200) == ["ntf_original"])
        #expect(try file.append(id: "ntf_original") == .duplicate)
        for i in 1..<200 { #expect(try file.append(id: "ntf_\(i)") == .inserted) }
        #expect(try extensionAdapter.add(notificationID: "ntf_200") == .insertedWithEviction(count: 1))
        let pending = try file.pending(limit: 1_000)
        #expect(pending.count == 200 && !pending.contains("ntf_original"))
        try extensionAdapter.remove(notificationIDs: ["ntf_1"])
        #expect(try file.pending(limit: 200) == Array(pending.dropFirst()))
        // Simulator files do not expose iOS data-protection attributes. Verify the
        // actual attribute when this same suite runs on a user-installed device.
        #if os(iOS) && !targetEnvironment(simulator)
        let protection = try FileManager.default.attributesOfItem(atPath: path.path)[.protectionKey] as? String
        #expect(protection == FileProtectionType.completeUntilFirstUserAuthentication.rawValue, "Actual protection: \(String(describing: protection))")
        #endif
    }

    @Test(arguments: [Data("{".utf8), Data(#"{"schemaVersion":99,"payload":[]}"#.utf8),
                      Data(#"{"schemaVersion":1,"payload":["invalid/id"]}"#.utf8)])
    func damagedOrFutureBytesAreNeverReplaced(bytes: Data) throws {
        let root = directory()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let path = root.appendingPathComponent("pending-notification-receipts.json")
        try bytes.write(to: path)
        let file = NotificationReceiptFile(baseDirectory: root)
        #expect(throws: NotificationReceiptFileError.self) { try file.pending(limit: 200) }
        #expect(throws: NotificationReceiptFileError.self) { try file.append(id: "ntf_new") }
        #expect(throws: NotificationReceiptFileError.self) { try file.remove(ids: ["ntf_old"]) }
        #expect(try Data(contentsOf: path) == bytes)
    }

    @Test(arguments: [ReceiptFaultIO.Fault.prepare, .read, .replace])
    fileprivate func accessAndInterruptedReplacementFailuresRemainObservable(fault: ReceiptFaultIO.Fault) throws {
        let root = directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let healthy = NotificationReceiptFile(baseDirectory: root)
        try healthy.append(id: "ntf_original")
        let path = root.appendingPathComponent("pending-notification-receipts.json")
        let bytes = try Data(contentsOf: path)
        let failing = NotificationReceiptFile(baseDirectory: root, io: ReceiptFaultIO(fault: fault))
        #expect(throws: NotificationReceiptFileError.unavailable) { try failing.append(id: "ntf_new") }
        #expect(throws: NotificationReceiptFileError.unavailable) { try failing.remove(ids: ["ntf_original"]) }
        if fault != .replace {
            #expect(throws: NotificationReceiptFileError.unavailable) { try failing.pending(limit: 200) }
        }
        #expect(try Data(contentsOf: path) == bytes)
        #expect(try healthy.pending(limit: 200) == ["ntf_original"])
    }

    @Test func heldLockAndInvalidLockFileDoNotLookEmpty() throws {
        let root = directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let file = NotificationReceiptFile(baseDirectory: root)
        try file.append(id: "ntf_original")
        let lock = root.appendingPathComponent("pending-notification-receipts.json.lock")
        let descriptor = Darwin.open(lock.path, O_RDWR)
        #expect(descriptor >= 0)
        defer { Darwin.close(descriptor) }
        #expect(flock(descriptor, LOCK_EX | LOCK_NB) == 0)
        #expect(try file.append(id: "ntf_new", lockDeadline: .now) == .notRecordedWithinBudget)
        #expect(throws: NotificationReceiptFileError.lockTimedOut) { try file.pending(limit: 200) }
        #expect(throws: NotificationReceiptFileError.lockTimedOut) { try file.remove(ids: ["ntf_original"]) }
        #expect(flock(descriptor, LOCK_UN) == 0)
        #expect(try file.pending(limit: 200) == ["ntf_original"])
        try FileManager.default.removeItem(at: lock)
        try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: false)
        #expect(throws: NotificationReceiptFileError.lockUnavailable) { try file.pending(limit: 200) }
    }
}

private struct ReceiptFaultIO: NotificationReceiptFileIO {
    enum Fault: Sendable { case prepare, read, replace }
    let fault: Fault
    private let real = ProtectedNotificationReceiptFileIO()
    func prepare(directory: URL) throws {
        if fault == .prepare { throw CocoaError(.fileWriteNoPermission) }
        try real.prepare(directory: directory)
    }
    func read(url: URL) throws -> Data {
        if fault == .read { throw CocoaError(.fileReadNoPermission) }
        return try real.read(url: url)
    }
    func replace(data: Data, at url: URL) throws {
        if fault == .replace {
            // An interrupted temporary-file write must leave the committed file untouched.
            let staging = url.appendingPathExtension("interrupted")
            try data.prefix(3).write(to: staging)
            throw CocoaError(.fileWriteOutOfSpace)
        }
        try real.replace(data: data, at: url)
    }
}
