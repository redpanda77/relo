//
//  SystemSensors.swift
//  Relo Notch
//
//  What the System tab reads beyond the kernel's counters: the CPU's temperature (the SMC), each core group's clock
//  speed (IOReport), swap and memory pressure (sysctl), the busiest apps (proc_pid_rusage) and the time left on
//  battery. Read-only throughout: nothing here writes to the SMC. The SMC and IOReport readers follow Atoll's
//  (https://github.com/Ebullioscopic/Atoll, GPL-3.0), which follow the Stats project's readers.
//

import Darwin
import Foundation
import IOKit
import IOKit.ps

// MARK: Temperature

/// Read-only access to the System Management Controller, for the CPU's temperature sensors.
final class SMCReader {
    private var connection: io_connect_t = 0
    /// The sensors this Mac answers, found once: the key names differ by chip family.
    private var keys: [String] = []

    private struct Version { var major: UInt8 = 0, minor: UInt8 = 0, build: UInt8 = 0, reserved: UInt8 = 0; var release: UInt16 = 0 }
    private struct PowerLimit { var version: UInt16 = 0, length: UInt16 = 0; var cpu: UInt32 = 0, gpu: UInt32 = 0, memory: UInt32 = 0 }
    private struct KeyInfo { var dataSize: UInt32 = 0; var dataType: UInt32 = 0; var attributes: UInt8 = 0 }
    /// The kernel's SMCKeyData_t, field for field.
    private struct KeyData {
        var key: UInt32 = 0
        var version = Version()
        var powerLimit = PowerLimit()
        var keyInfo = KeyInfo()
        var padding: UInt16 = 0
        var result: UInt8 = 0
        var status: UInt8 = 0
        var data8: UInt8 = 0
        var data32: UInt32 = 0
        var bytes: (UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
                    UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8)
            = (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    }

    init() {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSMC"))
        guard service != 0 else { return }
        defer { IOObjectRelease(service) }
        guard IOServiceOpen(service, mach_task_self_, 0, &connection) == kIOReturnSuccess else { connection = 0; return }
        keys = Self.candidates(for: SystemSensors.chipName).filter { plausible(read($0)) }
    }

    deinit { if connection != 0 { IOServiceClose(connection) } }

    /// The CPU's temperature in °C: the mean of its core sensors, nil where the SMC answers none.
    func cpuTemperature() -> Double? {
        let values = keys.compactMap(read).filter(plausible)
        return values.isEmpty ? nil : values.reduce(0, +) / Double(values.count)
    }

    private func plausible(_ value: Double?) -> Bool { value.map { $0 > 10 && $0 < 115 } ?? false }

    /// The CPU core sensors per chip family (Atoll's lists); Intel Macs answer TC0P and its kin.
    private static func candidates(for chip: String) -> [String] {
        let name = chip.lowercased()
        if name.contains("m1") { return ["Tp09", "Tp0T", "Tp01", "Tp05", "Tp0D", "Tp0H", "Tp0L", "Tp0P", "Tp0X", "Tp0b"] }
        if name.contains("m2") { return ["Tp1h", "Tp1t", "Tp1p", "Tp1l", "Tp01", "Tp05", "Tp09", "Tp0D", "Tp0X", "Tp0b", "Tp0f", "Tp0j"] }
        if name.contains("m3") {
            return ["Te05", "Te0L", "Te0P", "Te0S", "Tf04", "Tf09", "Tf0A", "Tf0B", "Tf0D", "Tf0E", "Tf44", "Tf49", "Tf4A", "Tf4B", "Tf4D", "Tf4E"]
        }
        if name.contains("m4") { return ["Te05", "Te09", "Te0H", "Te0S", "Tp01", "Tp05", "Tp09", "Tp0D", "Tp0V", "Tp0Y", "Tp0b", "Tp0e"] }
        if name.contains("m5") {
            return ["Tp00", "Tp04", "Tp08", "Tp0C", "Tp0G", "Tp0K", "Tp0O", "Tp0R", "Tp0U", "Tp0X", "Tp0a", "Tp0d", "Tp0g", "Tp0j", "Tp0m", "Tp0p", "Tp0u", "Tp0y"]
        }
        return ["TC0P", "TC0E", "TC0F", "TC0H", "TC0D"]
    }

