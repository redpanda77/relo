import Foundation

public protocol DiagnosticSink: Sendable {
    func record(_ event: OperationDiagnostic) async
}

public struct DiagnosticSnapshot: Codable, Equatable, Sendable {
    public let events: [OperationDiagnostic]
    public let capacity: Int
    public let persistenceUnavailable: Bool
    public init(events: [OperationDiagnostic], capacity: Int, persistenceUnavailable: Bool) {
        self.events = events; self.capacity = capacity; self.persistenceUnavailable = persistenceUnavailable
    }
}

public protocol DiagnosticStoring: DiagnosticSink {
    func snapshot() async -> DiagnosticSnapshot
}

public struct NoopDiagnosticStore: DiagnosticStoring {
    public init() {}
    public func record(_ event: OperationDiagnostic) async {}
    public func snapshot() async -> DiagnosticSnapshot {
        .init(events: [], capacity: 500, persistenceUnavailable: false)
    }
}
