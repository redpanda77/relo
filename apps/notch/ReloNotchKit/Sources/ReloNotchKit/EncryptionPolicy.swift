import Foundation

/// The account's end-to-end encryption choice on a remote server (`/api/end-to-end/policy`), as Settings shows it.
/// Automatic seals once an iPhone is trusted; Always seals from the start; Off is the Dashboard's to set.
public struct EncryptionPolicy: Sendable, Equatable {
    public enum Mode: String, Sendable { case on, off, auto }
    public var mode: Mode
    public var required: Bool

    public init(mode: Mode, required: Bool) { self.mode = mode; self.required = required }

    public static func parse(_ data: Data) -> EncryptionPolicy? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let mode = (object["mode"] as? String).flatMap(Mode.init(rawValue:)) else { return nil }
        return EncryptionPolicy(mode: mode, required: object["required"] as? Bool ?? (mode == .on))
    }

    /// The body that picks Always (`true`) or Automatic (`null`); Off is never sent from the Mac.
    public static func body(always: Bool) -> Data {
        Data((always ? #"{"required":true}"# : #"{"required":null}"#).utf8)
    }

    public var title: String {
        switch mode {
        case .on: "Always"
        case .off: "Off"
        case .auto: "Automatic"
        }
    }

    public static let automaticDetail = "Automatic: on once an iPhone is trusted"
    public static let noPhoneNote = "Cards will open only on this Mac until you add an iPhone."

    /// Always with no trusted iPhone: the cards are sealed for nobody else, so only this Mac reads them.
    public func note(phoneTrusted: Bool) -> String? {
        mode == .on && !phoneTrusted ? Self.noPhoneNote : nil
    }

    /// Whether any other device of the account is a trusted iPhone, from `GET /api/devices/self/devices`. This Mac, other
    /// Macs and the Dashboard-like owner overviews (`ownerOverview`), and simulators are never one.
    public static func phoneTrusted(inDevices data: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let devices = object["devices"] as? [[String: Any]] else { return false }
        return devices.contains {
            $0["trusted"] as? Bool == true && $0["isCurrent"] as? Bool != true
                && $0["ownerOverview"] as? Bool != true && $0["isSimulator"] as? Bool != true
        }
    }
}
