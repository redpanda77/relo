@testable import ReloPersistence
import Foundation
import Security
import Testing
@testable import ReloCore

@Suite("Startup preserves protected state")
struct StoragePreflightSafetyTests {
    @Test(arguments: [Int(errSecInteractionNotAllowed), Int(errSecNotAvailable)])
    func lockedMarkerCannotEraseDurableIntent(status: Int) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let pending = root.appendingPathComponent("pending-responses.json")
        let original = Data("durable intent must survive".utf8)
        try original.write(to: pending)
        let marker = FailingSchemaMarker(error: CredentialStoreError.keychain(OSStatus(status)))
        let preflight = KeychainLocalStoragePreflight(service: "test.unused.\(UUID())", accountsDirectory: root, schemaMarker: marker)
        #expect(throws: CredentialStoreError.keychain(OSStatus(status))) { try preflight.run() }
        #expect(marker.saves == 0)
        #expect(try Data(contentsOf: pending) == original)
    }

    @Test func unknownMarkerFailurePropagatesWithoutRepair() throws {
        let marker = FailingSchemaMarker(error: MarkerFailure.unavailable)
        let preflight = KeychainLocalStoragePreflight(service: "test.unused.\(UUID())", accountsDirectory: URL(fileURLWithPath: "/unused"), schemaMarker: marker)
        #expect(throws: MarkerFailure.unavailable) { try preflight.run() }
        #expect(marker.saves == 0)
    }
}

private enum MarkerFailure: Error, Equatable { case unavailable }
private final class FailingSchemaMarker: LocalStorageSchemaMarker, @unchecked Sendable {
    private let error: any Error
    private let lock = NSLock()
    private var saveCount = 0
    init(error: any Error) { self.error = error }
    var saves: Int { lock.withLock { saveCount } }
    func load() throws -> Int? { throw error }
    func save(_ version: Int) { lock.withLock { saveCount += 1 } }
}
