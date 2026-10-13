import Foundation

public protocol ScopedNotificationReceiptStoring: Sendable {
    func pending(scope: ReceiptScope, limit: Int) async throws -> NotificationReceiptBatch
    func remove(records: Set<NotificationReceiptRecord>) async throws
    func retire(scope: ReceiptScope) async throws
}

public enum NotificationReceiptOutcome: Sendable { case acknowledged, notFound }
public enum NotificationReceiptRemoteError: Error, Equatable, Sendable { case unauthorized, offline, conflict, incompatible, scopeMismatch }
public protocol NotificationReceiptRemoteSource: Sendable {
    func submit(_ record: NotificationReceiptRecord) async throws -> NotificationReceiptOutcome
}

public struct ReceiptRecoveryState: Equatable, Sendable {
    public enum Issue: Equatable, Sendable { case storage, unauthorized, offline, conflict, incompatible }
    public var scope: SessionScope?
    public var acknowledged = 0
    public var retiredNotFound = 0
    public var retiredUnscoped = 0
    public var issue: Issue?
    public init() {}
}

/// At most 25 exact-scope receipts per maintenance pass. History is not an input.
