import XCTest
@testable import Relo

final class SettledNotificationsTests: XCTestCase {
    private let answered = "ntf_9f1c2a7e-0b3d-4c55-8e21-6a7b8c9d0e1f"
    private let pending = "ntf_1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

    func testASettlePushNamesItsNotificationsAndNothingElse() {
        let ids = SettledNotifications.ids(in: ["aps": ["content-available": 1], "relo": ["settled": [answered, "not an id"]]])
        XCTAssertEqual(ids, [answered])
        XCTAssertEqual(SettledNotifications.ids(in: ["aps": ["content-available": 1]] as [AnyHashable: Any]), [])
    }

    func testOnlyTheSettledQuestionsNotificationsAreRemoved() {
        let delivered: [(identifier: String, userInfo: [AnyHashable: Any])] = [
            (identifier: "a", userInfo: ["relo": ["notificationId": answered]]),
            (identifier: "b", userInfo: ["relo": ["notificationId": pending]]),
            (identifier: "c", userInfo: ["aps": ["alert": "No Relo payload"]]),
        ]
        XCTAssertEqual(SettledNotifications.requestIdentifiers(delivered: delivered, settled: [answered]), ["a"])
    }
}
