//
//  SystemMonitor.swift
//  Relo Notch
//
//  The Mac's live vitals for the System tab: CPU (overall, per core, temperature and each core group's clock),
//  memory (with swap and pressure), storage, network, battery and thermal state, plus the busiest apps. It samples
//  every 2 s only while the tab is on screen, keeps two minutes of history for the charts, and picks what the tab
//  leads with (SystemAttention); nothing runs while the tab is closed.
//

import Darwin
import Foundation
import IOKit.ps
import Observation
import ReloNotchKit

@MainActor
@Observable
final class SystemMonitor {
    static let shared = SystemMonitor()

    struct Sample: Equatable {
        var cpu: Double = 0              // 0...1
        var cores: [Double] = []         // 0...1 each, efficiency cores first
        var temperature: Double?         // °C
        var clocks: ClockReader.Clocks?
        var memoryUsed: UInt64 = 0
        var memoryTotal: UInt64 = ProcessInfo.processInfo.physicalMemory
        var memoryCompressed: UInt64 = 0
        var memoryWired: UInt64 = 0
        var memoryPressure = 1
        var swapUsed: UInt64 = 0
        var storageFree: Int64 = 0
        var storageTotal: Int64 = 0
        var downBytesPerSecond: Double = 0
        var upBytesPerSecond: Double = 0
        var battery: Double?             // 0...1
        var charging = false
        var onBattery = false
        var batteryMinutesLeft: Int?
        var thermal: ProcessInfo.ThermalState = .nominal
        var busiest: [AppActivity.Share] = []   // share of the whole Mac
        var biggest: AppActivity.Share?          // bytes

        var memory: Double { memoryTotal == 0 ? 0 : Double(memoryUsed) / Double(memoryTotal) }
        var storage: Double { storageTotal == 0 ? 0 : 1 - Double(storageFree) / Double(storageTotal) }
    }

    private(set) var sample = Sample()
    /// What the tab leads with, the measures under pressure shown as rows, and how long the lead has lasted.
    private(set) var focus: SystemFocus = .atRest
    private(set) var marked: Set<SystemMeasure> = []
    private(set) var focusSeconds: TimeInterval?
    /// Two minutes at one sample per 2 s.
    private(set) var cpuHistory: [Double] = []
    private(set) var temperatureHistory: [Double] = []
    private(set) var swapHistory: [Double] = []
    private(set) var networkHistory: [Double] = []

    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var viewers = 0
    /// A snapshot shows a fixed state: sampling stays off.
    @ObservationIgnored private var previewing = false
    @ObservationIgnored private var previousTicks: [[UInt32]] = []
    @ObservationIgnored private var previousNetwork: (down: UInt64, up: UInt64, at: Date)?
    @ObservationIgnored private var storageCheckedAt: Date = .distantPast
    @ObservationIgnored private var busySince: Date?
    @ObservationIgnored private var hotSince: Date?
    @ObservationIgnored private var tightSince: Date?
    @ObservationIgnored private lazy var smc = SMCReader()
    @ObservationIgnored private lazy var clocks = ClockReader()
    @ObservationIgnored private lazy var apps = AppActivity()
    private static let historyLength = 60

