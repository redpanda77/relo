import Foundation

/// View lifetime follows the account at an origin, not a connection attempt or token.
/// Network requests and response capabilities retain their stricter authorization scopes.
public struct ReloPresentationScope: Equatable, Sendable {
    public let serverOrigin: String
    public let accountID: String

    public init(serverOrigin: String, account: AccountSummary?, session: AccountSession?,
                credential: DeviceCredential?, user: AccountUser?) {
        self.serverOrigin = serverOrigin
        accountID = account?.accountId ?? session?.account?.accountId
            ?? credential?.accountId ?? user?.id ?? "none"
    }

    public var identity: String { "\(serverOrigin)|\(accountID)" }
}
