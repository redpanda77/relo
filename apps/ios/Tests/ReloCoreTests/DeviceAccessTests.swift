import Foundation
import XCTest
@testable import ReloCore

final class DeviceAccessTests: XCTestCase {
    func testMarketingNamesForKnownIdentifiers() {
        XCTAssertEqual(ReloDeviceModelName.marketingName(for: "iPhone18,4"), "iPhone Air")
        XCTAssertEqual(ReloDeviceModelName.marketingName(for: "iPhone17,1"), "iPhone 16 Pro")
        XCTAssertEqual(ReloDeviceModelName.marketingName(for: "iPhone10,6"), "iPhone X")
        XCTAssertEqual(ReloDeviceModelName.marketingName(for: "iPad16,6"), "iPad Pro 13-inch")
        XCTAssertNil(ReloDeviceModelName.marketingName(for: "iPhone99,1"))
    }

    func testDisplayModelSaysSimulatorAndTranslatesOlderBuilds() {
        XCTAssertEqual(ReloDeviceModelName.displayModel("iPhone18,4"), "iPhone Air")
        XCTAssertEqual(ReloDeviceModelName.displayModel("iPhone18,4", isSimulator: true), "iPhone Air · Simulator")
        XCTAssertEqual(ReloDeviceModelName.displayModel("arm64"), "Simulator")
        XCTAssertEqual(ReloDeviceModelName.displayModel("x86_64", isSimulator: nil), "Simulator")
        XCTAssertEqual(ReloDeviceModelName.displayModel("iPhone19,7"), "iPhone 18 Pro Max")
        XCTAssertEqual(ReloDeviceModelName.displayModel("iPhone99,1"), "iPhone", "an unknown future model says iPhone")
        XCTAssertEqual(ReloDeviceModelName.displayModel("iPad99,1"), "iPad")
        XCTAssertEqual(ReloDeviceModelName.displayModel("iPad Pro"), "iPad Pro")
        XCTAssertNil(ReloDeviceModelName.displayModel(nil))
        XCTAssertNil(ReloDeviceModelName.displayModel("  "))
        XCTAssertEqual(ReloDeviceModelName.displayModel(nil, isSimulator: true), "Simulator")
    }

    func testRegisteredNameReplacesOnlyTheGenericSystemName() {
        XCTAssertEqual(ReloDeviceModelName.deviceName(systemName: "iPhone", identifier: "iPhone18,4"), "iPhone Air")
        XCTAssertEqual(ReloDeviceModelName.deviceName(systemName: "", identifier: "iPhone18,1"), "iPhone 17 Pro")
        XCTAssertEqual(ReloDeviceModelName.deviceName(systemName: "Work iPhone", identifier: "iPhone18,4"), "Work iPhone")
        XCTAssertEqual(ReloDeviceModelName.deviceName(systemName: "iPhone", identifier: "iPhone99,1"), "iPhone")
        XCTAssertEqual(ReloDeviceModelName.deviceName(systemName: "", identifier: "arm64"), "iPhone")
    }

    func testCurrentHardwareOnTheTestHost() {
        let hardware = ReloDeviceModelName.current(environment: ["SIMULATOR_MODEL_IDENTIFIER": "iPhone18,4"])
        XCTAssertFalse(hardware.identifier.isEmpty)
        #if targetEnvironment(simulator)
        XCTAssertTrue(hardware.isSimulator)
        XCTAssertEqual(hardware.identifier, "iPhone18,4")
        #else
        XCTAssertFalse(hardware.isSimulator)
        #endif
    }

