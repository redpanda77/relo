import Foundation
import ReloCore

public protocol DiagnosticArchiveIO: Sendable {
    func load() async throws -> [OperationDiagnostic]
    func save(_ events: [OperationDiagnostic]) async throws
}

/// Recording never awaits disk. One writer coalesces snapshots while the ring stays bounded.
/// Storage errors remain local diagnostics state and never recursively emit diagnostics.
public actor BoundedDiagnosticStore: DiagnosticStoring {
    public let capacity: Int
    private let archive: any DiagnosticArchiveIO
    private var events: [OperationDiagnostic] = []
    private var revision: UInt64 = 0
    private var restored = false
    private var unavailable = false
    private var restoration: Task<[OperationDiagnostic], Error>?
    private var writer: Task<Void, Never>?

    public init(archive: any DiagnosticArchiveIO, capacity: Int = 500) {
        self.archive = archive; self.capacity = max(1, min(capacity, 2_000))
    }
    public init(fileURL: URL, capacity: Int = 500) {
        self.archive = FileDiagnosticArchive(fileURL: fileURL)
        self.capacity = max(1, min(capacity, 2_000))
    }

    public func record(_ event: OperationDiagnostic) {
        events.append(event)
        if events.count > capacity { events.removeFirst(events.count - capacity) }
        revision &+= 1
        if writer == nil { writer = Task { await persist() } }
    }

    public func snapshot() async -> DiagnosticSnapshot {
        _ = await restore()
        return .init(events: events, capacity: capacity, persistenceUnavailable: unavailable)
    }

    /// Explicit verification/export callers may wait; product actions never call this.
    public func flush() async { await writer?.value }

    private func restore() async -> Bool {
        guard !restored else { return true }
        if restoration == nil { restoration = Task { [archive] in try await archive.load() } }
        do {
            let previous = try await restoration!.value
            if !restored { events = Array((previous + events).suffix(capacity)); restored = true }
            restoration = nil
            return true
        } catch {
            restoration = nil; unavailable = true
            // Unreadable existing bytes cannot authorize replacement with an empty history.
            return false
        }
    }

    private func persist() async {
        defer { writer = nil }
        guard await restore() else { return }
        while true {
            let captured = revision
            do { try await archive.save(events); unavailable = false }
            catch { unavailable = true; return }
            if captured == revision { return }
        }
    }
}

private struct FileDiagnosticArchive: DiagnosticArchiveIO {
    let fileURL: URL
    private static let maximumBytes = 2 * 1_024 * 1_024

    func load() async throws -> [OperationDiagnostic] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return [] }
        let size = try fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= Self.maximumBytes else { throw CocoaError(.fileReadTooLarge) }
        let data = try Data(contentsOf: fileURL)
        guard data.count <= Self.maximumBytes else { throw CocoaError(.fileReadTooLarge) }
        return Array(try JSONDecoder().decode([OperationDiagnostic].self, from: data).suffix(2_000))
    }

    func save(_ events: [OperationDiagnostic]) async throws {
        let data = try JSONEncoder().encode(Array(events.suffix(2_000)))
        guard data.count <= Self.maximumBytes else { throw CocoaError(.fileWriteOutOfSpace) }
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: fileURL, options: .atomic)
        #endif
    }
}
