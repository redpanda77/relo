import Foundation

/// Friendly names for Apple hardware: "iPhone18,4" → "iPhone Air". Since iOS 16 `UIDevice.name` is just
/// "iPhone", so the marketing name is what tells two phones apart on the Devices screen.
public enum ReloDeviceModelName {
    /// The hardware this process runs on: the machine identifier (on the Simulator, the simulated
    /// model's, not the Mac's "arm64") and whether it is a simulator.
    public static func current(environment: [String: String] = ProcessInfo.processInfo.environment) -> (identifier: String, isSimulator: Bool) {
        #if targetEnvironment(simulator)
        let simulated = environment["SIMULATOR_MODEL_IDENTIFIER"].flatMap { $0.isEmpty ? nil : $0 }
        return (simulated ?? machineIdentifier(), true)
        #else
        return (machineIdentifier(), false)
        #endif
    }

    private static func machineIdentifier() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafePointer(to: &info.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
    }

    /// The name this device registers with: the system name unless it is the generic "iPhone" or
    /// "iPad", then the marketing name ("iPhone Air").
    public static func deviceName(systemName: String, identifier: String) -> String {
        let trimmed = systemName.trimmingCharacters(in: .whitespacesAndNewlines)
        let generic: Set<String> = ["", "iphone", "ipad", "ipod touch"]
        guard generic.contains(trimmed.lowercased()) else { return trimmed }
        return marketingName(for: identifier) ?? (trimmed.isEmpty ? "iPhone" : trimmed)
    }

    /// The model line for a row: "iPhone Air", "iPhone Air · Simulator", "Simulator"; nil when nothing
    /// useful is known. Raw identifiers from older builds ("iPhone19,7", "arm64") are translated too.
    public static func displayModel(_ model: String?, isSimulator: Bool? = nil) -> String? {
        let raw = (model ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        // Older builds sent the Mac's architecture from the Simulator.
        let hostArchitecture = ["arm64", "x86_64", "i386"].contains(raw)
        let simulator = isSimulator == true || hostArchitecture
        let name = hostArchitecture ? nil : friendly(raw)
        switch (name, simulator) {
        case (let name?, true): return "\(name) · Simulator"
        case (let name?, false): return name
        case (nil, true): return "Simulator"
        case (nil, false): return nil
        }
    }

    /// A marketing name for a known identifier, the family ("iPhone") for an unknown Apple one, the
    /// text itself for anything else (already friendly), nil for empty.
    static func friendly(_ raw: String) -> String? {
        guard !raw.isEmpty else { return nil }
        if let known = marketingName(for: raw) { return known }
        for family in ["iPhone", "iPad", "iPod"] where raw.range(of: "^\(family)\\d+,\\d+$", options: .regularExpression) != nil {
            return family == "iPod" ? "iPod touch" : family
        }
        return raw
    }

    public static func marketingName(for identifier: String) -> String? { names[identifier] }

    private static let names: [String: String] = [
        "iPhone10,1": "iPhone 8", "iPhone10,4": "iPhone 8",
        "iPhone10,2": "iPhone 8 Plus", "iPhone10,5": "iPhone 8 Plus",
        "iPhone10,3": "iPhone X", "iPhone10,6": "iPhone X",
        "iPhone11,2": "iPhone XS", "iPhone11,4": "iPhone XS Max", "iPhone11,6": "iPhone XS Max", "iPhone11,8": "iPhone XR",
        "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max",
        "iPhone12,8": "iPhone SE",
        "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
        "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max", "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13",
        "iPhone14,6": "iPhone SE", "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
        "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max", "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus",
        "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
        "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max", "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus",
        "iPhone17,5": "iPhone 16e",
        "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max", "iPhone18,3": "iPhone 17", "iPhone18,4": "iPhone Air",
        "iPhone18,5": "iPhone 17e",
        // 2026 models, from public device lists (not an Apple source), as on the server.
        "iPhone19,2": "iPhone 18 Pro", "iPhone19,3": "iPhone 18 Pro Max", "iPhone19,7": "iPhone 18 Pro Max",
        "iPad13,18": "iPad", "iPad13,19": "iPad", "iPad15,7": "iPad", "iPad15,8": "iPad",
        "iPad14,1": "iPad mini", "iPad14,2": "iPad mini", "iPad16,1": "iPad mini", "iPad16,2": "iPad mini",
        "iPad13,16": "iPad Air", "iPad13,17": "iPad Air",
        "iPad14,8": "iPad Air 11-inch", "iPad14,9": "iPad Air 11-inch", "iPad14,10": "iPad Air 13-inch", "iPad14,11": "iPad Air 13-inch",
        "iPad15,3": "iPad Air 11-inch", "iPad15,4": "iPad Air 11-inch", "iPad15,5": "iPad Air 13-inch", "iPad15,6": "iPad Air 13-inch",
        "iPad16,8": "iPad Air 11-inch", "iPad16,9": "iPad Air 11-inch", "iPad16,10": "iPad Air 13-inch", "iPad16,11": "iPad Air 13-inch",
        "iPad14,3": "iPad Pro 11-inch", "iPad14,4": "iPad Pro 11-inch", "iPad14,5": "iPad Pro 12.9-inch", "iPad14,6": "iPad Pro 12.9-inch",
        "iPad16,3": "iPad Pro 11-inch", "iPad16,4": "iPad Pro 11-inch", "iPad16,5": "iPad Pro 13-inch", "iPad16,6": "iPad Pro 13-inch",
        "iPad17,1": "iPad Pro 11-inch", "iPad17,2": "iPad Pro 11-inch", "iPad17,3": "iPad Pro 13-inch", "iPad17,4": "iPad Pro 13-inch",
    ]
}