    private func read(_ key: String) -> Double? {
        guard connection != 0, key.utf8.count == 4 else { return nil }
        var input = KeyData()
        var output = KeyData()
        input.key = Self.fourCharCode(key)
        input.data8 = 9 // read the key's info
        guard call(&input, &output) else { return nil }
        // The type comes with the key's info; the bytes call answers without it.
        let type = output.keyInfo.dataType
        input.keyInfo.dataSize = output.keyInfo.dataSize
        input.data8 = 5 // read the key's bytes
        guard call(&input, &output) else { return nil }
        let bytes = withUnsafeBytes(of: output.bytes) { Array($0.prefix(4)) }
        if type == Self.fourCharCode("flt ") {
            return Double(bytes.withUnsafeBytes { $0.load(as: Float.self) })
        }
        if type == Self.fourCharCode("sp78") {
            return Double(Int16(bitPattern: UInt16(bytes[0]) << 8 | UInt16(bytes[1]))) / 256
        }
        return nil
    }

    private func call(_ input: inout KeyData, _ output: inout KeyData) -> Bool {
        var size = MemoryLayout<KeyData>.stride
        return IOConnectCallStructMethod(connection, 2, &input, MemoryLayout<KeyData>.stride, &output, &size) == kIOReturnSuccess
            && output.result == 0
    }

    private static func fourCharCode(_ text: String) -> UInt32 { text.utf8.reduce(0) { $0 << 8 | UInt32($1) } }
}

// MARK: Clock speed

/// Each core group's clock speed from IOReport's performance-state residency: the time-weighted mean of the speeds
/// the group ran at while active. IOReport is a private library, opened at run time; without it there are no clocks.
final class ClockReader {
    struct Clocks: Equatable {
        var performance: Double?        // GHz
        var efficiency: Double?
        var performanceMax: Double?
    }

    private typealias CopyChannels = @convention(c) (CFString?, CFString?, UInt64, UInt64, UInt64) -> Unmanaged<CFMutableDictionary>?
    private typealias Subscribe = @convention(c) (UnsafeMutableRawPointer?, CFMutableDictionary, UnsafeMutablePointer<Unmanaged<CFMutableDictionary>?>?, UInt64, CFTypeRef?) -> OpaquePointer?
    private typealias Sample = @convention(c) (OpaquePointer, CFMutableDictionary, CFTypeRef?) -> Unmanaged<CFDictionary>?
    private typealias Delta = @convention(c) (CFDictionary, CFDictionary, CFTypeRef?) -> Unmanaged<CFDictionary>?
    private typealias Name = @convention(c) (CFDictionary) -> Unmanaged<CFString>?
    private typealias StateCount = @convention(c) (CFDictionary) -> Int32
    private typealias StateName = @convention(c) (CFDictionary, Int32) -> Unmanaged<CFString>?
    private typealias Residency = @convention(c) (CFDictionary, Int32) -> Int64

    private var sample: Sample?, delta: Delta?, channelName: Name?, stateCount: StateCount?, stateName: StateName?, residency: Residency?
    private var subscription: OpaquePointer?
    private var channels: CFMutableDictionary?
    private var previous: CFDictionary?
    private let efficiencySpeeds: [Double]      // MHz per performance state
    private let performanceSpeeds: [Double]

    init() {
        (efficiencySpeeds, performanceSpeeds) = Self.speedTables()
        guard let library = dlopen("/usr/lib/libIOReport.dylib", RTLD_NOW) else { return }
        func symbol<T>(_ name: String, _ type: T.Type) -> T? { dlsym(library, name).map { unsafeBitCast($0, to: type) } }
        guard let copy = symbol("IOReportCopyChannelsInGroup", CopyChannels.self),
              let subscribe = symbol("IOReportCreateSubscription", Subscribe.self) else { return }
        sample = symbol("IOReportCreateSamples", Sample.self)
        delta = symbol("IOReportCreateSamplesDelta", Delta.self)
        channelName = symbol("IOReportChannelGetChannelName", Name.self)
        stateCount = symbol("IOReportStateGetCount", StateCount.self)
        stateName = symbol("IOReportStateGetNameForIndex", StateName.self)
        residency = symbol("IOReportStateGetResidency", Residency.self)
        guard let found = copy("CPU Stats" as CFString, "CPU Complex Performance States" as CFString, 0, 0, 0)?.takeRetainedValue() else { return }
        var created: Unmanaged<CFMutableDictionary>?
        subscription = subscribe(nil, found, &created, 0, nil)
        created?.release()
        channels = found
    }

