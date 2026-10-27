//
//  SystemView.swift
//  Relo Notch
//
//  The System tab: one lead card and aligned rows. The lead is the measure that matters now (the CPU at rest), with
//  its number, a two-minute chart on a fixed scale and a footer that explains it; the other measures are rows of
//  label, bar or sparkline, and value. Grey at rest; when a measure is under pressure it takes the lead in the one
//  attention colour and its title says why in words (SystemAttention). Board G of the notch system stats study.
//

import AppKit
import ReloNotchKit
import SwiftUI

/// The tab's few tones: grey at rest, one colour for attention.
private enum Tone {
    static let attention = ReloNotchTheme.orange
    static let quiet = Color.white.opacity(0.45)
    static let label = Color.white.opacity(0.62)
    static let card = Color.white.opacity(0.055)
    static let line = Color.white.opacity(0.07)
}

struct SystemView: View {
    private let monitor = SystemMonitor.shared

    var body: some View {
        HStack(spacing: 8) {
            Lead(monitor: monitor).frame(width: 344)
            Rows(monitor: monitor)
        }
        .padding(.top, 4)
        .padding(.bottom, 2)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.smooth(duration: 0.5), value: monitor.focus)
        .onAppear { monitor.start() }
        .onDisappear { monitor.stop() }
    }
}

// MARK: Lead

private struct Lead: View {
    let monitor: SystemMonitor

    var body: some View {
        let sample = monitor.sample
        let focus = monitor.focus
        let alert = focus != .atRest
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(SystemAttention.title(focus, for: monitor.focusSeconds))
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                Spacer(minLength: 6)
                if let span { Text(span).font(.system(size: 10.5)).foregroundStyle(Tone.label) }
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(value(sample))
                    .font(.system(size: 30, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(alert ? Tone.attention : .white)
                    .contentTransition(.numericText())
                if let unit = unit(sample) {
                    Text(unit).font(.system(size: 12, design: .rounded).monospacedDigit()).foregroundStyle(Tone.label)
                }
                Spacer(minLength: 6)
                if focus.measure == .cpu, let celsius = sample.temperature { Temperature(celsius: celsius, hot: focus == .hot) }
            }
            if let reason = reason(sample) {
                Text(reason)
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.75))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            footer(sample)
        }
        .padding(EdgeInsets(top: 11, leading: 12, bottom: 10, trailing: 12))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(alert ? Tone.attention.opacity(0.09) : Tone.card))
    }

    @ViewBuilder private func footer(_ sample: SystemMonitor.Sample) -> some View {
        let alert = monitor.focus != .atRest
        switch monitor.focus {
        case .atRest, .cpuBusy, .hot:
            LeadChart(values: monitor.cpuHistory, range: 0...1, alert: alert,
                  dashed: monitor.focus == .hot ? monitor.temperatureHistory : nil, dashedRange: 30...110)
            CoreGroups(sample: sample, alert: alert, hot: monitor.focus == .hot).padding(.top, 6)
        case .memoryTight:
            let peak = max(4_000_000_000, monitor.swapHistory.max() ?? 0)
            LeadChart(values: monitor.swapHistory, range: 0...peak, alert: true)
            MemoryMakeUp(sample: sample).padding(.top, 6)
        case .batteryLow:
            Spacer(minLength: 4)
            Level(value: sample.battery ?? 0)
            Caption(sample.batteryMinutesLeft.map { "About \(hours($0)) left at this rate" } ?? "Working out the time left")
        case .diskFull:
            Spacer(minLength: 4)
            Level(value: sample.storage)
            Caption("\(gigabytes(sample.storageTotal - sample.storageFree, decimal: true)) of \(gigabytes(sample.storageTotal, decimal: true)) GB used")
            Button("Open Storage Settings") {
                if let url = URL(string: "x-apple.systempreferences:com.apple.settings.Storage") { NSWorkspace.shared.open(url) }
            }
            .buttonStyle(.plain)
            .font(.system(size: 11.5, weight: .medium))
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Color.white.opacity(0.14)))
            .padding(.top, 4)
        }
    }

    private var span: String? {
        switch monitor.focus {
        case .atRest, .cpuBusy, .hot: "last 2 min"
        case .memoryTight: "swap, last 2 min"
        case .batteryLow, .diskFull: nil
        }
    }

    private func value(_ sample: SystemMonitor.Sample) -> String {
        switch monitor.focus {
        case .atRest, .cpuBusy, .hot: percent(sample.cpu)
        case .memoryTight: gigabytes(Int64(sample.memoryUsed))
        case .batteryLow: percent(sample.battery ?? 0)
        case .diskFull: gigabytes(sample.storageFree, decimal: true) + " GB"
        }
    }

    private func unit(_ sample: SystemMonitor.Sample) -> String? {
        switch monitor.focus {
        case .memoryTight: "/ \(totalMemoryGB) GB"
        case .diskFull: "free"
        default: nil
        }
    }

    private func reason(_ sample: SystemMonitor.Sample) -> String? {
        switch monitor.focus {
        case .atRest: return nil
        case .cpuBusy: return SystemAttention.busiest(sample.busiest.map { ($0.name, $0.value) })
        case .hot: return "macOS is slowing the cores to cool down."
        case .memoryTight:
            let swap = "Swapping \(gigabytes(Int64(sample.swapUsed))) GB to disk."
            guard let biggest = sample.biggest else { return swap }
            return swap + " \(biggest.name) uses the most (\(gigabytes(Int64(biggest.value))) GB)."
        case .batteryLow:
            guard let app = sample.busiest.first, app.value >= 0.05 else { return nil }
            return "\(app.name) is the busiest app."
        case .diskFull: return "Builds and updates can fail below 10 GB."
        }
    }

    private func hours(_ minutes: Int) -> String {
        minutes < 60 ? "\(minutes) min" : "\(minutes / 60) h \(minutes % 60) min"
    }
}