    /// The tab appeared; sampling runs while at least one tab shows it.
    func start() {
        viewers += 1
        guard task == nil, !previewing else { return }
        task = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                self?.tick()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func stop() {
        viewers = max(0, viewers - 1)
        guard viewers == 0 else { return }
        task?.cancel()
        task = nil
        previousNetwork = nil
        busySince = nil
        hotSince = nil
        tightSince = nil
    }

    private func tick() {
        let now = Date()
        var next = sample
        let cores = Self.coreLoads(previous: &previousTicks)
        if !cores.isEmpty {
            next.cores = cores
            next.cpu = cores.reduce(0, +) / Double(cores.count)
        }
        next.temperature = smc.cpuTemperature()
        if let read = clocks.read() { next.clocks = read }
        if let memory = Self.memory() {
            next.memoryUsed = memory.used
            next.memoryCompressed = memory.compressed
            next.memoryWired = memory.wired
        }
        next.memoryPressure = SystemSensors.memoryPressure()
        next.swapUsed = SystemSensors.swapUsed()
        // Storage changes slowly: read it every 30 s.
        if now.timeIntervalSince(storageCheckedAt) > 30 {
            storageCheckedAt = now
            if let storage = Self.storage() { next.storageFree = storage.free; next.storageTotal = storage.total }
        }
        if let network = Self.networkBytes() {
            if let previous = previousNetwork {
                let seconds = max(0.5, now.timeIntervalSince(previous.at))
                next.downBytesPerSecond = Double(network.down &- previous.down) / seconds
                next.upBytesPerSecond = Double(network.up &- previous.up) / seconds
            }
            previousNetwork = (network.down, network.up, now)
        }
        let power = Self.battery()
        next.battery = power?.level
        next.charging = power?.charging ?? false
        let source = SystemSensors.batteryPower()
        next.onBattery = source.onBattery
        next.batteryMinutesLeft = source.minutesLeft
        next.thermal = ProcessInfo.processInfo.thermalState
        let activity = apps.read(cores: max(1, cores.count))
        next.busiest = activity.busiest
        next.biggest = activity.biggest
        sample = next
        decide(next, now)
        append(&cpuHistory, next.cpu)
        append(&temperatureHistory, next.temperature ?? 0)
        append(&swapHistory, Double(next.swapUsed))
        append(&networkHistory, next.downBytesPerSecond + next.upBytesPerSecond)
    }

    /// Tracks how long each pressure has lasted and picks the lead. A busy CPU clears only under the quiet line, so it
    /// does not flicker at the edge.
    private func decide(_ sample: Sample, _ now: Date) {
        if sample.cpu >= SystemAttention.busyLine { busySince = busySince ?? now } else if sample.cpu < SystemAttention.quietLine { busySince = nil }
        hotSince = sample.thermal.rawValue >= 2 ? (hotSince ?? now) : nil
        tightSince = sample.memoryPressure >= 2 ? (tightSince ?? now) : nil
        let readings = SystemReadings(cpuBusyFor: busySince.map { now.timeIntervalSince($0) }, thermal: sample.thermal.rawValue,
                                      memoryPressure: sample.memoryPressure, onBattery: sample.onBattery, battery: sample.battery,
                                      diskFree: sample.storageTotal > 0 ? sample.storageFree : .max)
        let lead = SystemAttention.focus(readings)
        if focus != lead { focus = lead }
        let rows = SystemAttention.markedRows(readings)
        if marked != rows { marked = rows }
        let since: Date? = switch lead {
        case .cpuBusy: busySince
        case .hot: hotSince
        case .memoryTight: tightSince
        default: nil
        }
        focusSeconds = since.map { now.timeIntervalSince($0) }
    }

    #if DEBUG
    /// Snapshot builds only: shows a fixed state in place of live sampling.
    func preview(_ sample: Sample, focus: SystemFocus, marked: Set<SystemMeasure> = [], seconds: TimeInterval? = nil,
                 cpu: [Double], temperature: [Double] = [], swap: [Double] = [], network: [Double]) {
        previewing = true
        self.sample = sample
        self.focus = focus
        self.marked = marked
        focusSeconds = seconds
        cpuHistory = cpu
        temperatureHistory = temperature
        swapHistory = swap
        networkHistory = network
    }
    #endif

    private func append(_ history: inout [Double], _ value: Double) {
        // The first reading fills the graph, so it opens as a line, not a dot at the right edge.
        if history.isEmpty { history = Array(repeating: value, count: Self.historyLength - 1) }
        history.append(value)
        if history.count > Self.historyLength { history.removeFirst(history.count - Self.historyLength) }
    }

    // MARK: Readers (Mach and BSD calls the sandbox allows)

    /// Per-core busy share since the last call, from the kernel's tick counters.
    private static func coreLoads(previous: inout [[UInt32]]) -> [Double] {
        var count: natural_t = 0
        var info: processor_info_array_t?
        var infoCount: mach_msg_type_number_t = 0
        guard host_processor_info(mach_host_self(), PROCESSOR_CPU_LOAD_INFO, &count, &info, &infoCount) == KERN_SUCCESS,
              let info else { return [] }
        defer { vm_deallocate(mach_task_self_, vm_address_t(bitPattern: info), vm_size_t(Int(infoCount) * MemoryLayout<integer_t>.stride)) }
        let states = Int(CPU_STATE_MAX)
        var ticks: [[UInt32]] = []
        for core in 0..<Int(count) {
            ticks.append((0..<states).map { UInt32(bitPattern: info[core * states + $0]) })
        }
        defer { previous = ticks }
        guard previous.count == ticks.count else { return ticks.map { _ in 0 } }
        return zip(ticks, previous).map { now, before in
            let delta = (0..<states).map { Double(now[$0] &- before[$0]) }
            let total = delta.reduce(0, +)
            guard total > 0 else { return 0 }
            return 1 - delta[Int(CPU_STATE_IDLE)] / total
        }
    }

    /// Used memory as Activity Monitor counts it: app (internal minus purgeable), wired and compressed.
    private static func memory() -> (used: UInt64, compressed: UInt64, wired: UInt64)? {
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.stride / MemoryLayout<integer_t>.stride)
        let result = withUnsafeMutablePointer(to: &stats) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        let page = UInt64(vm_kernel_page_size)
        let app = (UInt64(stats.internal_page_count) &- UInt64(stats.purgeable_count)) * page
        let wired = UInt64(stats.wire_count) * page
        let compressed = UInt64(stats.compressor_page_count) * page
        return (app + wired + compressed, compressed, wired)
    }

    private static func storage() -> (free: Int64, total: Int64)? {
        let url = URL(fileURLWithPath: "/")
        guard let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey, .volumeTotalCapacityKey]),
              let free = values.volumeAvailableCapacityForImportantUsage, let total = values.volumeTotalCapacity else { return nil }
        return (free, Int64(total))
    }

    /// Bytes in and out of the physical interfaces since boot.
    private static func networkBytes() -> (down: UInt64, up: UInt64)? {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return nil }
        defer { freeifaddrs(list) }
        var down: UInt64 = 0, up: UInt64 = 0
        var pointer: UnsafeMutablePointer<ifaddrs>? = first
        while let entry = pointer {
            defer { pointer = entry.pointee.ifa_next }
            guard let address = entry.pointee.ifa_addr, address.pointee.sa_family == UInt8(AF_LINK),
                  let data = entry.pointee.ifa_data?.assumingMemoryBound(to: if_data.self) else { continue }
            let name = String(cString: entry.pointee.ifa_name)
            guard name.hasPrefix("en") || name.hasPrefix("pdp_ip") else { continue }
            down &+= UInt64(data.pointee.ifi_ibytes)
            up &+= UInt64(data.pointee.ifi_obytes)
        }
        return (down, up)
    }

    private static func battery() -> (level: Double, charging: Bool)? {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let sources = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] else { return nil }
        for source in sources {
            guard let description = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any],
                  let current = description[kIOPSCurrentCapacityKey] as? Int,
                  let maximum = description[kIOPSMaxCapacityKey] as? Int, maximum > 0 else { continue }
            let charging = (description[kIOPSIsChargingKey] as? Bool) ?? false
            return (Double(current) / Double(maximum), charging)
        }
        return nil
    }
}
