import Foundation

/// What the System tab leads with. At rest it is the CPU, grey; when a measure is under pressure it takes the lead,
/// in the one attention colour, and its title says why in words. The most urgent measure leads (heat, then memory,
/// battery, disk, a busy CPU); any other measure under pressure stays a row with its value marked.
public enum SystemFocus: Equatable, Sendable {
    case atRest, cpuBusy, hot, memoryTight, batteryLow, diskFull

    /// The measure this focus is about: the CPU at rest, busy or hot.
    public var measure: SystemMeasure {
        switch self {
        case .atRest, .cpuBusy, .hot: .cpu
        case .memoryTight: .memory
        case .batteryLow: .battery
        case .diskFull: .disk
        }
    }
}

public enum SystemMeasure: Hashable, Sendable { case cpu, memory, disk, network, battery }

/// The readings the choice needs, already sampled.
public struct SystemReadings: Equatable, Sendable {
    /// Seconds the CPU has stayed over the busy line; nil while it is under it.
    public var cpuBusyFor: TimeInterval?
    /// `ProcessInfo.ThermalState` as its raw value: 0 nominal, 1 fair, 2 serious, 3 critical.
    public var thermal: Int
    /// `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical.
    public var memoryPressure: Int
    public var onBattery: Bool
    /// 0...1, nil on a Mac without a battery.
    public var battery: Double?
    public var diskFree: Int64

    public init(cpuBusyFor: TimeInterval? = nil, thermal: Int = 0, memoryPressure: Int = 1, onBattery: Bool = false,
                battery: Double? = nil, diskFree: Int64 = .max) {
        self.cpuBusyFor = cpuBusyFor
        self.thermal = thermal
        self.memoryPressure = memoryPressure
        self.onBattery = onBattery
        self.battery = battery
        self.diskFree = diskFree
    }
}

public enum SystemAttention {
    /// The CPU is busy over this share, and stops being busy under `quietLine` (so it does not flicker at the line).
    public static let busyLine = 0.8
    public static let quietLine = 0.7
    /// A busy CPU leads only after this long: a build's first seconds are not news.
    public static let busyAfter: TimeInterval = 30
    public static let batteryLow = 0.2
    public static let diskLow: Int64 = 10_000_000_000

    /// Every measure under pressure, most urgent first.
    public static func pressured(_ readings: SystemReadings) -> [SystemFocus] {
        var focus: [SystemFocus] = []
        if readings.thermal >= 2 { focus.append(.hot) }
        if readings.memoryPressure >= 2 { focus.append(.memoryTight) }
        if readings.onBattery, let level = readings.battery, level < batteryLow { focus.append(.batteryLow) }
        if readings.diskFree < diskLow { focus.append(.diskFull) }
        if let busy = readings.cpuBusyFor, busy >= busyAfter, !focus.contains(.hot) { focus.append(.cpuBusy) }
        return focus
    }

    /// The one measure the tab leads with.
    public static func focus(_ readings: SystemReadings) -> SystemFocus {
        pressured(readings).first ?? .atRest
    }

    /// Measures shown as rows whose value is marked: under pressure, but not the one leading.
    public static func markedRows(_ readings: SystemReadings) -> Set<SystemMeasure> {
        Set(pressured(readings).dropFirst().map(\.measure))
    }

    /// The lead's title in words: "CPU busy for 2 min", "Battery low".
    public static func title(_ focus: SystemFocus, for seconds: TimeInterval?) -> String {
        let lasting = seconds.map { " for " + duration($0) } ?? ""
        switch focus {
        case .atRest: return "CPU"
        case .cpuBusy: return "CPU busy" + lasting
        case .hot: return "CPU hot" + lasting
        case .memoryTight: return "Memory tight" + lasting
        case .batteryLow: return "Battery low"
        case .diskFull: return "Disk almost full"
        }
    }

    /// "40 s" under a minute (in tens), "2 min" under an hour, then "1 h".
    public static func duration(_ seconds: TimeInterval) -> String {
        let seconds = max(0, seconds)
        if seconds < 60 { return "\(max(10, Int(seconds / 10) * 10)) s" }
        if seconds < 3600 { return "\(Int(seconds / 60)) min" }
        return "\(Int(seconds / 3600)) h"
    }

    /// The busiest apps in words: "Mostly Xcode (61%) and Safari (12%)". Shares are of the whole Mac, 0...1; apps
    /// under 5% are left out, so a quiet second app is not named.
    public static func busiest(_ apps: [(name: String, share: Double)]) -> String? {
        let named = apps.filter { $0.share >= 0.05 }.prefix(2).map { "\($0.name) (\(Int(($0.share * 100).rounded()))%)" }
        guard let first = named.first else { return nil }
        return named.count > 1 ? "Mostly \(first) and \(named[1])" : "Mostly \(first)"
    }
}