/// The CPU's temperature beside its number: plain at rest, a chip when it is the reason.
private struct Temperature: View {
    let celsius: Double
    let hot: Bool

    var body: some View {
        Text("\(Int(celsius.rounded())) °C")
            .font(.system(size: hot ? 12 : 14, weight: .semibold, design: .rounded).monospacedDigit())
            .foregroundStyle(hot ? .black : .white)
            .padding(.horizontal, hot ? 6 : 0)
            .padding(.vertical, hot ? 1 : 0)
            .background { if hot { RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Tone.attention) } }
            .contentTransition(.numericText())
    }
}

/// Two minutes on a fixed scale, newest at the right, so low load reads as low; an optional dashed second line
/// (the temperature while hot) on its own scale.
private struct LeadChart: View {
    let values: [Double]
    let range: ClosedRange<Double>
    let alert: Bool
    var dashed: [Double]?
    var dashedRange: ClosedRange<Double> = 0...1

    var body: some View {
        Canvas { context, size in
            for y in [0.5, size.height / 2] {
                context.fill(Path(CGRect(x: 0, y: y, width: size.width, height: 1)), with: .color(Tone.line))
            }
            context.fill(Path(CGRect(x: 0, y: size.height - 1, width: size.width, height: 1)), with: .color(Color.white.opacity(0.14)))
            let line = path(values, range, size)
            var area = line
            area.addLine(to: CGPoint(x: size.width, y: size.height))
            area.addLine(to: CGPoint(x: start(values.count, size), y: size.height))
            area.closeSubpath()
            context.fill(area, with: .color(alert ? Tone.attention.opacity(0.18) : Color.white.opacity(0.08)))
            context.stroke(line, with: .color(alert ? Tone.attention : Color.white.opacity(0.5)),
                           style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
            if let dashed {
                context.stroke(path(dashed, dashedRange, size), with: .color(Color.white.opacity(0.7)),
                               style: StrokeStyle(lineWidth: 1.2, dash: [3, 3]))
            }
        }
        .frame(minHeight: 28, maxHeight: .infinity)
    }

    private func start(_ count: Int, _ size: CGSize) -> CGFloat {
        size.width - size.width / 59 * CGFloat(max(0, count - 1))
    }

    private func path(_ values: [Double], _ range: ClosedRange<Double>, _ size: CGSize) -> Path {
        var path = Path()
        let step = size.width / 59
        let left = start(values.count, size)
        let span = max(range.upperBound - range.lowerBound, .ulpOfOne)
        for (index, value) in values.enumerated() {
            let share = min(1, max(0, (value - range.lowerBound) / span))
            let point = CGPoint(x: left + step * CGFloat(index), y: size.height - 1 - (size.height - 2) * CGFloat(share))
            index == 0 ? path.move(to: point) : path.addLine(to: point)
        }
        return path
    }
}

/// The cores as two groups, performance then efficiency, each named with its clock speed. While hot, the
/// performance speed reads against its top ("3.9 of 4.5 GHz") to show the slowdown.
private struct CoreGroups: View {
    let sample: SystemMonitor.Sample
    let alert: Bool
    let hot: Bool

