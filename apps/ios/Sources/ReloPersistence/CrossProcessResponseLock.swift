import Foundation
import ReloCore
import Darwin

extension CrossProcessResponseFile {
    func withLock<Value>(
        accountID: String,
        deviceID: String,
        _ body: (URL) throws -> Value
    ) throws -> Value {
        guard Self.safe(accountID), Self.safe(deviceID) else {
            throw AccountScopedInboxCacheError.invalidAccountId
        }
        let directory = baseDirectory
            .appendingPathComponent(accountID, isDirectory: true)
            .appendingPathComponent(deviceID, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let lockURL = directory.appendingPathComponent("responses.lock")
        let descriptor = Darwin.open(lockURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw CrossProcessResponseFileError.lockUnavailable }
        defer { Darwin.close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else { throw CrossProcessResponseFileError.lockUnavailable }
        defer { flock(descriptor, LOCK_UN) }
        return try body(directory.appendingPathComponent("pending-responses.json"))
    }
}