    func testAccessRequestDeepLinkRoundTrips() throws {
        let phone = "dev_00000000-0000-4000-8000-0000000000bb"
        let computer = "key_00000000-0000-4000-8000-0000000000cc"
        let url = try XCTUnwrap(ReloDeepLink.accessRequestURL(id: phone))
        XCTAssertEqual(url.absoluteString, "relo://security/request/\(phone)")
        XCTAssertEqual(ReloDeepLink.accessRequestID(from: url), phone)
        XCTAssertEqual(ReloDeepLink.accessRequestID(from: try XCTUnwrap(ReloDeepLink.accessRequestURL(id: computer))), computer)
        XCTAssertEqual(ReloDeepLink.accessRequestID(relo: ["deepLink": url.absoluteString]), phone)
        XCTAssertEqual(ReloDeepLink.accessRequestID(relo: ["destination": url.absoluteString]), phone)
        XCTAssertNil(ReloDeepLink.accessRequestID(relo: ["deepLink": "relo://settings/security"]))
        XCTAssertNotNil(ReloDeepLink.accessRequestURL(id: "brw_00000000-0000-4000-8000-0000000000cc"))
        XCTAssertNil(ReloDeepLink.accessRequestURL(id: "web_00000000-0000-4000-8000-0000000000cc"))
        XCTAssertNil(ReloDeepLink.accessRequestURL(id: "dev_../keys"))
        for bad in ["https://security/request/\(phone)", "relo://security/request/\(phone)?x=1",
                    "relo://security/request", "relo://security/other/\(phone)", "relo://settings/request/\(phone)",
                    "relo://security/request/\(phone)/more"] {
            XCTAssertNil(ReloDeepLink.accessRequestID(from: try XCTUnwrap(URL(string: bad))), bad)
        }
        // The old link still opens the Devices screen.
        XCTAssertTrue(ReloDeepLink.isSecuritySettings(ReloDeepLink.securitySettingsURL))
        XCTAssertNil(ReloDeepLink.accessRequestID(from: ReloDeepLink.securitySettingsURL))
    }

    func testThisPhoneStatusLine() {
        func status(signedIn: Bool = true, problem: String? = nil, ready: Bool = true, trusted: Bool? = true, computers: Int = 1) -> ReloThisPhoneStatus {
            .make(signedIn: signedIn, keysProblem: problem, keysReady: ready, selfTrusted: trusted, trustedComputers: computers)
        }
        XCTAssertEqual(status(signedIn: false), .signedOut)
        XCTAssertEqual(status(problem: "The server refused this iPhone's keys. Sign in again."),
                       .keysProblem("The server refused this iPhone's keys. Sign in again."))
        XCTAssertEqual(status(ready: false), .settingUp)
        XCTAssertEqual(status(trusted: false), .waitingForApproval)
        XCTAssertEqual(status(trusted: false).line, "Waiting for approval. Approve this iPhone on your other iPhone.")
        XCTAssertEqual(status().line, "Your computers can send encrypted cards to this iPhone.")
        XCTAssertEqual(status(trusted: nil).line, "Your computers can send encrypted cards to this iPhone.")
        XCTAssertEqual(status(computers: 0).line, "Encrypted cards will come here once a computer signs in.")
        XCTAssertTrue(status().isGood)
        XCTAssertFalse(status(trusted: false).isGood)
    }

    func testRegistrationAndHeartbeatCarryTheSimulatorFlagOnlyWhenSet() throws {
        func registration(_ isSimulator: Bool?) -> DeviceRegistrationRequest {
            DeviceRegistrationRequest(
                stableDeviceId: UUID(), installationId: UUID(), name: "iPhone Air", bundleIdentifier: "com.example.relo",
                appVersion: "1", appBuild: "1", osVersion: "26.0", model: "iPhone18,4", apnsEnvironment: "sandbox",
                notificationAuthorization: .authorized, liveActivityAuthorization: .authorized, isSimulator: isSimulator)
        }
        let flagged = try JSONSerialization.jsonObject(with: JSONEncoder().encode(registration(true))) as? [String: Any]
        XCTAssertEqual(flagged?["isSimulator"] as? Bool, true)
        let plain = try JSONSerialization.jsonObject(with: JSONEncoder().encode(registration(nil))) as? [String: Any]
        XCTAssertNil(plain?["isSimulator"])
        let decoded = try JSONDecoder().decode(DeviceRegistrationRequest.self, from: JSONEncoder().encode(registration(false)))
        XCTAssertEqual(decoded.isSimulator, false)

        let heartbeat = DeviceHeartbeat(
            deviceId: "dev_x", installationId: UUID(), deviceName: "iPhone Air", bundleId: "com.example.relo", appVersion: "1",
            appBuild: "1", iosVersion: "26.0", deviceModel: "iPhone18,4", apnsToken: "token", apnsEnvironment: "sandbox",
            notificationAuthorization: .authorized, liveActivityAuthorization: .authorized, model: "iPhone18,4", isSimulator: true)
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(heartbeat)) as? [String: Any]
        XCTAssertEqual(object?["model"] as? String, "iPhone18,4")
        XCTAssertEqual(object?["isSimulator"] as? Bool, true)
    }
}