    var body: some View {
        let split = min(SystemSensors.efficiencyCores, sample.cores.count)
        let efficiency = Array(sample.cores.prefix(split))
        let performance = Array(sample.cores.dropFirst(split))
        let total = CGFloat(max(1, sample.cores.count))
        GeometryReader { geo in
            let room = geo.size.width - (efficiency.isEmpty ? 0 : 10)
            HStack(alignment: .top, spacing: 10) {
                group(performance, efficiency.isEmpty ? "Cores" : "Performance", clock: performanceClock)
                    .frame(width: room * CGFloat(performance.count) / total)
                if !efficiency.isEmpty {
                    group(efficiency, "Efficiency", clock: sample.clocks?.efficiency.map { Text(ghz($0) + " GHz").foregroundStyle(.white) })
                        .frame(width: room * CGFloat(efficiency.count) / total)
                }
            }
        }
        .frame(height: 25)
        .animation(.smooth(duration: 0.8), value: sample.cores)
    }

    private var performanceClock: Text? {
        guard let speed = sample.clocks?.performance else { return nil }
        if hot, let top = sample.clocks?.performanceMax {
            return Text(ghz(speed)).foregroundStyle(Tone.attention) + Text(" of \(ghz(top)) GHz").foregroundStyle(Tone.label)
        }
        return Text(ghz(speed) + " GHz").foregroundStyle(.white)
    }

    private func group(_ loads: [Double], _ name: String, clock: Text?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 3) {
                ForEach(Array(loads.enumerated()), id: \.offset) { _, load in
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill((alert ? Tone.attention : Color.white).opacity(0.12 + 0.88 * min(1, max(0, load))))
                        .frame(height: 10)
                }
            }
            (Text(name).foregroundStyle(Tone.label) + (clock.map { Text(" · ").foregroundStyle(Tone.label) + $0.fontWeight(.semibold) } ?? Text("")))
                .font(.system(size: 9.5).monospacedDigit())
                .lineLimit(1)
        }
    }

    private func ghz(_ value: Double) -> String { String(format: "%.1f", value) }
}

/// What fills memory: apps, wired, compressed (the part that grows under pressure), then free.
private struct MemoryMakeUp: View {
    let sample: SystemMonitor.Sample

    var body: some View {
        let total = Double(max(1, sample.memoryTotal))
        let wired = Double(sample.memoryWired), compressed = Double(sample.memoryCompressed)
        let apps = max(0, Double(sample.memoryUsed) - wired - compressed)
        VStack(alignment: .leading, spacing: 4) {
            GeometryReader { geo in
                let room = geo.size.width - 6
                HStack(spacing: 2) {
                    Rectangle().fill(Color.white.opacity(0.72)).frame(width: room * apps / total)
                    Rectangle().fill(Color.white.opacity(0.4)).frame(width: room * wired / total)
                    Rectangle().fill(Tone.attention).frame(width: room * compressed / total)
                    Rectangle().fill(Color.white.opacity(0.08))
                }
                .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
            }
            .frame(height: 10)
            (Text("Apps ").foregroundStyle(Tone.label) + Text(gigabytes(Int64(apps))).fontWeight(.semibold)
             + Text(" · Wired ").foregroundStyle(Tone.label) + Text(gigabytes(Int64(wired))).fontWeight(.semibold)
             + Text(" · Compressed ").foregroundStyle(Tone.label) + Text(gigabytes(Int64(compressed)) + " GB").fontWeight(.semibold).foregroundStyle(Tone.attention))
                .font(.system(size: 9.5).monospacedDigit())
                .lineLimit(1)
        }
    }
}

/// A thick bar in the attention colour, for the battery or the disk.
private struct Level: View {
    let value: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3, style: .continuous).fill(Color.white.opacity(0.08))
                RoundedRectangle(cornerRadius: 3, style: .continuous).fill(Tone.attention)
                    .frame(width: geo.size.width * min(1, max(0.01, value)))
            }
        }
        .frame(height: 10)
    }
}

private struct Caption: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text).font(.system(size: 9.5).monospacedDigit()).foregroundStyle(Tone.label).lineLimit(1).padding(.top, 2)
    }
}

// MARK: Rows

/// Every measure that is not leading, as one aligned row each; a measure under pressure marks its value.
private struct Rows: View {
    let monitor: SystemMonitor

    private enum Middle { case bar(Double), line([Double], ClosedRange<Double>) }
    private struct Row: Identifiable {
        let id: String
        let middle: Middle
        let value: String
        let unit: String
        let marked: Bool
    }

