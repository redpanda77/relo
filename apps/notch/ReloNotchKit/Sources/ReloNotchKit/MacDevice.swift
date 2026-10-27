import Foundation
import ReloCore

/// This Mac as an owner device: what it registers with. The hardware model is the real one
/// ("Mac16,1"); `uname` says "arm64", which the server and CLI read as a simulator and never trust.
enum MacDevice {
    /// An owner overview reads the whole account like the Dashboard and is never a delivery target;
    /// it shows choice questions too.
    static let capabilities = [DeviceCapability.choiceQuestions, DeviceCapability.ownerOverview]

    static func hardwareModel() -> String {
        var size = 0
        guard sysctlbyname("hw.model", nil, &size, nil, 0) == 0, size > 0 else { return "Mac" }
        var bytes = [CChar](repeating: 0, count: size)
        guard sysctlbyname("hw.model", &bytes, &size, nil, 0) == 0 else { return "Mac" }
        let model = String(decoding: bytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        return model.isEmpty ? "Mac" : model
    }

    static func name() -> String {
        let name = Host.current().localizedName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? "Mac" : String(name.prefix(120))
    }

    static func osVersion() -> String {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        return "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
    }

    static func registrationRequest(stableDeviceId: UUID, installationId: UUID, bundle: Bundle = .main) -> DeviceRegistrationRequest {
        DeviceRegistrationRequest(
            stableDeviceId: stableDeviceId,
            installationId: installationId,
            name: name(),
            bundleIdentifier: bundle.bundleIdentifier ?? "com.example.relo.notch",
            appVersion: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
            appBuild: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0",
            osVersion: osVersion(),
            model: hardwareModel(),
            // The notch reads Now and answers; it takes no pushes and shows no Live Activities.
            apnsEnvironment: "production",
            apnsToken: nil,
            notificationAuthorization: .denied,
            liveActivityAuthorization: .denied,
            capabilities: capabilities,
            isSimulator: false
        )
    }
}