    /// The clocks since the last call; the first call only sets the baseline.
    func read() -> Clocks? {
        guard let subscription, let channels, let sample, let delta,
              let current = sample(subscription, channels, nil)?.takeRetainedValue() else { return nil }
        defer { previous = current }
        guard let previous, let difference = delta(previous, current, nil)?.takeRetainedValue(),
              let entries = (difference as NSDictionary)["IOReportChannels"] as? [NSDictionary] else { return nil }
        var efficiency: [Double] = [], performance: [Double] = []
        for entry in entries {
            let item = entry as CFDictionary
            guard let name = channelName?(item)?.takeUnretainedValue() as String? else { continue }
            if name.hasPrefix("ECPU"), let speed = speed(item, efficiencySpeeds) { efficiency.append(speed) }
            if name.hasPrefix("PCPU"), let speed = speed(item, performanceSpeeds) { performance.append(speed) }
        }
        func mean(_ values: [Double]) -> Double? { values.isEmpty ? nil : values.reduce(0, +) / Double(values.count) / 1000 }
        return Clocks(performance: mean(performance), efficiency: mean(efficiency), performanceMax: performanceSpeeds.max().map { $0 / 1000 })
    }

    /// The residency-weighted speed over the active states (those after IDLE, DOWN and OFF), in MHz.
    private func speed(_ channel: CFDictionary, _ table: [Double]) -> Double? {
        guard !table.isEmpty, let stateCount, let stateName, let residency else { return nil }
        let count = stateCount(channel)
        var first: Int32?
        for index in 0..<count {
            let name = stateName(channel, index)?.takeUnretainedValue() as String? ?? ""
            if !["IDLE", "DOWN", "OFF"].contains(name) { first = index; break }
        }
        guard let first else { return nil }
        var active = 0.0, weighted = 0.0
        for (offset, mhz) in table.enumerated() {
            let index = first + Int32(offset)
            guard index < count else { break }
            let time = Double(residency(channel, index))
            active += time
            weighted += time * mhz
        }
        return active > 0 ? weighted / active : nil
    }

    /// The speed of each performance state, from the power manager's voltage-state tables (E cores in table 1, P
    /// cores in table 5). Each entry is 8 bytes, the speed first, in Hz on M1 to M3 and kHz from M4.
    private static func speedTables() -> ([Double], [Double]) {
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("AppleARMIODevice"), &iterator) == KERN_SUCCESS else { return ([], []) }
        defer { IOObjectRelease(iterator) }
        var efficiency: [Double] = [], performance: [Double] = []
        while case let service = IOIteratorNext(iterator), service != 0 {
            defer { IOObjectRelease(service) }
            var name = [CChar](repeating: 0, count: 128)
            guard IORegistryEntryGetName(service, &name) == KERN_SUCCESS, String(cString: name) == "pmgr" else { continue }
            func table(_ key: String) -> [Double] {
                guard let data = IORegistryEntryCreateCFProperty(service, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? Data else { return [] }
                return stride(from: 0, to: data.count - 3, by: 8).compactMap { start -> Double? in
                    let raw = data[data.startIndex + start ..< data.startIndex + start + 4].reversed().reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
                    guard raw > 0 else { return nil }
                    return raw > 100_000_000 ? Double(raw) / 1_000_000 : Double(raw) / 1000
                }
            }
            efficiency = table("voltage-states1-sram")
            performance = table("voltage-states5-sram")
        }
        return (efficiency, performance)
    }
}

// MARK: Apps

/// The apps using the most CPU (as a share of the whole Mac since the last call) and the most memory. Helper
/// processes count toward the app that contains them, so Xcode's compilers and Chrome's renderers add up.
final class AppActivity {
    struct Share: Equatable { var name: String; var value: Double }

