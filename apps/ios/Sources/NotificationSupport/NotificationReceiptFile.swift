import ReloCore
import Darwin
import Foundation

public enum ReceiptAppendResult: Equatable, Sendable {
    case inserted
    case duplicate
    case insertedWithEviction(count: Int)
    case notRecordedWithinBudget
}

extension NotificationReceiptFile {
    private struct ScopedIdentity: Hashable {
        let scope: ReceiptScope
        let notificationID: String
    }
    private struct ScopedEnvelope: Codable {
        let schemaVersion: Int
        var payload: [NotificationReceiptRecord]
        let retiredUnscopedCount: Int
    }

    @discardableResult
    public func append(record: NotificationReceiptRecord, lockDeadline: ContinuousClock.Instant? = nil) throws -> ReceiptAppendResult {
        do {
            return try withLock(deadline: lockDeadline) {
                var envelope = try readScopedUnlocked()
                if envelope.payload.contains(where: { $0.scope == record.scope && $0.notificationID == record.notificationID }) {
                    return .duplicate
                }
                envelope.payload.append(record)
                let evicted = max(0, envelope.payload.count - maximumStored)
                envelope.payload = Array(envelope.payload.suffix(maximumStored))
                try writeScopedUnlocked(envelope)
                return evicted == 0 ? .inserted : .insertedWithEviction(count: evicted)
            }
        } catch NotificationReceiptFileError.lockTimedOut { return .notRecordedWithinBudget }
    }

    public func pending(scope: ReceiptScope, limit: Int) throws -> NotificationReceiptBatch {
        try withLock(deadline: .now.advanced(by: .milliseconds(50))) {
            let envelope = try readScopedUnlocked()
            return NotificationReceiptBatch(records: Array(envelope.payload.lazy.filter { $0.scope == scope }.prefix(max(0, limit))),
                                            retiredUnscopedCount: envelope.retiredUnscopedCount)
        }
    }

    public func remove(records: Set<NotificationReceiptRecord>) throws {
        guard !records.isEmpty else { return }
        try withLock(deadline: .now.advanced(by: .milliseconds(50))) {
            var envelope = try readScopedUnlocked()
            let count = envelope.payload.count
            envelope.payload.removeAll { records.contains($0) }
            if count != envelope.payload.count { try writeScopedUnlocked(envelope) }
        }
    }

    public func retire(scope: ReceiptScope) throws {
        try withLock(deadline: .now.advanced(by: .milliseconds(50))) {
            var envelope = try readScopedUnlocked()
            let count = envelope.payload.count
            envelope.payload.removeAll { $0.scope == scope }
            if count != envelope.payload.count { try writeScopedUnlocked(envelope) }
        }
    }

    private func readScopedUnlocked() throws -> ScopedEnvelope {
        let data: Data
        do { data = try io.read(url: fileURL) }
        catch {
            let error = error as NSError
            if (error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError)
                || (error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT)) {
                return ScopedEnvelope(schemaVersion: 2, payload: [], retiredUnscopedCount: 0)
            }
            throw NotificationReceiptFileError.unavailable
        }
        guard data.count <= 1_048_576,
              let header = try? JSONDecoder().decode(Header.self, from: data) else { throw NotificationReceiptFileError.corrupt }
        if header.schemaVersion == 1 {
            let predecessor = try readUnlocked()
            let migrated = ScopedEnvelope(schemaVersion: 2, payload: [], retiredUnscopedCount: predecessor.count)
            try writeScopedUnlocked(migrated)
            return migrated
        }
        guard header.schemaVersion == 2 else { throw NotificationReceiptFileError.unsupportedVersion }
        guard let envelope = try? JSONDecoder().decode(ScopedEnvelope.self, from: data),
              envelope.retiredUnscopedCount >= 0,
              envelope.payload.count <= maximumStored,
              Set(envelope.payload.map { ScopedIdentity(scope: $0.scope, notificationID: $0.notificationID) }).count == envelope.payload.count
        else { throw NotificationReceiptFileError.corrupt }
        return envelope
    }

    private func writeScopedUnlocked(_ envelope: ScopedEnvelope) throws {
        do { try io.replace(data: JSONEncoder().encode(envelope), at: fileURL) }
        catch { throw NotificationReceiptFileError.unavailable }
    }
}

public enum NotificationReceiptFileError: Error, Equatable, Sendable {
    case invalidIdentifier, unavailable, corrupt, unsupportedVersion, lockUnavailable, lockTimedOut
}

/// The I/O seam permits failure injection without replacing the real cross-process lock.
public protocol NotificationReceiptFileIO: Sendable {
    func prepare(directory: URL) throws
    func read(url: URL) throws -> Data
    func replace(data: Data, at url: URL) throws
}

