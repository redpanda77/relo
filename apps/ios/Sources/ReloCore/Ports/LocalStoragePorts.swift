import Foundation

public enum CredentialStoreError: Error, Equatable {
    case keychain(OSStatus)
    case invalidData
}

public enum LocalStoragePreflightError: Error, Equatable {
    case protectedAccountSessionUnreadable
    case protectedDeviceCredentialUnreadable
    case protectedStableDeviceIDUnreadable
    case protectedInstallationIDUnreadable
    case durableSignOutProgressUnreadable
}

public protocol LocalStoragePreflighting: Sendable {
    func run() throws
    func resetDeviceRegistrationState() throws
}

public struct NoopLocalStoragePreflight: LocalStoragePreflighting {
    public init() {}
    public func run() throws {}
    public func resetDeviceRegistrationState() throws {}
}

public protocol LocalStorageSchemaMarker: Sendable {
    func load() throws -> Int?
    func save(_ version: Int) throws
}
