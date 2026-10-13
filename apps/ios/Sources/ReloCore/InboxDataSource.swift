import Foundation

/// Account/device-bound inbox operations; construction performs no I/O.
public protocol InboxDataSource: InboxHistoryRemoteDataSource, InboxSnapshotRemoteDataSource, ReadItemsRemoteSource {
    func fetchDetail(notificationID: String) async throws -> InboxNotificationDetail
    func fetchActiveLiveActivities() async throws -> ActiveLiveActivityIdentityPage
}