public struct ProtectedNotificationReceiptFileIO: NotificationReceiptFileIO {
    public init() {}
    public func prepare(directory: URL) throws {
        #if os(iOS)
        let attributes: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        #else
        let attributes: [FileAttributeKey: Any] = [:]
        #endif
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: attributes)
    }
    public func read(url: URL) throws -> Data { try Data(contentsOf: url) }
    public func replace(data: Data, at url: URL) throws {
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
    }
}

/// One flock protects the entire read/modify/atomic-replace transaction in both processes.
/// V1 bytes and the filename remain compatible with the installed predecessor.
public struct NotificationReceiptFile: Sendable {
    private struct Envelope: Codable { let schemaVersion: Int; let payload: [String] }
    private struct Header: Decodable { let schemaVersion: Int }
    private let directory: URL
    private let fileURL: URL
    private let lockURL: URL
    private let maximumStored: Int
    private let io: any NotificationReceiptFileIO

    public init(baseDirectory: URL, filename: String = "pending-notification-receipts.json",
                maximumStored: Int = 200, io: any NotificationReceiptFileIO = ProtectedNotificationReceiptFileIO()) {
        precondition(maximumStored > 0)
        directory = baseDirectory
        fileURL = baseDirectory.appendingPathComponent(filename)
        lockURL = baseDirectory.appendingPathComponent("\(filename).lock")
        self.maximumStored = maximumStored; self.io = io
    }

    @discardableResult
    public func append(id: String, lockDeadline: ContinuousClock.Instant? = nil) throws -> ReceiptAppendResult {
        guard Self.valid(id) else { throw NotificationReceiptFileError.invalidIdentifier }
        do {
            return try withLock(deadline: lockDeadline) {
                var ids = try readUnlocked()
                guard !ids.contains(id) else { return .duplicate }
                ids.append(id)
                let evicted = max(0, ids.count - maximumStored)
                try writeUnlocked(Array(ids.suffix(maximumStored)))
                return evicted == 0 ? .inserted : .insertedWithEviction(count: evicted)
            }
        } catch NotificationReceiptFileError.lockTimedOut { return .notRecordedWithinBudget }
    }

    public func pending(limit: Int) throws -> [String] {
        guard limit > 0 else { return [] }
        return try withLock(deadline: .now.advanced(by: .milliseconds(50))) {
            Array(try readUnlocked().prefix(limit))
        }
    }

    public func remove(ids: Set<String>) throws {
        guard !ids.isEmpty else { return }
        try withLock(deadline: .now.advanced(by: .milliseconds(50))) {
            let previous = try readUnlocked()
            let remaining = previous.filter { !ids.contains($0) }
            if previous != remaining { try writeUnlocked(remaining) }
        }
    }

    private static func valid(_ id: String) -> Bool {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
        return (1...200).contains(id.count) && id.unicodeScalars.allSatisfy(allowed.contains)
    }

    private func readUnlocked() throws -> [String] {
        let data: Data
        do { data = try io.read(url: fileURL) }
        catch {
            let error = error as NSError
            if (error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError)
                || (error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT)) { return [] }
            throw NotificationReceiptFileError.unavailable
        }
        guard data.count <= 1_048_576,
              let header = try? JSONDecoder().decode(Header.self, from: data) else { throw NotificationReceiptFileError.corrupt }
        guard header.schemaVersion == 1 else { throw NotificationReceiptFileError.unsupportedVersion }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
              envelope.payload.allSatisfy(Self.valid),
              Set(envelope.payload).count == envelope.payload.count else { throw NotificationReceiptFileError.corrupt }
        return envelope.payload
    }

    private func writeUnlocked(_ ids: [String]) throws {
        do { try io.replace(data: JSONEncoder().encode(Envelope(schemaVersion: 1, payload: ids)), at: fileURL) }
        catch { throw NotificationReceiptFileError.unavailable }
    }

    private func withLock<T>(deadline: ContinuousClock.Instant?, _ body: () throws -> T) throws -> T {
        do { try io.prepare(directory: directory) }
        catch { throw NotificationReceiptFileError.unavailable }
        let descriptor = Darwin.open(lockURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw NotificationReceiptFileError.lockUnavailable }
        defer { Darwin.close(descriptor) }
        #if os(iOS)
        do { try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: lockURL.path) }
        catch { throw NotificationReceiptFileError.unavailable }
        #endif
        while flock(descriptor, deadline == nil ? LOCK_EX : LOCK_EX | LOCK_NB) != 0 {
            if errno == EINTR { continue }
            guard let deadline, errno == EWOULDBLOCK || errno == EAGAIN else { throw NotificationReceiptFileError.lockUnavailable }
            guard ContinuousClock.now < deadline else { throw NotificationReceiptFileError.lockTimedOut }
            Thread.sleep(forTimeInterval: 0.001)
        }
        defer { flock(descriptor, LOCK_UN) }
        return try body()
    }
}