    var body: some View {
        let rows = self.rows
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                if index > 0 { Rectangle().fill(Tone.line).frame(height: 1) }
                HStack(spacing: 8) {
                    Text(row.id).font(.system(size: 11)).foregroundStyle(Tone.label).frame(width: 50, alignment: .leading)
                    middle(row)
                    (Text(row.value).foregroundStyle(row.marked ? Tone.attention : .white).fontWeight(row.marked ? .semibold : .regular)
                     + Text(row.unit.isEmpty ? "" : " " + row.unit).foregroundStyle(Tone.label))
                        .font(.system(size: 12, design: .rounded).monospacedDigit())
                        .lineLimit(1)
                        .contentTransition(.numericText())
                        .frame(width: 100, alignment: .trailing)
                }
                .frame(maxHeight: 36)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Tone.card))
    }

    @ViewBuilder private func middle(_ row: Row) -> some View {
        let color = row.marked ? Tone.attention : Tone.quiet
        switch row.middle {
        case .bar(let value):
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.08))
                    Capsule().fill(color).frame(width: geo.size.width * min(1, max(0, value)))
                }
            }
            .frame(height: 4)
        case .line(let values, let range):
            Sparkline(values: values, range: range, color: color).frame(height: 16)
        }
    }

    private var rows: [Row] {
        let sample = monitor.sample
        let lead = monitor.focus.measure
        let marked = monitor.marked
        var rows: [Row] = []
        if lead != .cpu {
            rows.append(Row(id: "CPU", middle: .line(monitor.cpuHistory, 0...1), value: percent(sample.cpu),
                            unit: sample.temperature.map { "\(Int($0.rounded())) °C" } ?? "", marked: marked.contains(.cpu)))
        }
        if lead != .memory {
            rows.append(Row(id: "Memory", middle: .bar(sample.memory), value: gigabytes(Int64(sample.memoryUsed)),
                            unit: "/ \(totalMemoryGB) GB", marked: marked.contains(.memory)))
        }
        if lead != .disk {
            rows.append(Row(id: "Disk", middle: .bar(sample.storage), value: gigabytes(sample.storageFree, decimal: true) + " GB",
                            unit: "free", marked: marked.contains(.disk)))
        }
        // Network on a square-root scale up to its own peak (at least 64 KB/s), so a small burst is not an alarm.
        let peak = max(64_000, monitor.networkHistory.max() ?? 0).squareRoot()
        let rate = Self.rate(down: sample.downBytesPerSecond, up: sample.upBytesPerSecond)
        rows.append(Row(id: "Network", middle: .line(monitor.networkHistory.map { $0.squareRoot() }, 0...peak),
                        value: rate.value, unit: rate.unit, marked: false))
        if lead != .battery, let level = sample.battery {
            rows.append(Row(id: "Battery", middle: .bar(level), value: percent(level),
                            unit: sample.charging ? "charging" : sample.onBattery ? "on battery" : "on power", marked: marked.contains(.battery)))
        }
        return rows
    }

    /// "↓31 ↑116" in the unit the larger one needs.
    private static func rate(down: Double, up: Double) -> (value: String, unit: String) {
        let mega = max(down, up) >= 1_000_000
        let scale = mega ? 1_000_000.0 : 1000.0
        func amount(_ value: Double) -> String {
            let scaled = value / scale
            return scaled < 10 && mega ? String(format: "%.1f", scaled) : "\(Int(scaled.rounded()))"
        }
        return ("↓\(amount(down)) ↑\(amount(up))", mega ? "MB/s" : "KB/s")
    }
}

private struct Sparkline: View {
    let values: [Double]
    let range: ClosedRange<Double>
    let color: Color

    var body: some View {
        Canvas { context, size in
            guard values.count > 1 else { return }
            let step = size.width / CGFloat(values.count - 1)
            let span = max(range.upperBound - range.lowerBound, .ulpOfOne)
            var line = Path()
            for (index, value) in values.enumerated() {
                let share = min(1, max(0, (value - range.lowerBound) / span))
                let point = CGPoint(x: step * CGFloat(index), y: size.height - 1 - (size.height - 2) * CGFloat(share))
                index == 0 ? line.move(to: point) : line.addLine(to: point)
            }
            context.stroke(line, with: .color(color), style: StrokeStyle(lineWidth: 1.2, lineCap: .round, lineJoin: .round))
        }
    }
}

// MARK: Formatting

private func percent(_ value: Double) -> String { "\(Int((value * 100).rounded()))%" }

/// Gigabytes without the unit. Memory counts in binary gigabytes with one decimal ("17.2"), as Activity Monitor does;
/// disks in decimal ones, whole from 10 ("78", "6.2"), as Finder does.
private func gigabytes(_ bytes: Int64, decimal: Bool = false) -> String {
    let value = Double(max(0, bytes)) / (decimal ? 1_000_000_000 : 1_073_741_824)
    return value < (decimal ? 10 : 100) ? String(format: "%.1f", value) : "\(Int(value.rounded()))"
}

/// The Mac's memory in whole binary gigabytes ("24").
private let totalMemoryGB = Int((Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824).rounded())