    private var previousTimes: [pid_t: UInt64] = [:]
    private var previousAt: UInt64 = 0
    private var names: [pid_t: String] = [:]
    private let nanosecondsPerTick: Double = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return Double(info.numer) / Double(info.denom)
    }()

    func read(cores: Int) -> (busiest: [Share], biggest: Share?) {
        let capacity = proc_listallpids(nil, 0)
        guard capacity > 0 else { return ([], nil) }
        var pids = [pid_t](repeating: 0, count: Int(capacity) + 64)
        let found = Int(proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.stride)))
        let now = mach_absolute_time()
        var times: [pid_t: UInt64] = [:]
        var cpu: [String: Double] = [:]
        var memory: [String: Double] = [:]
        for pid in pids.prefix(max(0, found)) where pid > 0 {
            var info = rusage_info_v4()
            let result = withUnsafeMutablePointer(to: &info) {
                $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
            }
            guard result == 0 else { continue }
            let name = appName(pid)
            let time = info.ri_user_time &+ info.ri_system_time
            times[pid] = time
            if let before = previousTimes[pid], time >= before { cpu[name, default: 0] += Double(time - before) }
            memory[name, default: 0] += Double(info.ri_phys_footprint)
        }
        let elapsed = Double(now &- previousAt) * nanosecondsPerTick * Double(max(1, cores))
        let first = previousAt == 0
        previousTimes = times
        previousAt = now
        names = names.filter { times[$0.key] != nil }
        let busiest = first || elapsed <= 0 ? [] : cpu
            .map { Share(name: $0.key, value: $0.value * nanosecondsPerTick / elapsed) }
            .sorted { $0.value > $1.value }
            .prefix(3)
        let biggest = memory.max { $0.value < $1.value }.map { Share(name: $0.key, value: $0.value) }
        return (Array(busiest), biggest)
    }

    /// The outermost app bundle on the process's path ("Xcode" for swift-frontend inside Xcode.app), else its file name.
    private func appName(_ pid: pid_t) -> String {
        if let name = names[pid] { return name }
        var buffer = [CChar](repeating: 0, count: 4096)
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        var name = "pid \(pid)"
        if length > 0 {
            let parts = String(cString: buffer).split(separator: "/")
            if let app = parts.first(where: { $0.hasSuffix(".app") }) { name = String(app.dropLast(4)) } else if let last = parts.last { name = String(last) }
        }
        names[pid] = name
        return name
    }
}

// MARK: The rest

enum SystemSensors {
    /// "Apple M4 Pro", or the Intel brand string.
    static let chipName: String = sysctlString("machdep.cpu.brand_string") ?? ""
    /// Efficiency cores come first in the kernel's core order; 0 on a Mac with one kind of core.
    static let efficiencyCores: Int = sysctlInt("hw.perflevel1.logicalcpu") ?? 0

    /// Swap in use, in bytes.
    static func swapUsed() -> UInt64 {
        var usage = xsw_usage()
        var size = MemoryLayout<xsw_usage>.size
        return sysctlbyname("vm.swapusage", &usage, &size, nil, 0) == 0 ? usage.xsu_used : 0
    }

    /// The kernel's memory pressure: 1 normal, 2 warning, 4 critical.
    static func memoryPressure() -> Int { sysctlInt("kern.memorystatus_vm_pressure_level") ?? 1 }

    /// Whether the Mac runs on its battery, and the minutes it estimates are left (nil while it is still estimating).
    static func batteryPower() -> (onBattery: Bool, minutesLeft: Int?) {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let source = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String? else { return (false, nil) }
        guard source == "Battery Power" else { return (false, nil) }
        let seconds = IOPSGetTimeRemainingEstimate()
        return (true, seconds > 0 ? Int(seconds / 60) : nil)
    }

    private static func sysctlInt(_ name: String) -> Int? {
        var value: Int32 = 0
        var size = MemoryLayout<Int32>.size
        return sysctlbyname(name, &value, &size, nil, 0) == 0 ? Int(value) : nil
    }

    private static func sysctlString(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buffer = [CChar](repeating: 0, count: size)
        return sysctlbyname(name, &buffer, &size, nil, 0) == 0 ? String(cString: buffer) : nil
    }
}
